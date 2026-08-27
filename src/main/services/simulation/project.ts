import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  SpiderKitSimManifestV1,
  SimulationBuildResult,
  SimulationCatalog,
  SimulationOpModeInfo,
  SimulationPlatform,
  SimulationPluginInfo,
  SimulationProject,
  SimulationScenarioInfo
} from '../../../shared/types/simulation'
import {
  SPIDER_KIT_SIM_MANIFEST,
  SPIDER_KIT_SIM_PROTOCOL,
  SPIDER_KIT_SIM_PROTOCOL_VERSION
} from '../../../shared/types/simulation'
import { SimulationProjectError } from './errors'
import {
  createJavaEnvironment,
  discoverJavaRuntime,
  type JavaRuntime
} from './javaRuntime'

export { SimulationProjectError } from './errors'

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 120_000

export interface SimulationBuildHooks {
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void
}

export function simulationPlatform(platform: NodeJS.Platform = process.platform): SimulationPlatform {
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  throw new SimulationProjectError(
    'UNSUPPORTED_PLATFORM',
    `SpiderKit simulation projects do not yet support ${platform}`
  )
}

/**
 * Read a robot project's top-level integration manifest. The selected command
 * launches a robot-local distribution, while its CLI implementation is supplied
 * by SpiderKit and robot code contributes only plugins/models.
 */
export function discoverSimulationProject(
  projectDirectory: string,
  platform: SimulationPlatform = simulationPlatform()
): SimulationProject {
  const root = requireDirectory(projectDirectory, 'project directory')
  const manifestPath = join(root, SPIDER_KIT_SIM_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new SimulationProjectError(
      'MANIFEST_NOT_FOUND',
      `${SPIDER_KIT_SIM_MANIFEST} was not found at the top level of ${root}`
    )
  }
  if (!statSync(manifestPath).isFile() || statSync(manifestPath).size > MAX_MANIFEST_BYTES) {
    throw new SimulationProjectError('INVALID_MANIFEST', `${SPIDER_KIT_SIM_MANIFEST} is not a small file`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new SimulationProjectError(
      'INVALID_MANIFEST',
      `${SPIDER_KIT_SIM_MANIFEST} is not valid JSON: ${messageOf(error)}`
    )
  }
  const manifest = validateManifest(parsed)
  const workingDirectory = resolveDirectoryInside(
    root,
    manifest.workingDirectory ?? '.',
    'workingDirectory'
  )
  const launchCommand = manifest.launchCommand[platform]
  validateProjectCommand(root, launchCommand, 'launchCommand', platform)
  const buildCommand = manifest.buildCommand?.[platform]
  if (buildCommand) validateProjectCommand(root, buildCommand, 'buildCommand', platform)

  return {
    projectDirectory: root,
    manifestPath,
    manifest,
    platform,
    workingDirectory,
    launchCommand: [...launchCommand],
    buildAvailable: Boolean(buildCommand)
  }
}

export async function buildSimulationProject(
  projectDirectory: string,
  platform: SimulationPlatform = simulationPlatform(),
  hooks: SimulationBuildHooks = {}
): Promise<Omit<SimulationBuildResult, 'catalog'>> {
  const project = discoverSimulationProject(projectDirectory, platform)
  const command = project.manifest.buildCommand?.[platform]
  if (!command) {
    throw new SimulationProjectError(
      'BUILD_UNAVAILABLE',
      `${project.manifest.name} has no ${platform} build command`
    )
  }
  const result = await runCaptured(
    project.projectDirectory,
    command,
    project.workingDirectory,
    platform,
    COMMAND_TIMEOUT_MS,
    hooks
  )
  if (result.exitCode !== 0) {
    throw new SimulationProjectError(
      'BUILD_FAILED',
      `${project.manifest.name} build exited with code ${result.exitCode}: ${lastUsefulLine(result.stderr)}`
    )
  }
  return { ...result, project: discoverSimulationProject(projectDirectory, platform) }
}

export async function listSimulationCatalog(
  projectDirectory: string,
  platform: SimulationPlatform = simulationPlatform()
): Promise<SimulationCatalog> {
  const project = discoverSimulationProject(projectDirectory, platform)
  const result = await runCaptured(
    project.projectDirectory,
    [...project.launchCommand, 'list-opmodes', '--json'],
    project.workingDirectory,
    platform,
    15_000
  )
  if (result.exitCode !== 0) {
    throw new SimulationProjectError(
      'LIST_OPMODES_FAILED',
      `SpiderKit Sim list-opmodes exited with code ${result.exitCode}: ${lastUsefulLine(result.stderr)}`
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(result.stdout.trim())
  } catch {
    throw new SimulationProjectError('INVALID_CATALOG', 'SpiderKit Sim list-opmodes did not return JSON')
  }
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    payload.protocol !== SPIDER_KIT_SIM_PROTOCOL ||
    payload.protocolVersion !== SPIDER_KIT_SIM_PROTOCOL_VERSION
  ) {
    throw new SimulationProjectError('INVALID_CATALOG', 'SpiderKit Sim returned an incompatible catalog')
  }
  if (!Array.isArray(payload.plugins) || !Array.isArray(payload.opModes) || !Array.isArray(payload.scenarios)) {
    throw new SimulationProjectError(
      'INVALID_CATALOG',
      'SpiderKit Sim catalog must contain plugins, opModes, and scenarios arrays'
    )
  }
  return {
    plugins: payload.plugins.map(validatePlugin),
    opModes: payload.opModes.map(validateOpMode),
    scenarios: payload.scenarios.map(validateScenario)
  }
}

export interface ExactSpawnCommand {
  executable: string
  args: string[]
}

/** Resolve argv[0] without interpreting any shell syntax. */
export function resolveCommand(
  projectDirectory: string,
  command: string[],
  platform: SimulationPlatform = simulationPlatform(),
  javaRuntime?: JavaRuntime
): ExactSpawnCommand {
  if (!command.length) throw new SimulationProjectError('INVALID_COMMAND', 'Command cannot be empty')
  const first = command[0]
  if (platform === 'windows' && /\.(?:bat|cmd)$/i.test(first)) {
    throw new SimulationProjectError(
      'UNSUPPORTED_EXECUTABLE',
      'Windows batch wrappers are not supported; use an exact direct command such as java.exe'
    )
  }
  if (platform === 'windows' && isJavaExecutable(first)) {
    const runtime = javaRuntime ?? discoverJavaRuntime(projectDirectory)
    return { executable: runtime.javaExecutable, args: command.slice(1) }
  }
  const projectCandidate = isBareExecutable(first) ? join(projectDirectory, first) : null
  let executable: string
  if (projectCandidate && existsSync(projectCandidate)) {
    executable = requireFileInside(projectDirectory, projectCandidate, 'command executable')
  } else if (isBareExecutable(first)) {
    executable = first
  } else {
    executable = requireFileInside(
      projectDirectory,
      resolveLexicallyInside(projectDirectory, first, 'command executable'),
      'command executable'
    )
  }

  return { executable, args: command.slice(1) }
}

export function spawnCommand(
  projectDirectory: string,
  command: string[],
  cwd: string,
  platform: SimulationPlatform = simulationPlatform()
): ChildProcessWithoutNullStreams {
  const runtime = platform === 'windows' && isJavaExecutable(command[0])
    ? discoverJavaRuntime(projectDirectory)
    : undefined
  const exact = resolveCommand(projectDirectory, command, platform, runtime)
  return spawn(exact.executable, exact.args, {
    cwd,
    env: runtime ? createJavaEnvironment(runtime) : { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true
  })
}

function validateManifest(value: unknown): SpiderKitSimManifestV1 {
  if (!isRecord(value)) invalidManifest('must be a JSON object')
  if (value.schemaVersion !== 1) invalidManifest('schemaVersion must be 1')
  if (value.protocolVersion !== SPIDER_KIT_SIM_PROTOCOL_VERSION) {
    invalidManifest(`protocolVersion must be ${SPIDER_KIT_SIM_PROTOCOL_VERSION}`)
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) {
    invalidManifest('name must be a non-empty string of at most 120 characters')
  }
  if (value.workingDirectory !== undefined && typeof value.workingDirectory !== 'string') {
    invalidManifest('workingDirectory must be a project-relative string')
  }
  validatePlatformCommands(value.launchCommand, 'launchCommand', true)
  if (value.buildCommand !== undefined) validatePlatformCommands(value.buildCommand, 'buildCommand', false)
  return value as unknown as SpiderKitSimManifestV1
}

function validatePlatformCommands(value: unknown, name: string, requireBoth: boolean): void {
  if (!isRecord(value)) invalidManifest(`${name} must be an object keyed by platform`)
  for (const key of Object.keys(value)) {
    if (key !== 'linux' && key !== 'windows') invalidManifest(`${name}.${key} is not a supported platform`)
  }
  if (requireBoth && (value.linux === undefined || value.windows === undefined)) {
    invalidManifest(`${name} must define linux and windows argv`)
  }
  for (const platform of ['linux', 'windows'] as const) {
    if (value[platform] !== undefined) validateArgv(value[platform], `${name}.${platform}`)
  }
}

function validateArgv(value: unknown, name: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    value.some(
      (part) => typeof part !== 'string' || !part || part.length > 16_384 || /[\0\r\n]/.test(part)
    )
  ) {
    invalidManifest(`${name} must be a non-empty argv string array`)
  }
}

function validateProjectCommand(
  root: string,
  command: string[],
  name: string,
  platform: SimulationPlatform
): void {
  const executable = command[0]
  if (platform === 'windows' && /\.(?:bat|cmd)$/i.test(executable)) {
    throw new SimulationProjectError(
      'UNSUPPORTED_EXECUTABLE',
      `${name} cannot use a Windows batch wrapper; use an exact direct command such as java.exe`
    )
  }
  if (isBareExecutable(executable)) return
  try {
    resolveLexicallyInside(root, executable, name)
  } catch (error) {
    throw new SimulationProjectError(
      error instanceof SimulationProjectError ? error.code : 'INVALID_COMMAND',
      `${name} is invalid: ${messageOf(error)}`
    )
  }
}

function validatePlugin(value: unknown, index: number): SimulationPluginInfo {
  if (!isRecord(value)) invalidCatalog(`plugins[${index}] is invalid`)
  return {
    id: catalogText(value.id, `plugins[${index}].id`),
    name: catalogText(value.name, `plugins[${index}].name`)
  }
}

function validateOpMode(value: unknown, index: number): SimulationOpModeInfo {
  if (!isRecord(value)) invalidCatalog(`opModes[${index}] is invalid`)
  return {
    id: catalogText(value.id, `opModes[${index}].id`),
    name: catalogText(value.name, `opModes[${index}].name`),
    group: catalogText(value.group, `opModes[${index}].group`, true),
    type: catalogText(value.type, `opModes[${index}].type`),
    pluginId: catalogText(value.pluginId, `opModes[${index}].pluginId`)
  }
}

function validateScenario(value: unknown, index: number): SimulationScenarioInfo {
  if (!isRecord(value)) invalidCatalog(`scenarios[${index}] is invalid`)
  return {
    id: catalogText(value.id, `scenarios[${index}].id`),
    name: catalogText(value.name, `scenarios[${index}].name`),
    description: catalogText(value.description, `scenarios[${index}].description`, true),
    pluginId: catalogText(value.pluginId, `scenarios[${index}].pluginId`)
  }
}

function catalogText(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > 4096) {
    invalidCatalog(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string`)
  }
  return value
}

function invalidCatalog(message: string): never {
  throw new SimulationProjectError('INVALID_CATALOG', message)
}

function invalidManifest(message: string): never {
  throw new SimulationProjectError('INVALID_MANIFEST', `${SPIDER_KIT_SIM_MANIFEST} ${message}`)
}

function resolveLexicallyInside(root: string, child: string, label: string): string {
  if (!child || child.includes('\0') || isAbsolute(child)) {
    throw new SimulationProjectError('PATH_OUTSIDE_PROJECT', `${label} must be a project-relative path`)
  }
  const resolved = resolve(root, child)
  assertInside(root, resolved, label)
  return resolved
}

function resolveDirectoryInside(root: string, child: string, label: string): string {
  const lexical = resolveLexicallyInside(root, child, label)
  const directory = requireDirectory(lexical, label)
  assertInside(realpathSync(root), directory, label)
  return directory
}

function requireFileInside(root: string, path: string, label: string): string {
  let stats
  try {
    stats = statSync(path)
  } catch {
    throw new SimulationProjectError('EXECUTABLE_NOT_FOUND', `${label} does not exist: ${path}`)
  }
  if (!stats.isFile()) throw new SimulationProjectError('INVALID_EXECUTABLE', `${label} is not a file`)
  const realPath = realpathSync(path)
  assertInside(realpathSync(root), realPath, label)
  return realPath
}

function requireDirectory(path: string, label: string): string {
  const resolved = resolve(path)
  try {
    if (!statSync(resolved).isDirectory()) throw new Error('not a directory')
    return realpathSync(resolved)
  } catch {
    throw new SimulationProjectError('DIRECTORY_NOT_FOUND', `${label} does not exist: ${resolved}`)
  }
}

function assertInside(root: string, child: string, label: string): void {
  const rel = relative(root, child)
  if (rel === '..' || rel.startsWith(`..${rel.includes('\\') ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new SimulationProjectError('PATH_OUTSIDE_PROJECT', `${label} resolves outside the project`)
  }
}

async function runCaptured(
  projectDirectory: string,
  command: string[],
  cwd: string,
  platform: SimulationPlatform,
  timeoutMs = COMMAND_TIMEOUT_MS,
  hooks: SimulationBuildHooks = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawnCommand(projectDirectory, command, cwd, platform)
  let stdout = ''
  let stderr = ''
  const lineBuffers = { stdout: '', stderr: '' }
  let settled = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  return new Promise((resolveResult, reject) => {
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdin.end()
      child.kill()
      reject(error)
    }
    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (settled) return
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
      lineBuffers[target] += chunk
      let newline: number
      while ((newline = lineBuffers[target].indexOf('\n')) >= 0) {
        const line = lineBuffers[target].slice(0, newline).replace(/\r$/, '')
        lineBuffers[target] = lineBuffers[target].slice(newline + 1)
        if (line.trim()) hooks.onOutput?.(target, line)
      }
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT_BYTES) {
        rejectOnce(
          new SimulationProjectError('COMMAND_OUTPUT_TOO_LARGE', 'Command output exceeded 2 MiB')
        )
      }
    }
    child.stdout.on('data', (chunk: string) => append('stdout', chunk))
    child.stderr.on('data', (chunk: string) => append('stderr', chunk))
    const timeout = setTimeout(
      () => rejectOnce(new SimulationProjectError('COMMAND_TIMEOUT', `Command timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new SimulationProjectError('COMMAND_SPAWN_FAILED', messageOf(error)))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      for (const target of ['stdout', 'stderr'] as const) {
        const line = lineBuffers[target].replace(/\r$/, '')
        if (line.trim()) hooks.onOutput?.(target, line)
      }
      resolveResult({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

function isBareExecutable(value: string): boolean {
  return /^[A-Za-z0-9_.+-]+$/.test(value) && !value.includes('/') && !value.includes('\\')
}

function isJavaExecutable(value: string): boolean {
  return /^(?:java|java\.exe)$/i.test(value)
}

function lastUsefulLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? 'no error output'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

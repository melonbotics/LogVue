import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, win32 } from 'node:path'
import { SimulationProjectError } from './errors'

const MINIMUM_JAVA_MAJOR_VERSION = 17
const JAVA_VERSION_TIMEOUT_MS = 10_000

export interface JavaRuntime {
  home: string
  javaExecutable: string
  javacExecutable: string
  majorVersion: number
}

export interface JavaRuntimeDiscoveryOptions {
  environment?: NodeJS.ProcessEnv
  isFile?: (path: string) => boolean
  inspectVersion?: (javaExecutable: string, javaHome: string) => number | null
  standardHomes?: string[]
}

/** Find a complete Windows JDK suitable for Gradle without changing the parent process. */
export function discoverJavaRuntime(
  projectDirectory: string,
  options: JavaRuntimeDiscoveryOptions = {}
): JavaRuntime {
  const environment = options.environment ?? process.env
  const isFile = options.isFile ?? isRegularFile
  const inspectVersion =
    options.inspectVersion ??
    ((javaExecutable, javaHome) => inspectJavaMajorVersion(javaExecutable, javaHome, environment))

  const candidates = [
    readGradleJavaHome(projectDirectory),
    ...environmentValues(environment, 'JAVA_HOME'),
    ...environmentValues(environment, 'STUDIO_JDK'),
    ...(options.standardHomes ?? standardAndroidStudioHomes(environment)),
    ...javaHomesFromPath(environment)
  ]
  const visited = new Set<string>()

  for (const candidate of candidates) {
    if (!candidate) continue
    const home = normalizeWindowsPath(candidate)
    if (!win32.isAbsolute(home)) continue
    const identity = home.toLowerCase()
    if (visited.has(identity)) continue
    visited.add(identity)

    const javaExecutable = win32.join(home, 'bin', 'java.exe')
    const javacExecutable = win32.join(home, 'bin', 'javac.exe')
    if (!isFile(javaExecutable) || !isFile(javacExecutable)) continue
    const majorVersion = inspectVersion(javaExecutable, home)
    if (majorVersion === null || majorVersion < MINIMUM_JAVA_MAJOR_VERSION) continue
    return { home, javaExecutable, javacExecutable, majorVersion }
  }

  throw new SimulationProjectError(
    'JAVA_NOT_FOUND',
    'Java 17 or newer was not found. Open this robot project in Android Studio once so LogVue can discover its project JDK.'
  )
}

/** Decode java.home from the Gradle properties file written by Android Studio. */
export function readGradleJavaHome(projectDirectory: string): string | null {
  try {
    const contents = readFileSync(join(projectDirectory, '.gradle', 'config.properties'), 'utf8')
    return readJavaHomeProperty(contents)
  } catch {
    return null
  }
}

export function readJavaHomeProperty(contents: string): string | null {
  for (const line of logicalPropertyLines(contents)) {
    let index = 0
    while (index < line.length && /\s/.test(line[index])) index += 1
    if (index === line.length || line[index] === '#' || line[index] === '!') continue

    const keyStart = index
    let escaped = false
    while (index < line.length) {
      const character = line[index]
      if (!escaped && (character === '=' || character === ':' || /\s/.test(character))) break
      if (character === '\\' && !escaped) escaped = true
      else escaped = false
      index += 1
    }
    const key = decodeJavaProperty(line.slice(keyStart, index))
    while (index < line.length && /\s/.test(line[index])) index += 1
    if (line[index] === '=' || line[index] === ':') index += 1
    while (index < line.length && /\s/.test(line[index])) index += 1
    if (key === 'java.home') return decodeJavaProperty(line.slice(index))
  }
  return null
}

export function createJavaEnvironment(
  runtime: Pick<JavaRuntime, 'home'>,
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  const existingPath = environmentValues(baseEnvironment, 'PATH').filter(Boolean).join(';')
  for (const [key, value] of Object.entries(baseEnvironment)) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey === 'path' || normalizedKey === 'java_home') continue
    environment[key] = value
  }
  environment.JAVA_HOME = runtime.home
  environment.Path = existingPath
    ? `${win32.join(runtime.home, 'bin')};${existingPath}`
    : win32.join(runtime.home, 'bin')
  return environment
}

export function parseJavaMajorVersion(output: string): number | null {
  const match = output.match(/(?:java|openjdk) version\s+"?([^"\s]+)"?/i)
  if (!match) return null
  const components = match[1].split(/[._+-]/)
  const first = Number.parseInt(components[0], 10)
  if (!Number.isFinite(first)) return null
  if (first === 1) {
    const legacy = Number.parseInt(components[1] ?? '', 10)
    return Number.isFinite(legacy) ? legacy : null
  }
  return first
}

function inspectJavaMajorVersion(
  javaExecutable: string,
  javaHome: string,
  environment: NodeJS.ProcessEnv
): number | null {
  const result = spawnSync(javaExecutable, ['-version'], {
    encoding: 'utf8',
    env: createJavaEnvironment({ home: javaHome }, environment),
    shell: false,
    timeout: JAVA_VERSION_TIMEOUT_MS,
    windowsHide: true
  })
  if (result.error || result.status !== 0) return null
  return parseJavaMajorVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

function standardAndroidStudioHomes(environment: NodeJS.ProcessEnv): string[] {
  const homes: string[] = []
  for (const rootName of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    for (const root of environmentValues(environment, rootName)) {
      homes.push(win32.join(root, 'Android', 'Android Studio', 'jbr'))
    }
  }
  for (const root of environmentValues(environment, 'LOCALAPPDATA')) {
    homes.push(win32.join(root, 'Programs', 'Android Studio', 'jbr'))
  }
  homes.push('C:\\Program Files\\Android\\Android Studio\\jbr')
  return homes
}

function javaHomesFromPath(environment: NodeJS.ProcessEnv): string[] {
  const homes: string[] = []
  for (const value of environmentValues(environment, 'PATH')) {
    for (const entry of value.split(';')) {
      const bin = normalizeWindowsPath(entry)
      if (!bin || win32.basename(bin).toLowerCase() !== 'bin') continue
      homes.push(win32.dirname(bin))
    }
  }
  return homes
}

function environmentValues(environment: NodeJS.ProcessEnv, name: string): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === 'string')
    .map(([, value]) => value as string)
}

function normalizeWindowsPath(value: string): string {
  let path = value.trim()
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  return path ? win32.normalize(path) : ''
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function logicalPropertyLines(contents: string): string[] {
  const physicalLines = contents.split(/\r?\n/)
  const logicalLines: string[] = []
  let current = ''
  for (const physicalLine of physicalLines) {
    const line = current ? physicalLine.replace(/^\s+/, '') : physicalLine
    current += line
    let slashCount = 0
    for (let index = current.length - 1; index >= 0 && current[index] === '\\'; index -= 1) {
      slashCount += 1
    }
    if (slashCount % 2 === 1) {
      current = current.slice(0, -1)
      continue
    }
    logicalLines.push(current)
    current = ''
  }
  if (current) logicalLines.push(current)
  return logicalLines
}

function decodeJavaProperty(value: string): string {
  let decoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character !== '\\') {
      decoded += character
      continue
    }
    index += 1
    if (index >= value.length) {
      decoded += '\\'
      break
    }
    const escaped = value[index]
    if (escaped === 't') decoded += '\t'
    else if (escaped === 'n') decoded += '\n'
    else if (escaped === 'r') decoded += '\r'
    else if (escaped === 'f') decoded += '\f'
    else if (escaped === 'u') {
      const hex = value.slice(index + 1, index + 5)
      if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('Invalid Java property Unicode escape')
      decoded += String.fromCharCode(Number.parseInt(hex, 16))
      index += 4
    } else decoded += escaped
  }
  return decoded
}

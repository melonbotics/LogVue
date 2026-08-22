import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverSimulationProject,
  listSimulationCatalog,
  resolveCommand,
  SimulationProjectError
} from '../src/main/services/simulation/project'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function project(manifestPatch: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'logvue-sim-project-'))
  temporaryDirectories.push(root)
  writeFileSync(
    join(root, 'spiderkit-sim.json'),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      name: 'Test robot',
      workingDirectory: '.',
      launchCommand: {
        linux: ['dist/bin/robot-sim'],
        windows: ['java.exe', '-cp', 'dist/lib/*', 'org.barkerredbacks.spiderkit.sim.cli.SpiderKitSimMain']
      },
      buildCommand: {
        linux: ['./gradlew', ':RobotSim:installDist'],
        windows: [
          'java.exe',
          '-classpath',
          'gradle/wrapper/gradle-wrapper.jar',
          'org.gradle.wrapper.GradleWrapperMain',
          '-p',
          'desktop',
          ':RobotSim:installDist'
        ]
      },
      ...manifestPatch
    })
  )
  return root
}

describe('SpiderKit simulation project manifest', () => {
  it('selects exact argv for the current requested platform', () => {
    const root = project()
    const linux = discoverSimulationProject(root, 'linux')
    const windows = discoverSimulationProject(root, 'windows')

    expect(linux.launchCommand).toEqual(['dist/bin/robot-sim'])
    expect(linux.buildAvailable).toBe(true)
    expect(windows.launchCommand).toEqual([
      'java.exe',
      '-cp',
      'dist/lib/*',
      'org.barkerredbacks.spiderkit.sim.cli.SpiderKitSimMain'
    ])
    expect(windows.manifest.buildCommand?.windows).toEqual([
      'java.exe',
      '-classpath',
      'gradle/wrapper/gradle-wrapper.jar',
      'org.gradle.wrapper.GradleWrapperMain',
      '-p',
      'desktop',
      ':RobotSim:installDist'
    ])
    expect(windows.buildAvailable).toBe(true)
  })

  it('rejects a working directory that escapes through a symlink', () => {
    const root = project({ workingDirectory: 'linked-outside' })
    const outside = mkdtempSync(join(tmpdir(), 'logvue-sim-outside-'))
    temporaryDirectories.push(outside)
    symlinkSync(outside, join(root, 'linked-outside'), 'dir')

    expect(() => discoverSimulationProject(root, 'linux')).toThrowError(
      expect.objectContaining<Partial<SimulationProjectError>>({ code: 'PATH_OUTSIDE_PROJECT' })
    )
  })

  it('rejects Windows batch wrappers instead of passing dynamic arguments through cmd.exe', () => {
    const root = project()
    expect(() => resolveCommand(root, ['dist/bin/robot-sim.bat', '--version'], 'windows')).toThrowError(
      expect.objectContaining<Partial<SimulationProjectError>>({ code: 'UNSUPPORTED_EXECUTABLE' })
    )
  })

  it('rejects launch executables which resolve outside the project', () => {
    const root = project()
    expect(() => resolveCommand(root, ['../outside'], 'linux')).toThrowError(
      expect.objectContaining<Partial<SimulationProjectError>>({ code: 'PATH_OUTSIDE_PROJECT' })
    )
  })
})

it.skipIf(!process.env.LOGVUE_SPIDERKIT_PROJECT)(
  'discovers the catalog from a real SpiderKit robot distribution',
  async () => {
    const projectDirectory = process.env.LOGVUE_SPIDERKIT_PROJECT!
    const project = discoverSimulationProject(projectDirectory, 'linux')
    const catalog = await listSimulationCatalog(projectDirectory, 'linux')

    expect(project.manifestPath).toBe(join(projectDirectory, 'spiderkit-sim.json'))
    expect(catalog.plugins.length).toBeGreaterThan(0)
    expect(catalog.opModes.length).toBeGreaterThan(0)
  }
)

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createJavaEnvironment,
  discoverJavaRuntime,
  parseJavaMajorVersion,
  readJavaHomeProperty
} from '../src/main/services/simulation/javaRuntime'
import { SimulationProjectError } from '../src/main/services/simulation/project'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function projectWithGradleConfig(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'logvue-java-runtime-'))
  temporaryDirectories.push(root)
  if (contents !== undefined) {
    mkdirSync(join(root, '.gradle'))
    writeFileSync(join(root, '.gradle', 'config.properties'), contents)
  }
  return root
}

function jdkFiles(home: string): Set<string> {
  return new Set([win32.join(home, 'bin', 'java.exe'), win32.join(home, 'bin', 'javac.exe')])
}

describe('Windows Java runtime discovery', () => {
  it('decodes the escaped java.home format written by Android Studio', () => {
    expect(
      readJavaHomeProperty(String.raw`java.home=C\:\\Program Files\\Android\\Android Studio\\jbr`)
    ).toBe(String.raw`C:\Program Files\Android\Android Studio\jbr`)
  })

  it('prefers the project Gradle JDK over environment fallbacks', () => {
    const root = projectWithGradleConfig(
      String.raw`java.home=C\:\\Program Files\\Android\\Android Studio\\jbr`
    )
    const projectHome = String.raw`C:\Program Files\Android\Android Studio\jbr`
    const environmentHome = String.raw`D:\Java\jdk-21`
    const files = new Set([...jdkFiles(projectHome), ...jdkFiles(environmentHome)])
    const inspected: string[] = []

    const runtime = discoverJavaRuntime(root, {
      environment: { JAVA_HOME: environmentHome },
      isFile: (path) => files.has(path),
      inspectVersion: (_java, home) => {
        inspected.push(home)
        return 17
      },
      standardHomes: []
    })

    expect(runtime.home).toBe(projectHome)
    expect(runtime.javaExecutable).toBe(win32.join(projectHome, 'bin', 'java.exe'))
    expect(inspected).toEqual([projectHome])
  })

  it('skips incomplete and pre-Java-17 candidates in fallback order', () => {
    const root = projectWithGradleConfig(String.raw`java.home=C\:\\OldJdk`)
    const oldHome = String.raw`C:\OldJdk`
    const javaHome = String.raw`D:\IncompleteJdk`
    const studioHome = String.raw`E:\Android Studio\jbr`
    const files = new Set([
      ...jdkFiles(oldHome),
      win32.join(javaHome, 'bin', 'java.exe'),
      ...jdkFiles(studioHome)
    ])

    const runtime = discoverJavaRuntime(root, {
      environment: { JAVA_HOME: javaHome, STUDIO_JDK: studioHome },
      isFile: (path) => files.has(path),
      inspectVersion: (_java, home) => (home === oldHome ? 11 : 21),
      standardHomes: []
    })

    expect(runtime.home).toBe(studioHome)
    expect(runtime.majorVersion).toBe(21)
  })

  it('finds a complete JDK from the existing Windows Path as a last fallback', () => {
    const root = projectWithGradleConfig()
    const home = String.raw`D:\Tools\jdk-17`
    const files = jdkFiles(home)

    const runtime = discoverJavaRuntime(root, {
      environment: { Path: `${String.raw`C:\Windows\System32`};${win32.join(home, 'bin')}` },
      isFile: (path) => files.has(path),
      inspectVersion: () => 17,
      standardHomes: []
    })

    expect(runtime.home).toBe(home)
  })

  it('reports JAVA_NOT_FOUND with Android Studio guidance', () => {
    const root = projectWithGradleConfig()

    expect(() =>
      discoverJavaRuntime(root, {
        environment: {},
        isFile: () => false,
        standardHomes: []
      })
    ).toThrowError(
      expect.objectContaining<Partial<SimulationProjectError>>({
        code: 'JAVA_NOT_FOUND',
        message: expect.stringContaining('Open this robot project in Android Studio once')
      })
    )
  })

  it('does not return a relative executable from a malformed candidate', () => {
    const root = projectWithGradleConfig('java.home=relative-jdk')
    const files = jdkFiles('relative-jdk')

    expect(() =>
      discoverJavaRuntime(root, {
        environment: {},
        isFile: (path) => files.has(path),
        inspectVersion: () => 21,
        standardHomes: []
      })
    ).toThrowError(expect.objectContaining({ code: 'JAVA_NOT_FOUND' }))
  })

  it('recognizes current and legacy Java version output', () => {
    expect(parseJavaMajorVersion('openjdk version "17.0.12" 2024-07-16')).toBe(17)
    expect(parseJavaMajorVersion('java version "1.8.0_412"')).toBe(8)
    expect(parseJavaMajorVersion('not a Java version')).toBeNull()
  })
})

describe('private Java process environment', () => {
  it('removes duplicate case-insensitive keys and prepends the resolved JDK bin', () => {
    const home = String.raw`C:\Android\jbr`
    const environment = createJavaEnvironment(
      { home },
      {
        PATH: String.raw`C:\Windows\System32`,
        Path: String.raw`D:\Tools`,
        JAVA_HOME: String.raw`C:\OldJdk`,
        java_home: String.raw`D:\OtherJdk`,
        KEEP_ME: 'yes'
      }
    )

    expect(environment).toEqual({
      KEEP_ME: 'yes',
      JAVA_HOME: home,
      Path: `${win32.join(home, 'bin')};${String.raw`C:\Windows\System32`};${String.raw`D:\Tools`}`
    })
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'path')).toHaveLength(1)
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'java_home')).toHaveLength(1)
  })
})

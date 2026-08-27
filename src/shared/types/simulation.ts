export const SPIDER_KIT_SIM_PROTOCOL = 'spiderkit-sim-opmode' as const
export const SPIDER_KIT_SIM_PROTOCOL_VERSION = 1 as const
export const SPIDER_KIT_SIM_MANIFEST = 'spiderkit-sim.json' as const

export type SimulationPlatform = 'linux' | 'windows'

/** Source selection is fixed for the lifetime of one SpiderKit Sim process. */
export type SimulationGamepadSource =
  | { kind: 'NONE' }
  | { kind: 'LIVE' }
  | { kind: 'RLOG'; path: string }

export interface SimulationGamepadAxes {
  leftStickX: number
  leftStickY: number
  rightStickX: number
  rightStickY: number
  leftTrigger: number
  rightTrigger: number
}

export interface SimulationGamepadButtons {
  a: boolean
  b: boolean
  x: boolean
  y: boolean
  dpadUp: boolean
  dpadDown: boolean
  dpadLeft: boolean
  dpadRight: boolean
  leftBumper: boolean
  rightBumper: boolean
  leftStickButton: boolean
  rightStickButton: boolean
  back: boolean
  start: boolean
  guide: boolean
  touchpad: boolean
}

/** Canonical browser snapshot. SpiderKit Sim uses receipt time for freshness and pacing. */
export interface SimulationGamepadSnapshot {
  connected: boolean
  id: string | null
  mapping: string
  index: number | null
  timestamp: number
  capturedAt: number
  axes: SimulationGamepadAxes
  buttons: SimulationGamepadButtons
}

export interface SimulationGamepadFrame {
  gamepad1?: SimulationGamepadSnapshot
  gamepad2?: SimulationGamepadSnapshot
}

export interface SpiderKitSimPlatformCommands {
  /** Exact direct-process argv. Shell and batch-wrapper commands are not supported. */
  linux: string[]
  /** Exact direct-process argv. Use java/java.exe rather than a generated .bat launcher. */
  windows: string[]
}

export interface SpiderKitSimOptionalPlatformCommands {
  linux?: string[]
  /** Exact direct-process argv. Use java/java.exe rather than gradlew.bat or another batch file. */
  windows?: string[]
}

export interface SpiderKitSimManifestV1 {
  schemaVersion: 1
  protocolVersion: 1
  name: string
  /** Project-relative directory used as cwd. Defaults to the project root. */
  workingDirectory?: string
  /** Exact argv for each supported platform's robot-local SpiderKit runner distribution. */
  launchCommand: SpiderKitSimPlatformCommands
  /** Optional exact argv which builds the runner and robot plugin/artifact. */
  buildCommand?: SpiderKitSimOptionalPlatformCommands
}

export interface SimulationProject {
  projectDirectory: string
  manifestPath: string
  manifest: SpiderKitSimManifestV1
  platform: SimulationPlatform
  workingDirectory: string
  /** The argv selected from the manifest for this host platform. */
  launchCommand: string[]
  buildAvailable: boolean
}

export interface SimulationPluginInfo {
  id: string
  name: string
}

export interface SimulationOpModeInfo {
  id: string
  name: string
  group: string
  type: string
  pluginId: string
}

export interface SimulationScenarioInfo {
  id: string
  name: string
  description: string
  pluginId: string
}

export interface SimulationCatalog {
  plugins: SimulationPluginInfo[]
  opModes: SimulationOpModeInfo[]
  scenarios: SimulationScenarioInfo[]
}

export interface SimulationBuildResult {
  exitCode: number
  stdout: string
  stderr: string
  project: SimulationProject
  catalog: SimulationCatalog
}

export interface SimulationStartConfig {
  /** Trusted robot project containing spiderkit-sim.json. */
  projectDirectory: string
  opModeId: string
  pluginId?: string
  scenarioId?: string
  parameters?: Record<string, string>
  gamepad1: SimulationGamepadSource
  gamepad2: SimulationGamepadSource
  rateHz?: number
  staleMs?: number
  rlogPort?: number
}

export interface SimulationGamepadRuntimeStatus {
  mode: 'NONE' | 'LIVE' | 'RLOG'
  connected: boolean
  stale: boolean
  ageMillis: number | null
  lastSourceTimestamp: number | null
  [key: string]: unknown
}

export interface SimulationRunnerStatus {
  state: 'INITIALIZED' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'FAILED'
  id: string
  tick: number
  timeSeconds: number
  dtSeconds: number
  rateHz: number
  rlog?: {
    enabled?: boolean
    running?: boolean
    bindAddress?: string
    requestedPort?: number
    actualPort?: number
    [key: string]: unknown
  }
  gamepad1?: SimulationGamepadRuntimeStatus
  gamepad2?: SimulationGamepadRuntimeStatus
  [key: string]: unknown
}

export type SimulationPhase =
  | 'idle'
  | 'starting'
  | 'initialized'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'error'

export interface SimulationErrorInfo {
  code: string
  message: string
}

/** Renderer-safe service snapshot. It contains no ChildProcess or writable stream handles. */
export interface SimulationStatus {
  phase: SimulationPhase
  pid: number | null
  config: SimulationStartConfig | null
  project: SimulationProject | null
  runner: SimulationRunnerStatus | null
  lastError: SimulationErrorInfo | null
  stderrTail: string[]
}

export interface SimulationStderrEvent {
  line: string
}

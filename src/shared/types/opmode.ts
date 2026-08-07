/** FTC SDK OpMode lifecycle states exposed by the dashboard control hook. */
export type RobotOpModeState = 'STOPPED' | 'INIT' | 'RUNNING'

export type RobotOpModeAction = 'init' | 'start' | 'stop'

export interface RobotOpModeInfo {
  name: string
  group: string
}

/**
 * Fresh robot state returned to an MCP caller. `nonce` is issued by the robot and
 * must be passed back unchanged in the next init/start request. Stop uses none.
 */
export interface RobotOpModeStatus {
  protocolVersion: 1
  dashboardEnabled: boolean
  agentControlArmed: boolean
  robotAvailable: boolean
  accessEnabled: boolean
  activeOpMode: string | null
  activeOpModeStatus: RobotOpModeState
  opModes: RobotOpModeInfo[]
  nonce: string | null
  nonceExpiresInMs: number | null
}

export type RobotOpModeControlRequest =
  | { action: 'init'; nonce: string; opModeName: string }
  | { action: 'start'; nonce: string; opModeName?: never }
  | { action: 'stop'; nonce?: never; opModeName?: never }

export interface RobotOpModeControlResult {
  accepted: boolean
  action: RobotOpModeAction
  opModeName?: string
}

export type AgentOpModeLeaseState = 'disabled' | 'acquiring' | 'active' | 'degraded'

/** Main-process lease health exposed to the renderer. This never contains credentials or nonces. */
export interface AgentOpModeLeaseStatus {
  operatorEnabled: boolean
  state: AgentOpModeLeaseState
  endpoint: string | null
  leaseActive: boolean
  leaseExpiresAt: string | null
  dashboardEnabled: boolean | null
  agentControlArmed: boolean | null
  robotAvailable: boolean | null
  lastHeartbeatAt: string | null
  lastError: string | null
}

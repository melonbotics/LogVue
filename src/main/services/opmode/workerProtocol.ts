import type {
  AgentOpModeLeaseStatus,
  RobotOpModeControlRequest,
  RobotOpModeControlResult,
  RobotOpModeStatus
} from '../../../shared/types/opmode'

export interface AgentOpModeWorkerData {
  adbAddress: string
  eligible: boolean
}

export type AgentOpModeWorkerRequest =
  | { type: 'set-enabled'; id: number; enabled: boolean }
  | { type: 'set-target'; id: number; adbAddress: string; eligible: boolean }
  | { type: 'get-robot-status'; id: number }
  | { type: 'control-opmode'; id: number; request: RobotOpModeControlRequest }
  | { type: 'shutdown'; id: number }

export interface SerializedWorkerError {
  code: string
  message: string
  status: number | null
}

export type AgentOpModeWorkerResponse =
  | { type: 'lease-status'; status: AgentOpModeLeaseStatus }
  | {
      type: 'response'
      id: number
      ok: true
      value: AgentOpModeLeaseStatus | RobotOpModeStatus | RobotOpModeControlResult | null
    }
  | { type: 'response'; id: number; ok: false; error: SerializedWorkerError }

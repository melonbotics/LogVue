import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type {
  AgentOpModeLeaseStatus,
  RobotOpModeControlRequest,
  RobotOpModeControlResult,
  RobotOpModeStatus
} from '../../../shared/types/opmode'
import { getSettings } from '../../config/settings'
import type {
  AgentOpModeWorkerData,
  AgentOpModeWorkerRequest,
  AgentOpModeWorkerResponse,
  SerializedWorkerError
} from './workerProtocol'

const RPC_TIMEOUT_MS = 5_000

let worker: Worker | null = null
let nextRequestId = 0
let stopping = false
let controlIntentGeneration = 0
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }
>()

type WorkerRequestWithoutId = AgentOpModeWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

let cachedStatus: AgentOpModeLeaseStatus = disabledStatus(null)

export class AgentOpModeWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'AgentOpModeWorkerError'
  }
}

function disabledStatus(error: string | null): AgentOpModeLeaseStatus {
  return {
    operatorEnabled: false,
    state: 'disabled',
    endpoint: null,
    leaseActive: false,
    leaseExpiresAt: null,
    dashboardEnabled: null,
    agentControlArmed: null,
    robotAvailable: null,
    lastHeartbeatAt: null,
    lastError: error
  }
}

function workerConfig(): AgentOpModeWorkerData {
  const settings = getSettings()
  return {
    adbAddress: settings.adbAddress,
    eligible: settings.hubDataSource === 'adb'
  }
}

function spawnWorker(): Worker {
  if (worker) return worker
  const instance = new Worker(join(__dirname, 'agentOpModeWorker.js'), {
    workerData: workerConfig()
  })
  worker = instance
  instance.on('message', handleWorkerMessage)
  instance.on('error', (error) => handleWorkerFailure(error))
  instance.on('exit', (code) => {
    if (worker === instance) worker = null
    if (!stopping) {
      handleWorkerFailure(new Error(`lease worker exited with code ${code}`))
    }
  })
  return instance
}

function handleWorkerMessage(message: AgentOpModeWorkerResponse): void {
  if (message.type === 'lease-status') {
    cachedStatus = message.status
    return
  }
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timeout)
  if (message.ok) request.resolve(message.value)
  else request.reject(deserializeError(message.error))
}

function deserializeError(error: SerializedWorkerError): AgentOpModeWorkerError {
  return new AgentOpModeWorkerError(error.code, error.message, error.status)
}

function handleWorkerFailure(error: Error): void {
  cachedStatus = {
    ...cachedStatus,
    operatorEnabled: false,
    state: 'disabled',
    leaseActive: false,
    lastError: `Agent OpMode lease worker stopped: ${error.message}`
  }
  for (const [id, request] of pending) {
    pending.delete(id)
    clearTimeout(request.timeout)
    request.reject(error)
  }
}

function rpc<T>(request: WorkerRequestWithoutId): Promise<T> {
  const instance = spawnWorker()
  const id = ++nextRequestId
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new AgentOpModeWorkerError('WORKER_TIMEOUT', 'Agent OpMode lease worker did not respond', null))
    }, RPC_TIMEOUT_MS)
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timeout
    })
    instance.postMessage({ ...request, id } as AgentOpModeWorkerRequest)
  })
}

export function startAgentOpModeService(): void {
  stopping = false
  spawnWorker()
}

export function getAgentOpModeLeaseStatus(): AgentOpModeLeaseStatus {
  return { ...cachedStatus }
}

export async function setAgentOpModeControlEnabled(enabled: boolean): Promise<AgentOpModeLeaseStatus> {
  if (typeof enabled !== 'boolean') {
    throw new AgentOpModeWorkerError('INVALID_INPUT', 'Agent OpMode control setting must be boolean', null)
  }
  const requestGeneration = ++controlIntentGeneration
  if (enabled) {
    await refreshAgentOpModeTargetForCurrentSettings()
    if (requestGeneration !== controlIntentGeneration) {
      throw new AgentOpModeWorkerError(
        'CONTROL_INTENT_SUPERSEDED',
        'Agent OpMode enable was superseded by a newer disable or target change',
        null
      )
    }
  }
  return rpc<AgentOpModeLeaseStatus>({ type: 'set-enabled', enabled })
}

/** Notify the worker after the selected hub source or ADB target changes. */
export async function refreshAgentOpModeTarget(): Promise<AgentOpModeLeaseStatus> {
  // A settings change invalidates any enable intent that has not reached the worker yet.
  controlIntentGeneration += 1
  return refreshAgentOpModeTargetForCurrentSettings()
}

function refreshAgentOpModeTargetForCurrentSettings(): Promise<AgentOpModeLeaseStatus> {
  const config = workerConfig()
  return rpc<AgentOpModeLeaseStatus>({
    type: 'set-target',
    adbAddress: config.adbAddress,
    eligible: config.eligible
  })
}

export function getRobotStatus(): Promise<RobotOpModeStatus> {
  return rpc<RobotOpModeStatus>({ type: 'get-robot-status' })
}

export function controlOpMode(request: RobotOpModeControlRequest): Promise<RobotOpModeControlResult> {
  return rpc<RobotOpModeControlResult>({ type: 'control-opmode', request })
}

export async function stopAgentOpModeService(): Promise<void> {
  controlIntentGeneration += 1
  stopping = true
  const current = worker
  if (!current) return
  try {
    await rpc<null>({ type: 'shutdown' })
  } catch {
    // The robot's five-second watchdog is the final shutdown fallback.
  } finally {
    if (worker === current) worker = null
    await current.terminate()
    cachedStatus = disabledStatus(null)
  }
}

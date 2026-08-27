import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import type {
  AgentOpModeLeaseStatus,
  RobotOpModeControlRequest,
  RobotOpModeControlResult,
  RobotOpModeStatus
} from '../../../shared/types/opmode'
import {
  DashboardApiError,
  DashboardOpModeClient,
  dashboardOriginFromAdbAddress,
  type DashboardLeaseResponse
} from './dashboardClient'
import type {
  AgentOpModeWorkerData,
  AgentOpModeWorkerRequest,
  AgentOpModeWorkerResponse,
  SerializedWorkerError
} from './workerProtocol'

const HEARTBEAT_INTERVAL_MS = 1_000
const FIRM_LEASE_TTL_MS = 5_000

if (!parentPort) throw new Error('Agent OpMode lease worker requires a parent port')

let target = workerData as AgentOpModeWorkerData
let operatorEnabled = false
let everAcquired = false
let leaseToken: string | null = null
let leaseSequence = 0
let leaseExpiresAtMs = 0
let leaseDeadlineMonotonicMs = 0
let lastHeartbeatAtMs = 0
let lastError: string | null = null
let dashboardEnabled: boolean | null = null
let agentControlArmed: boolean | null = null
let robotAvailable: boolean | null = null
let heartbeatInFlight = false
let generation = 0
let deadlineTimer: ReturnType<typeof setTimeout> | null = null
let pendingNonce: string | null = null
let pendingNonceExpiresAtMonotonicMs = 0
let controlQueue: Promise<void> = Promise.resolve()

const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS)

function currentClient(): DashboardOpModeClient {
  return new DashboardOpModeClient(dashboardOriginFromAdbAddress(target.adbAddress))
}

function currentEndpoint(): string | null {
  try {
    return dashboardOriginFromAdbAddress(target.adbAddress)
  } catch {
    return null
  }
}

function leaseIsFresh(now = performance.now()): boolean {
  return !!leaseToken && leaseDeadlineMonotonicMs > now
}

function snapshot(): AgentOpModeLeaseStatus {
  const active = operatorEnabled && leaseIsFresh()
  const state = !operatorEnabled
    ? 'disabled'
    : active
      ? lastError
        ? 'degraded'
        : 'active'
      : 'acquiring'
  return {
    operatorEnabled,
    state,
    endpoint: currentEndpoint(),
    leaseActive: active,
    leaseExpiresAt: leaseExpiresAtMs ? new Date(leaseExpiresAtMs).toISOString() : null,
    dashboardEnabled,
    agentControlArmed,
    robotAvailable,
    lastHeartbeatAt: lastHeartbeatAtMs ? new Date(lastHeartbeatAtMs).toISOString() : null,
    lastError
  }
}

function post(message: AgentOpModeWorkerResponse): void {
  parentPort?.postMessage(message)
}

function emitStatus(): AgentOpModeLeaseStatus {
  const status = snapshot()
  post({ type: 'lease-status', status })
  return status
}

function clearDeadline(): void {
  if (deadlineTimer) clearTimeout(deadlineTimer)
  deadlineTimer = null
}

function armDeadline(): void {
  clearDeadline()
  const delay = Math.max(0, leaseDeadlineMonotonicMs - performance.now())
  deadlineTimer = setTimeout(() => {
    if (!operatorEnabled || !everAcquired) return
    if (leaseIsFresh()) armDeadline()
    else latchOff('Robot control lease expired; operator re-enable is required')
  }, delay)
}

function updateLease(response: DashboardLeaseResponse, requestStartedAtMonotonicMs: number): void {
  const now = Date.now()
  const monotonicNow = performance.now()
  if (leaseToken && response.leaseToken !== leaseToken) {
    throw new DashboardApiError(
      null,
      'LEASE_TOKEN_CHANGED',
      'FTC Dashboard changed the token while renewing a lease'
    )
  }
  leaseToken = response.leaseToken
  lastHeartbeatAtMs = now
  leaseDeadlineMonotonicMs =
    requestStartedAtMonotonicMs + Math.min(response.leaseExpiresInMs, FIRM_LEASE_TTL_MS)
  leaseExpiresAtMs = now + Math.max(0, leaseDeadlineMonotonicMs - monotonicNow)
  dashboardEnabled = response.dashboardEnabled
  agentControlArmed = response.agentControlArmed
  robotAvailable = response.robotAvailable
  if (!dashboardEnabled || !agentControlArmed || !robotAvailable) clearPendingNonce()
  everAcquired = true
  lastError = null
  armDeadline()
  emitStatus()
}

function clearLease(preserveLastAck = false): void {
  clearDeadline()
  leaseToken = null
  leaseDeadlineMonotonicMs = 0
  clearPendingNonce()
  if (!preserveLastAck) {
    leaseExpiresAtMs = 0
    lastHeartbeatAtMs = 0
  }
}

function clearPendingNonce(): void {
  pendingNonce = null
  pendingNonceExpiresAtMonotonicMs = 0
}

function latchOff(reason: string): void {
  generation += 1
  operatorEnabled = false
  // Retain the last successful ACK wall time/expiry for a useful post-mortem in the UI.
  clearLease(true)
  everAcquired = false
  dashboardEnabled = null
  agentControlArmed = null
  robotAvailable = null
  lastError = reason
  emitStatus()
}

function errorDetail(error: unknown): SerializedWorkerError {
  if (error instanceof DashboardApiError) {
    return { code: error.code, message: redactSecret(error.message), status: error.status }
  }
  return {
    code: 'OPMODE_CONTROL_ERROR',
    message: redactSecret(error instanceof Error ? error.message : String(error)),
    status: null
  }
}

function redactSecret(message: string): string {
  return leaseToken ? message.split(leaseToken).join('[redacted lease credential]') : message
}

function shouldLatchImmediately(error: unknown): boolean {
  if (!(error instanceof DashboardApiError)) return false
  const code = error.code.toUpperCase()
  return (
    !code.includes('NONCE') &&
    (error.status === 401 || code === 'LEASE_EXPIRED' || code === 'LEASE_TOKEN_CHANGED')
  )
}

async function heartbeat(): Promise<void> {
  if (!operatorEnabled || !target.eligible || heartbeatInFlight) return
  if (everAcquired && !leaseIsFresh()) {
    latchOff('Robot control lease expired; operator re-enable is required')
    return
  }

  heartbeatInFlight = true
  const requestGeneration = generation
  const requestStartedAtMonotonicMs = performance.now()
  try {
    const client = currentClient()
    const response = leaseToken
      ? await client.renewLease(leaseToken, ++leaseSequence)
      : await client.acquireLease(leaseSequence)
    if (requestGeneration !== generation || !operatorEnabled) return
    updateLease(response, requestStartedAtMonotonicMs)
  } catch (error) {
    if (requestGeneration !== generation || !operatorEnabled) return
    const detail = errorDetail(error)
    if (everAcquired && shouldLatchImmediately(error)) {
      latchOff(`${detail.message}; operator re-enable is required`)
    } else {
      lastError = detail.message
      emitStatus()
    }
  } finally {
    heartbeatInFlight = false
  }
}

async function releaseCurrentLease(): Promise<string | null> {
  const token = leaseToken
  if (!token) return null
  try {
    await currentClient().releaseLease(token)
    return null
  } catch (error) {
    return `Lease release failed; the robot watchdog will disarm it. ${errorDetail(error).message}`
  }
}

async function setEnabled(enabled: boolean): Promise<AgentOpModeLeaseStatus> {
  if (!enabled) {
    const requestGeneration = ++generation
    // Block new control immediately, before waiting for the best-effort DELETE.
    operatorEnabled = false
    const releaseError = await releaseCurrentLease()
    // A later enable/target mutation owns the worker now. Its lease and status
    // must not be cleared by this stale DELETE completion.
    if (requestGeneration !== generation) return snapshot()
    clearLease()
    everAcquired = false
    dashboardEnabled = null
    agentControlArmed = null
    robotAvailable = null
    lastError = releaseError
    return emitStatus()
  }

  if (!target.eligible) {
    throw new DashboardApiError(
      null,
      'CONTROL_HUB_SOURCE_REQUIRED',
      'Agent OpMode control requires the Control Hub ADB source'
    )
  }
  // Validate the target before showing an armed/acquiring switch in the UI.
  currentClient()
  if (operatorEnabled) return snapshot()

  generation += 1
  operatorEnabled = true
  everAcquired = false
  leaseSequence = 0
  clearLease()
  lastError = null
  emitStatus()
  await heartbeat()
  return snapshot()
}

async function setTarget(next: AgentOpModeWorkerData): Promise<AgentOpModeLeaseStatus> {
  if (next.adbAddress === target.adbAddress && next.eligible === target.eligible) return snapshot()

  const requestGeneration = ++generation
  const hadEstablishedLease = everAcquired || !!leaseToken
  const wasOperatorEnabled = operatorEnabled
  const latchReason = wasOperatorEnabled
    ? !next.eligible
      ? 'Control Hub source changed; operator re-enable is required'
      : hadEstablishedLease
        ? 'Control Hub target changed; operator re-enable is required'
        : null
    : null

  // Start releasing against the old target before changing it, but block all
  // further control synchronously rather than leaving an HTTP-sized race window.
  const release = hadEstablishedLease ? releaseCurrentLease() : null
  target = next
  if (latchReason) {
    operatorEnabled = false
    clearPendingNonce()
    dashboardEnabled = null
    agentControlArmed = null
    robotAvailable = null
    lastError = latchReason
    emitStatus()
  }

  const releaseError = release ? await release : null
  // Concurrent target changes are last-request-wins. Do not let an older
  // release completion overwrite a target or lease established afterward.
  if (requestGeneration !== generation) return snapshot()

  if (latchReason) {
    latchOff(releaseError ? `${latchReason} ${releaseError}` : latchReason)
  } else {
    clearLease()
    dashboardEnabled = null
    agentControlArmed = null
    robotAvailable = null
    lastError = null
    emitStatus()
    if (operatorEnabled) void heartbeat()
  }
  return snapshot()
}

function requireLease(): { client: DashboardOpModeClient; token: string } {
  if (!operatorEnabled) {
    throw new DashboardApiError(
      null,
      'AGENT_CONTROL_DISABLED',
      'Agent OpMode control is disabled in LogVue; the operator must enable it in MCP setup'
    )
  }
  if (!target.eligible) {
    throw new DashboardApiError(
      null,
      'CONTROL_HUB_SOURCE_REQUIRED',
      'Agent OpMode control requires the Control Hub ADB source'
    )
  }
  if (!leaseToken || !leaseIsFresh()) {
    if (everAcquired) latchOff('Robot control lease expired; operator re-enable is required')
    throw new DashboardApiError(null, 'LEASE_UNAVAILABLE', 'No active robot control lease is available')
  }
  return { client: currentClient(), token: leaseToken }
}

async function getRobotStatus() {
  const { client, token } = requireLease()
  const requestGeneration = generation
  clearPendingNonce()
  try {
    // Deliberately independent of updateLease(): status may mint a nonce but never renews the lease.
    const status = await client.getRobotStatus(token)
    if (requestGeneration !== generation || !operatorEnabled) {
      throw new DashboardApiError(
        null,
        'STALE_CONTROL_CONTEXT',
        'The robot control target or operator permission changed while reading status'
      )
    }
    if (
      status.accessEnabled &&
      status.nonce &&
      status.nonceExpiresInMs
    ) {
      pendingNonce = status.nonce
      pendingNonceExpiresAtMonotonicMs = performance.now() + status.nonceExpiresInMs
    }
    return status
  } catch (error) {
    if (requestGeneration === generation && operatorEnabled && shouldLatchImmediately(error)) {
      latchOff('Robot control lease was rejected; operator re-enable is required')
    }
    throw error
  }
}

function enqueueControlRequest<T>(operation: () => Promise<T>): Promise<T> {
  const result = controlQueue.then(operation, operation)
  controlQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function controlOpMode(request: RobotOpModeControlRequest) {
  const { client, token } = requireLease()
  const requestGeneration = generation
  if (request.action !== 'stop') {
    if (
      !pendingNonce ||
      performance.now() >= pendingNonceExpiresAtMonotonicMs ||
      request.nonce !== pendingNonce
    ) {
      clearPendingNonce()
      throw new DashboardApiError(
        null,
        'FRESH_STATUS_REQUIRED',
        'Call get_robot_status immediately before init or start and pass its usable nonce unchanged'
      )
    }
  }
  // Init/start consume their nonce. Stop needs none, but invalidates any cached nonce
  // because it changes the lifecycle state the preceding status described.
  clearPendingNonce()
  try {
    // Deliberately independent of updateLease(): control requests never renew the lease.
    const result = await client.controlOpMode(token, request)
    if (requestGeneration !== generation || !operatorEnabled) {
      throw new DashboardApiError(
        null,
        'STALE_CONTROL_CONTEXT',
        'The robot control target or operator permission changed while applying the request'
      )
    }
    return result
  } catch (error) {
    if (requestGeneration === generation && operatorEnabled && shouldLatchImmediately(error)) {
      latchOff('Robot control lease was rejected; operator re-enable is required')
    }
    throw error
  }
}

async function handle(request: AgentOpModeWorkerRequest): Promise<void> {
  try {
    let value: AgentOpModeLeaseStatus | RobotOpModeStatus | RobotOpModeControlResult | null
    switch (request.type) {
      case 'set-enabled':
        value = await setEnabled(request.enabled)
        break
      case 'set-target':
        value = await setTarget({ adbAddress: request.adbAddress, eligible: request.eligible })
        break
      case 'get-robot-status':
        value = await enqueueControlRequest(getRobotStatus)
        break
      case 'control-opmode':
        value = await enqueueControlRequest(() => controlOpMode(request.request))
        break
      case 'shutdown':
        clearInterval(heartbeatTimer)
        await setEnabled(false)
        value = null
        break
    }
    post({ type: 'response', id: request.id, ok: true, value } as AgentOpModeWorkerResponse)
    if (request.type === 'shutdown') parentPort?.close()
  } catch (error) {
    post({ type: 'response', id: request.id, ok: false, error: errorDetail(error) })
  }
}

parentPort.on('message', (request: AgentOpModeWorkerRequest) => void handle(request))
emitStatus()

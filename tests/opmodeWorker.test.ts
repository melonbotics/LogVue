import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentOpModeLeaseStatus,
  RobotOpModeControlRequest,
  RobotOpModeControlResult,
  RobotOpModeStatus
} from '../src/shared/types/opmode'
import type {
  AgentOpModeWorkerRequest,
  AgentOpModeWorkerResponse
} from '../src/main/services/opmode/workerProtocol'

const LEASE_TOKEN = 'private-worker-lease-token-1234567890'
const FIRST_NONCE = 'fresh-status-nonce-1234567890'
const SECOND_NONCE = 'fresh-status-nonce-abcdefghij'

interface LeaseResponse {
  protocolVersion: 1
  leaseToken: string
  leaseExpiresInMs: number
  dashboardEnabled: boolean
  agentControlArmed: boolean
  robotAvailable: boolean
}

type WorkerRequestWithoutId =
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'set-target'; adbAddress: string; eligible: boolean }
  | { type: 'get-robot-status' }
  | { type: 'control-opmode'; request: RobotOpModeControlRequest }
  | { type: 'shutdown' }

class MockDashboardApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'DashboardApiError'
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function leaseResponse(expiresInMs = 5_000): LeaseResponse {
  return {
    protocolVersion: 1,
    leaseToken: LEASE_TOKEN,
    leaseExpiresInMs: expiresInMs,
    dashboardEnabled: true,
    agentControlArmed: true,
    robotAvailable: true
  }
}

function robotStatus(nonce = FIRST_NONCE): RobotOpModeStatus {
  return {
    protocolVersion: 1,
    dashboardEnabled: true,
    agentControlArmed: true,
    robotAvailable: true,
    accessEnabled: true,
    activeOpMode: null,
    activeOpModeStatus: 'STOPPED',
    opModes: [{ name: 'Drive Test', group: 'Test' }],
    nonce,
    nonceExpiresInMs: 10_000
  }
}

interface WorkerHarness {
  messages: AgentOpModeWorkerResponse[]
  dashboard: {
    acquireLease: ReturnType<typeof vi.fn<(sequence: number) => Promise<LeaseResponse>>>
    renewLease: ReturnType<typeof vi.fn<(token: string, sequence: number) => Promise<LeaseResponse>>>
    releaseLease: ReturnType<typeof vi.fn<(token: string) => Promise<void>>>
    getRobotStatus: ReturnType<typeof vi.fn<(token: string) => Promise<RobotOpModeStatus>>>
    controlOpMode: ReturnType<
      typeof vi.fn<
        (token: string, request: RobotOpModeControlRequest) => Promise<RobotOpModeControlResult>
      >
    >
  }
  send: (request: WorkerRequestWithoutId) => number
  response: (id: number) => Promise<Extract<AgentOpModeWorkerResponse, { type: 'response' }>>
  call: (
    request: WorkerRequestWithoutId
  ) => Promise<Extract<AgentOpModeWorkerResponse, { type: 'response' }>>
  latestStatus: () => AgentOpModeLeaseStatus
}

async function createHarness(options: { leaseExpiresInMs?: number } = {}): Promise<WorkerHarness> {
  vi.resetModules()

  const messages: AgentOpModeWorkerResponse[] = []
  let messageListener: ((request: AgentOpModeWorkerRequest) => void) | null = null
  let nextRequestId = 0

  const dashboard = {
    acquireLease: vi.fn(async (_sequence: number) => leaseResponse(options.leaseExpiresInMs)),
    renewLease: vi.fn(async (_token: string, _sequence: number) =>
      leaseResponse(options.leaseExpiresInMs)
    ),
    releaseLease: vi.fn(async (_token: string) => undefined),
    getRobotStatus: vi.fn(async (_token: string) => robotStatus()),
    controlOpMode: vi.fn(
      async (
        _token: string,
        request: RobotOpModeControlRequest
      ): Promise<RobotOpModeControlResult> => ({
        accepted: true,
        action: request.action,
        ...(request.action === 'init' ? { opModeName: request.opModeName } : {})
      })
    )
  }

  const parentPort = {
    postMessage(message: AgentOpModeWorkerResponse) {
      messages.push(message)
    },
    on(event: string, listener: (request: AgentOpModeWorkerRequest) => void) {
      if (event === 'message') messageListener = listener
      return parentPort
    },
    close: vi.fn()
  }

  vi.doMock('node:worker_threads', () => ({
    parentPort,
    workerData: { adbAddress: '192.168.43.1:5555', eligible: true }
  }))
  // Vitest's fake clock controls Date/timers but not Node's perf_hooks object.
  // Keep the worker's monotonic clock on the same deterministic test timeline.
  vi.doMock('node:perf_hooks', () => ({ performance: { now: () => Date.now() } }))
  vi.doMock('../src/main/services/opmode/dashboardClient', () => ({
    DashboardApiError: MockDashboardApiError,
    DashboardOpModeClient: class {
      constructor(readonly origin: string) {}

      acquireLease(sequence: number) {
        return dashboard.acquireLease(sequence)
      }

      renewLease(token: string, sequence: number) {
        return dashboard.renewLease(token, sequence)
      }

      releaseLease(token: string) {
        return dashboard.releaseLease(token)
      }

      getRobotStatus(token: string) {
        return dashboard.getRobotStatus(token)
      }

      controlOpMode(token: string, request: RobotOpModeControlRequest) {
        return dashboard.controlOpMode(token, request)
      }
    },
    dashboardOriginFromAdbAddress: (address: string) => `http://${address}/dashboard`
  }))

  await import('../src/main/services/opmode/worker')
  if (!messageListener) throw new Error('Worker did not register its parent-port message listener')

  function send(request: WorkerRequestWithoutId): number {
    const id = ++nextRequestId
    messageListener?.({ ...request, id } as AgentOpModeWorkerRequest)
    return id
  }

  async function response(
    id: number
  ): Promise<Extract<AgentOpModeWorkerResponse, { type: 'response' }>> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const found = messages.find(
        (message): message is Extract<AgentOpModeWorkerResponse, { type: 'response' }> =>
          message.type === 'response' && message.id === id
      )
      if (found) return found
      await Promise.resolve()
    }
    throw new Error(`Worker did not respond to request ${id}`)
  }

  async function call(request: WorkerRequestWithoutId) {
    return response(send(request))
  }

  function latestStatus(): AgentOpModeLeaseStatus {
    const status = [...messages]
      .reverse()
      .find(
        (message): message is Extract<AgentOpModeWorkerResponse, { type: 'lease-status' }> =>
          message.type === 'lease-status'
      )
    if (!status) throw new Error('Worker did not emit a lease status')
    return status.status
  }

  return { messages, dashboard, send, response, call, latestStatus }
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-08-07T00:00:00.000Z') })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('Agent OpMode lease worker', () => {
  it('renews every second, latches off at the deadline, and never silently reacquires', async () => {
    const harness = await createHarness()

    const enabled = await harness.call({ type: 'set-enabled', enabled: true })
    expect(enabled).toMatchObject({ ok: true, value: { operatorEnabled: true, state: 'active' } })
    expect(harness.dashboard.acquireLease).toHaveBeenCalledWith(0)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.dashboard.renewLease).toHaveBeenCalledWith(LEASE_TOKEN, 1)

    harness.dashboard.renewLease.mockRejectedValue(
      new MockDashboardApiError(null, 'DASHBOARD_UNREACHABLE', 'connection lost')
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.latestStatus()).toMatchObject({
      operatorEnabled: true,
      state: 'degraded',
      leaseActive: true,
      lastError: 'connection lost'
    })

    await vi.advanceTimersByTimeAsync(4_000)
    expect(harness.latestStatus()).toMatchObject({
      operatorEnabled: false,
      state: 'disabled',
      leaseActive: false,
      lastError: expect.stringContaining('lease expired')
    })

    const acquisitionCount = harness.dashboard.acquireLease.mock.calls.length
    const renewalCount = harness.dashboard.renewLease.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.dashboard.acquireLease).toHaveBeenCalledTimes(acquisitionCount)
    expect(harness.dashboard.renewLease).toHaveBeenCalledTimes(renewalCount)
  })

  it('honours a server lease TTL shorter than the five-second firm maximum', async () => {
    const harness = await createHarness({ leaseExpiresInMs: 500 })

    await harness.call({ type: 'set-enabled', enabled: true })
    expect(harness.latestStatus()).toMatchObject({ operatorEnabled: true, leaseActive: true })

    await vi.advanceTimersByTimeAsync(499)
    expect(harness.latestStatus()).toMatchObject({ operatorEnabled: true, leaseActive: true })

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.latestStatus()).toMatchObject({
      operatorEnabled: false,
      state: 'disabled',
      leaseActive: false
    })
    expect(harness.dashboard.renewLease).not.toHaveBeenCalled()
  })

  it('consumes a fresh nonce once for init and once for start', async () => {
    const harness = await createHarness()
    harness.dashboard.getRobotStatus
      .mockResolvedValueOnce(robotStatus(FIRST_NONCE))
      .mockResolvedValueOnce(robotStatus(SECOND_NONCE))
    await harness.call({ type: 'set-enabled', enabled: true })

    await harness.call({ type: 'get-robot-status' })
    const initialized = await harness.call({
      type: 'control-opmode',
      request: { action: 'init', nonce: FIRST_NONCE, opModeName: 'Drive Test' }
    })
    expect(initialized).toMatchObject({ ok: true, value: { accepted: true, action: 'init' } })

    const reusedInitNonce = await harness.call({
      type: 'control-opmode',
      request: { action: 'start', nonce: FIRST_NONCE }
    })
    expect(reusedInitNonce).toMatchObject({
      ok: false,
      error: { code: 'FRESH_STATUS_REQUIRED' }
    })

    await harness.call({ type: 'get-robot-status' })
    const started = await harness.call({
      type: 'control-opmode',
      request: { action: 'start', nonce: SECOND_NONCE }
    })
    expect(started).toMatchObject({ ok: true, value: { accepted: true, action: 'start' } })

    const reusedStartNonce = await harness.call({
      type: 'control-opmode',
      request: { action: 'start', nonce: SECOND_NONCE }
    })
    expect(reusedStartNonce).toMatchObject({
      ok: false,
      error: { code: 'FRESH_STATUS_REQUIRED' }
    })
    expect(harness.dashboard.controlOpMode).toHaveBeenCalledTimes(2)
  })

  it('allows nonce-free stop and invalidates a previously cached nonce', async () => {
    const harness = await createHarness()
    await harness.call({ type: 'set-enabled', enabled: true })
    await harness.call({ type: 'get-robot-status' })

    const stopped = await harness.call({
      type: 'control-opmode',
      request: { action: 'stop' }
    })
    expect(stopped).toMatchObject({ ok: true, value: { accepted: true, action: 'stop' } })
    expect(harness.dashboard.controlOpMode).toHaveBeenLastCalledWith(LEASE_TOKEN, { action: 'stop' })

    const staleStart = await harness.call({
      type: 'control-opmode',
      request: { action: 'start', nonce: FIRST_NONCE }
    })
    expect(staleStart).toMatchObject({ ok: false, error: { code: 'FRESH_STATUS_REQUIRED' } })
    expect(harness.dashboard.controlOpMode).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale status response without latching off a newly enabled target', async () => {
    const harness = await createHarness()
    const oldStatus = deferred<RobotOpModeStatus>()
    harness.dashboard.getRobotStatus.mockReturnValueOnce(oldStatus.promise)
    await harness.call({ type: 'set-enabled', enabled: true })

    const staleStatusId = harness.send({ type: 'get-robot-status' })
    await Promise.resolve()
    expect(harness.dashboard.getRobotStatus).toHaveBeenCalledWith(LEASE_TOKEN)

    await harness.call({
      type: 'set-target',
      adbAddress: '192.168.44.1:5555',
      eligible: true
    })
    await harness.call({ type: 'set-enabled', enabled: true })
    expect(harness.latestStatus()).toMatchObject({ operatorEnabled: true, state: 'active' })

    oldStatus.resolve(robotStatus(FIRST_NONCE))
    const staleResponse = await harness.response(staleStatusId)
    expect(staleResponse).toMatchObject({
      ok: false,
      error: { code: 'STALE_CONTROL_CONTEXT' }
    })
    expect(harness.latestStatus()).toMatchObject({ operatorEnabled: true, state: 'active' })
  })

  it('does not let a late old-target rejection latch off a newly enabled target', async () => {
    const harness = await createHarness()
    const oldStatus = deferred<RobotOpModeStatus>()
    harness.dashboard.getRobotStatus.mockReturnValueOnce(oldStatus.promise)
    await harness.call({ type: 'set-enabled', enabled: true })

    const staleStatusId = harness.send({ type: 'get-robot-status' })
    await Promise.resolve()
    await harness.call({
      type: 'set-target',
      adbAddress: '192.168.44.1:5555',
      eligible: true
    })
    await harness.call({ type: 'set-enabled', enabled: true })

    oldStatus.reject(new MockDashboardApiError(401, 'LEASE_EXPIRED', 'old lease expired'))
    const staleResponse = await harness.response(staleStatusId)
    expect(staleResponse).toMatchObject({ ok: false, error: { code: 'LEASE_EXPIRED' } })
    expect(harness.latestStatus()).toMatchObject({ operatorEnabled: true, state: 'active' })
  })

  it('rejects a stale control result without latching off a newly enabled target', async () => {
    const harness = await createHarness()
    const oldControl = deferred<RobotOpModeControlResult>()
    harness.dashboard.controlOpMode.mockReturnValueOnce(oldControl.promise)
    await harness.call({ type: 'set-enabled', enabled: true })
    await harness.call({ type: 'get-robot-status' })

    const staleControlId = harness.send({
      type: 'control-opmode',
      request: { action: 'init', nonce: FIRST_NONCE, opModeName: 'Drive Test' }
    })
    await Promise.resolve()
    expect(harness.dashboard.controlOpMode).toHaveBeenCalledWith(LEASE_TOKEN, {
      action: 'init',
      nonce: FIRST_NONCE,
      opModeName: 'Drive Test'
    })

    await harness.call({
      type: 'set-target',
      adbAddress: '192.168.44.1:5555',
      eligible: true
    })
    await harness.call({ type: 'set-enabled', enabled: true })

    oldControl.resolve({ accepted: true, action: 'init', opModeName: 'Drive Test' })
    const staleResponse = await harness.response(staleControlId)
    expect(staleResponse).toMatchObject({
      ok: false,
      error: { code: 'STALE_CONTROL_CONTEXT' }
    })
    expect(harness.latestStatus()).toMatchObject({ operatorEnabled: true, state: 'active' })
  })

  it('never exposes the private lease token or cached nonce in renderer lease status', async () => {
    const harness = await createHarness()
    await harness.call({ type: 'set-enabled', enabled: true })
    await harness.call({ type: 'get-robot-status' })
    await vi.advanceTimersByTimeAsync(1_000)

    const exposedStatuses = harness.messages.filter(
      (message): message is Extract<AgentOpModeWorkerResponse, { type: 'lease-status' }> =>
        message.type === 'lease-status'
    )
    expect(exposedStatuses.length).toBeGreaterThan(0)
    for (const { status } of exposedStatuses) {
      const serialized = JSON.stringify(status)
      expect(serialized).not.toContain(LEASE_TOKEN)
      expect(serialized).not.toContain(FIRST_NONCE)
      expect(status).not.toHaveProperty('leaseToken')
      expect(status).not.toHaveProperty('nonce')
    }
  })

  it('does not let a delayed disable release clear a subsequently re-enabled lease', async () => {
    const harness = await createHarness()
    const oldRelease = deferred<void>()
    await harness.call({ type: 'set-enabled', enabled: true })
    harness.dashboard.releaseLease.mockReturnValueOnce(oldRelease.promise)

    const disableId = harness.send({ type: 'set-enabled', enabled: false })
    await Promise.resolve()

    const controlDuringRelease = await harness.call({
      type: 'control-opmode',
      request: { action: 'stop' }
    })
    expect(controlDuringRelease).toMatchObject({
      ok: false,
      error: { code: 'AGENT_CONTROL_DISABLED' }
    })

    const reEnabled = await harness.call({ type: 'set-enabled', enabled: true })
    expect(reEnabled).toMatchObject({
      ok: true,
      value: { operatorEnabled: true, state: 'active', leaseActive: true }
    })

    oldRelease.resolve()
    const staleDisable = await harness.response(disableId)
    expect(staleDisable).toMatchObject({
      ok: true,
      value: { operatorEnabled: true, state: 'active', leaseActive: true }
    })
    expect(harness.latestStatus()).toMatchObject({
      operatorEnabled: true,
      state: 'active',
      leaseActive: true
    })
  })

  it('blocks control immediately while an old-target release is pending', async () => {
    const harness = await createHarness()
    const oldRelease = deferred<void>()
    await harness.call({ type: 'set-enabled', enabled: true })
    harness.dashboard.releaseLease.mockReturnValueOnce(oldRelease.promise)

    const targetId = harness.send({
      type: 'set-target',
      adbAddress: '192.168.44.1:5555',
      eligible: true
    })
    await Promise.resolve()
    expect(harness.latestStatus()).toMatchObject({
      endpoint: 'http://192.168.44.1:5555/dashboard',
      operatorEnabled: false,
      leaseActive: false
    })

    const controlDuringRelease = await harness.call({
      type: 'control-opmode',
      request: { action: 'stop' }
    })
    expect(controlDuringRelease).toMatchObject({
      ok: false,
      error: { code: 'AGENT_CONTROL_DISABLED' }
    })
    expect(harness.dashboard.controlOpMode).not.toHaveBeenCalled()

    oldRelease.resolve()
    await expect(harness.response(targetId)).resolves.toMatchObject({
      ok: true,
      value: { operatorEnabled: false, leaseActive: false }
    })
  })

  it('does not let overlapping target releases apply out of request order', async () => {
    const harness = await createHarness()
    const firstRelease = deferred<void>()
    const secondRelease = deferred<void>()
    await harness.call({ type: 'set-enabled', enabled: true })
    harness.dashboard.releaseLease
      .mockReturnValueOnce(firstRelease.promise)
      .mockReturnValueOnce(secondRelease.promise)

    const firstTargetId = harness.send({
      type: 'set-target',
      adbAddress: '192.168.44.1:5555',
      eligible: true
    })
    await Promise.resolve()
    const secondTargetId = harness.send({
      type: 'set-target',
      adbAddress: '192.168.45.1:5555',
      eligible: true
    })
    await Promise.resolve()

    secondRelease.resolve()
    const secondTarget = await harness.response(secondTargetId)
    expect(secondTarget).toMatchObject({
      ok: true,
      value: { endpoint: 'http://192.168.45.1:5555/dashboard', operatorEnabled: false }
    })

    firstRelease.resolve()
    const staleFirstTarget = await harness.response(firstTargetId)
    expect(staleFirstTarget).toMatchObject({
      ok: true,
      value: { endpoint: 'http://192.168.45.1:5555/dashboard', operatorEnabled: false }
    })
    expect(harness.latestStatus()).toMatchObject({
      endpoint: 'http://192.168.45.1:5555/dashboard',
      operatorEnabled: false
    })
  })
})

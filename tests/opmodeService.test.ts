import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentOpModeLeaseStatus } from '../src/shared/types/opmode'
import type { AgentOpModeWorkerResponse } from '../src/main/services/opmode/workerProtocol'

interface PostedRequest {
  id: number
  type: string
  enabled?: boolean
}

function disabledStatus(): AgentOpModeLeaseStatus {
  return {
    operatorEnabled: false,
    state: 'disabled',
    endpoint: 'http://192.168.43.1:8080',
    leaseActive: false,
    leaseExpiresAt: null,
    dashboardEnabled: null,
    agentControlArmed: null,
    robotAvailable: null,
    lastHeartbeatAt: null,
    lastError: null
  }
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('Agent OpMode service control intent', () => {
  it('does not post an older pending enable after a newer disable', async () => {
    vi.resetModules()
    const workers: MockWorker[] = []

    class MockWorker {
      readonly posted: PostedRequest[] = []
      private readonly listeners = new Map<string, Array<(value: unknown) => void>>()

      constructor(_path: string, _options: unknown) {
        workers.push(this)
      }

      on(event: string, listener: (value: unknown) => void): this {
        const listeners = this.listeners.get(event) ?? []
        listeners.push(listener)
        this.listeners.set(event, listeners)
        return this
      }

      postMessage(request: PostedRequest): void {
        this.posted.push(request)
      }

      emitMessage(message: AgentOpModeWorkerResponse): void {
        for (const listener of this.listeners.get('message') ?? []) listener(message)
      }

      async terminate(): Promise<number> {
        return 0
      }
    }

    vi.doMock('node:worker_threads', () => ({ Worker: MockWorker }))
    vi.doMock('../src/main/config/settings', () => ({
      getSettings: () => ({ adbAddress: '192.168.43.1:5555', hubDataSource: 'adb' })
    }))

    const service = await import('../src/main/services/opmode/service')
    const enablePromise = service.setAgentOpModeControlEnabled(true)
    const enableOutcome = enablePromise.then(
      () => ({ code: null }),
      (error: { code?: string }) => ({ code: error.code ?? null })
    )
    const worker = workers[0]
    expect(worker.posted).toHaveLength(1)
    expect(worker.posted[0]).toMatchObject({ type: 'set-target' })

    const disablePromise = service.setAgentOpModeControlEnabled(false)
    expect(worker.posted).toHaveLength(2)
    expect(worker.posted[1]).toMatchObject({ type: 'set-enabled', enabled: false })

    worker.emitMessage({
      type: 'response',
      id: worker.posted[0].id,
      ok: true,
      value: disabledStatus()
    })
    worker.emitMessage({
      type: 'response',
      id: worker.posted[1].id,
      ok: true,
      value: disabledStatus()
    })

    await expect(disablePromise).resolves.toMatchObject({ operatorEnabled: false })
    await expect(enableOutcome).resolves.toEqual({ code: 'CONTROL_INTENT_SUPERSEDED' })
    expect(worker.posted.map(({ type, enabled }) => ({ type, enabled }))).toEqual([
      { type: 'set-target', enabled: undefined },
      { type: 'set-enabled', enabled: false }
    ])
  })
})

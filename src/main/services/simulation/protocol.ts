import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  SPIDER_KIT_SIM_PROTOCOL,
  SPIDER_KIT_SIM_PROTOCOL_VERSION,
  type SimulationErrorInfo,
  type SimulationRunnerStatus
} from '../../../shared/types/simulation'

const MAX_LINE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 5_000

interface PendingRequest {
  command: string
  resolve: (status: SimulationRunnerStatus) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export class SpiderKitSimProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SpiderKitSimProtocolError'
  }
}

/** Strict request/reply NDJSON adapter. SpiderKit Sim remains the lifecycle and pacing authority. */
export class SpiderKitSimProtocolClient {
  private nextId = 0
  private stdoutBuffer = ''
  private readonly pending = new Map<number, PendingRequest>()
  private failed: Error | null = null

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly onFatal: (error: Error) => void = () => undefined
  ) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.acceptStdout(chunk))
    child.once('error', (error) => this.fail(new SpiderKitSimProtocolError('PROCESS_ERROR', error.message)))
    child.once('close', (code, signal) => {
      this.fail(
        new SpiderKitSimProtocolError(
          'PROCESS_EXITED',
          `SpiderKit Sim exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`
        )
      )
    })
  }

  request(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<SimulationRunnerStatus> {
    if (this.failed) return Promise.reject(this.failed)
    const id = ++this.nextId
    const line = JSON.stringify({
      protocolVersion: SPIDER_KIT_SIM_PROTOCOL_VERSION,
      id,
      command,
      ...payload
    })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        const error = new SpiderKitSimProtocolError(
          'REQUEST_TIMEOUT',
          `SpiderKit Sim ${command} timed out`
        )
        reject(error)
        this.fail(error)
      }, timeoutMs)
      this.pending.set(id, { command, resolve, reject, timeout })
      this.child.stdin.write(`${line}\n`, 'utf8', (error) => {
        if (error) this.fail(new SpiderKitSimProtocolError('STDIN_ERROR', error.message))
      })
    })
  }

  /** EOF is SpiderKit Sim's final neutralization boundary. */
  closeInput(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end()
  }

  terminate(): void {
    this.closeInput()
    if (!this.child.killed) this.child.kill()
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES && !this.stdoutBuffer.includes('\n')) {
      this.fail(new SpiderKitSimProtocolError('RESPONSE_TOO_LARGE', 'SpiderKit Sim response exceeded 1 MiB'))
      return
    }
    let newline: number
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.fail(new SpiderKitSimProtocolError('RESPONSE_TOO_LARGE', 'SpiderKit Sim response exceeded 1 MiB'))
        return
      }
      if (line.trim()) this.acceptLine(line)
    }
  }

  private acceptLine(line: string): void {
    let response: unknown
    try {
      response = JSON.parse(line)
    } catch {
      this.fail(new SpiderKitSimProtocolError('MALFORMED_RESPONSE', 'SpiderKit Sim stdout was not valid NDJSON'))
      return
    }
    if (!isRecord(response)) {
      this.fail(new SpiderKitSimProtocolError('INVALID_RESPONSE', 'SpiderKit Sim response must be an object'))
      return
    }
    if (
      response.protocol !== SPIDER_KIT_SIM_PROTOCOL ||
      response.protocolVersion !== SPIDER_KIT_SIM_PROTOCOL_VERSION
    ) {
      this.fail(new SpiderKitSimProtocolError('PROTOCOL_MISMATCH', 'SpiderKit Sim protocol is incompatible with LogVue'))
      return
    }
    if (!Number.isSafeInteger(response.id)) {
      this.fail(new SpiderKitSimProtocolError('INVALID_RESPONSE', 'SpiderKit Sim response id must be an integer'))
      return
    }
    const request = this.pending.get(response.id)
    if (!request) {
      this.fail(
        new SpiderKitSimProtocolError('UNEXPECTED_RESPONSE', `Unexpected SpiderKit Sim response id ${response.id}`)
      )
      return
    }
    this.pending.delete(response.id)
    clearTimeout(request.timeout)
    if (response.command !== request.command) {
      const error = new SpiderKitSimProtocolError(
        'COMMAND_MISMATCH',
        'SpiderKit Sim replied to the wrong command'
      )
      request.reject(error)
      this.fail(error)
      return
    }
    if (response.ok !== true) {
      request.reject(protocolReplyError(response.error))
      return
    }
    try {
      request.resolve(validateRunnerStatus(response.status))
    } catch (error) {
      request.reject(error as Error)
      this.fail(error as Error)
    }
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = error
    for (const [id, request] of this.pending) {
      this.pending.delete(id)
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.onFatal(error)
  }
}

export function validateRunnerStatus(value: unknown): SimulationRunnerStatus {
  if (!isRecord(value)) throw new SpiderKitSimProtocolError('INVALID_STATUS', 'SpiderKit Sim status is missing')
  if (!['INITIALIZED', 'RUNNING', 'PAUSED', 'STOPPED', 'FAILED'].includes(value.state)) {
    throw new SpiderKitSimProtocolError('INVALID_STATUS', 'SpiderKit Sim status.state is invalid')
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw new SpiderKitSimProtocolError('INVALID_STATUS', 'SpiderKit Sim status.id is invalid')
  }
  for (const key of ['tick', 'timeSeconds', 'dtSeconds', 'rateHz'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new SpiderKitSimProtocolError('INVALID_STATUS', `SpiderKit Sim status.${key} is invalid`)
    }
  }
  return value as SimulationRunnerStatus
}

function protocolReplyError(value: unknown): SpiderKitSimProtocolError {
  const fallback: SimulationErrorInfo = {
    code: 'SPIDERKIT_SIM_ERROR',
    message: 'SpiderKit Sim rejected the command'
  }
  const error = isRecord(value) ? value : fallback
  const code = typeof error.code === 'string' ? error.code : fallback.code
  const message = typeof error.message === 'string' ? error.message : fallback.message
  return new SpiderKitSimProtocolError(code, message)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

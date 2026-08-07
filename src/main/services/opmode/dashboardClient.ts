import { isIP } from 'node:net'
import { z } from 'zod'
import type {
  RobotOpModeControlRequest,
  RobotOpModeControlResult,
  RobotOpModeStatus
} from '../../../shared/types/opmode'

export const FTC_WEB_PORT = 8080
export const OPMODE_API_ROOT = '/dash/api/v1/opmode'
export const OPMODE_LEASE_PATH = `${OPMODE_API_ROOT}/lease`
export const OPMODE_STATUS_PATH = `${OPMODE_API_ROOT}/status`
export const OPMODE_CONTROL_PATH = `${OPMODE_API_ROOT}/control`

const DEFAULT_REQUEST_TIMEOUT_MS = 800
const MAX_RESPONSE_BYTES = 1024 * 1024

const LeaseResponseSchema = z.object({
  protocolVersion: z.literal(1),
  leaseToken: z.string().min(16).max(1024),
  leaseExpiresInMs: z.number().int().positive().max(5_000),
  dashboardEnabled: z.boolean(),
  agentControlArmed: z.boolean(),
  robotAvailable: z.boolean()
})

const RobotStatusSchema = z.object({
  protocolVersion: z.literal(1),
  dashboardEnabled: z.boolean(),
  agentControlArmed: z.boolean(),
  robotAvailable: z.boolean(),
  accessEnabled: z.boolean(),
  activeOpMode: z.string().nullable(),
  activeOpModeStatus: z.enum(['STOPPED', 'INIT', 'RUNNING']),
  opModes: z.array(
    z.object({
      name: z.string(),
      group: z.string()
    })
  ),
  nonce: z.string().min(16).max(1024).nullable(),
  nonceExpiresInMs: z.number().int().positive().max(60_000).nullable()
})

const ControlResultSchema = z.object({
  accepted: z.literal(true),
  action: z.enum(['init', 'start', 'stop']),
  opModeName: z.string().optional()
})

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  })
})

export type DashboardLeaseResponse = z.infer<typeof LeaseResponseSchema>

export class DashboardApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'DashboardApiError'
  }
}

/** Convert an ADB target such as `192.168.43.1:5555` to the FTC web server origin. */
export function dashboardOriginFromAdbAddress(adbAddress: string): string {
  const input = adbAddress.trim()
  if (!input) throw new DashboardApiError(null, 'INVALID_ADB_ADDRESS', 'The ADB address is empty')

  let hostname: string
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      throw new DashboardApiError(null, 'INVALID_ADB_ADDRESS', `Invalid ADB address: ${input}`)
    }
    hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  } else {
    const bracketed = /^\[([^\]]+)](?::(\d+))?$/.exec(input)
    if (bracketed) {
      hostname = bracketed[1]
    } else if (isIP(input) === 6) {
      hostname = input
    } else {
      const hostAndPort = /^([^:/?#\s]+)(?::(\d+))?$/.exec(input)
      if (!hostAndPort) {
        throw new DashboardApiError(null, 'INVALID_ADB_ADDRESS', `Invalid ADB address: ${input}`)
      }
      hostname = hostAndPort[1]
    }
  }

  if (!hostname || /[/?#@\s]/.test(hostname)) {
    throw new DashboardApiError(null, 'INVALID_ADB_ADDRESS', `Invalid ADB host: ${hostname || input}`)
  }
  const urlHost = isIP(hostname) === 6 ? `[${hostname}]` : hostname
  return `http://${urlHost}:${FTC_WEB_PORT}`
}

export class DashboardOpModeClient {
  constructor(
    readonly origin: string,
    private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ) {}

  async acquireLease(sequence: number): Promise<DashboardLeaseResponse> {
    const value = await this.request(OPMODE_LEASE_PATH, {
      method: 'POST',
      body: { sequence }
    })
    return this.parse(LeaseResponseSchema, value, 'lease response')
  }

  async renewLease(token: string, sequence: number): Promise<DashboardLeaseResponse> {
    const value = await this.request(OPMODE_LEASE_PATH, {
      method: 'POST',
      token,
      body: { sequence }
    })
    return this.parse(LeaseResponseSchema, value, 'lease response')
  }

  async releaseLease(token: string): Promise<void> {
    await this.request(OPMODE_LEASE_PATH, { method: 'DELETE', token })
  }

  async getRobotStatus(token: string): Promise<RobotOpModeStatus> {
    const value = await this.request(OPMODE_STATUS_PATH, { method: 'GET', token }, 2_000)
    return this.parse(RobotStatusSchema, value, 'robot status')
  }

  async controlOpMode(
    token: string,
    request: RobotOpModeControlRequest
  ): Promise<RobotOpModeControlResult> {
    const value = await this.request(
      OPMODE_CONTROL_PATH,
      { method: 'POST', token, body: request },
      2_000
    )
    return this.parse(ControlResultSchema, value, 'control response')
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      throw new DashboardApiError(
        null,
        'INVALID_DASHBOARD_RESPONSE',
        `FTC Dashboard returned an invalid ${label}`
      )
    }
    return parsed.data
  }

  private async request(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'DELETE'
      token?: string
      body?: unknown
    },
    timeoutMs = this.timeoutMs
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(new URL(path, this.origin), {
        method: options.method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      })
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new DashboardApiError(response.status, 'RESPONSE_TOO_LARGE', 'FTC Dashboard response was too large')
      }

      let value: unknown = {}
      if (text) {
        try {
          value = JSON.parse(text)
        } catch {
          throw new DashboardApiError(
            response.status,
            'INVALID_DASHBOARD_RESPONSE',
            `FTC Dashboard returned non-JSON HTTP ${response.status}`
          )
        }
      }

      if (!response.ok) {
        const parsed = ErrorResponseSchema.safeParse(value)
        throw new DashboardApiError(
          response.status,
          parsed.success ? parsed.data.error.code : `HTTP_${response.status}`,
          parsed.success ? parsed.data.error.message : `FTC Dashboard returned HTTP ${response.status}`
        )
      }
      return value
    } catch (error) {
      if (error instanceof DashboardApiError) throw error
      if (controller.signal.aborted) {
        throw new DashboardApiError(null, 'DASHBOARD_TIMEOUT', 'FTC Dashboard request timed out')
      }
      throw new DashboardApiError(
        null,
        'DASHBOARD_UNREACHABLE',
        error instanceof Error ? error.message : 'FTC Dashboard is unreachable'
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}

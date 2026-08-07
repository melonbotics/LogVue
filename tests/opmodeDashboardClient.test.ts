import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DashboardApiError,
  DashboardOpModeClient,
  dashboardOriginFromAdbAddress
} from '../src/main/services/opmode/dashboardClient'
import { LOGVUE_MCP_TOOLS } from '../src/shared/mcp/tools'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('FTC Dashboard OpMode client', () => {
  it.each([
    ['192.168.43.1:5555', 'http://192.168.43.1:8080'],
    ['control-hub.local:5555', 'http://control-hub.local:8080'],
    ['[fe80::1234]:5555', 'http://[fe80::1234]:8080'],
    ['fe80::1234', 'http://[fe80::1234]:8080'],
    ['http://192.168.43.1:5555', 'http://192.168.43.1:8080']
  ])('derives the FTC web origin from %s', (input, expected) => {
    expect(dashboardOriginFromAdbAddress(input)).toBe(expected)
  })

  it('rejects path-like ADB targets', () => {
    expect(() => dashboardOriginFromAdbAddress('192.168.43.1:5555/dash')).toThrow(DashboardApiError)
  })

  it('uses a private bearer lease and does not renew it from status or control calls', async () => {
    const seen: Array<{ method: string; path: string; authorization?: string; body: unknown }> = []
    const origin = await startJsonServer(async (req, res, body) => {
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body
      })
      if (req.url?.endsWith('/lease') && req.method === 'POST') {
        sendJson(res, 200, {
          protocolVersion: 1,
          leaseToken: 'robot-private-lease-token-123456',
          leaseExpiresInMs: 5000,
          dashboardEnabled: true,
          agentControlArmed: true,
          robotAvailable: true
        })
      } else if (req.url?.endsWith('/lease') && req.method === 'DELETE') {
        sendJson(res, 200, { released: true })
      } else if (req.url?.endsWith('/status')) {
        sendJson(res, 200, {
          protocolVersion: 1,
          dashboardEnabled: true,
          agentControlArmed: true,
          robotAvailable: true,
          accessEnabled: true,
          activeOpMode: null,
          activeOpModeStatus: 'STOPPED',
          opModes: [{ name: 'Drive Test', group: 'Test' }],
          nonce: 'fresh-robot-nonce-1234567890',
          nonceExpiresInMs: 10000
        })
      } else if (req.url?.endsWith('/control')) {
        const request = body as { action?: string; opModeName?: string }
        sendJson(res, 202, {
          accepted: true,
          action: request.action,
          ...(request.opModeName ? { opModeName: request.opModeName } : {})
        })
      } else {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
      }
    })
    const client = new DashboardOpModeClient(origin)

    const acquired = await client.acquireLease(0)
    await client.renewLease(acquired.leaseToken, 1)
    const status = await client.getRobotStatus(acquired.leaseToken)
    const controlled = await client.controlOpMode(acquired.leaseToken, {
      nonce: status.nonce as string,
      action: 'init',
      opModeName: 'Drive Test'
    })
    const stopped = await client.controlOpMode(acquired.leaseToken, { action: 'stop' })
    await client.releaseLease(acquired.leaseToken)

    expect(controlled).toEqual({ accepted: true, action: 'init', opModeName: 'Drive Test' })
    expect(stopped).toEqual({ accepted: true, action: 'stop' })
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /dash/api/v1/opmode/lease',
      'POST /dash/api/v1/opmode/lease',
      'GET /dash/api/v1/opmode/status',
      'POST /dash/api/v1/opmode/control',
      'POST /dash/api/v1/opmode/control',
      'DELETE /dash/api/v1/opmode/lease'
    ])
    expect(seen[0]).toMatchObject({ authorization: undefined, body: { sequence: 0 } })
    expect(seen[1]).toMatchObject({
      authorization: `Bearer ${acquired.leaseToken}`,
      body: { sequence: 1 }
    })
    expect(seen[2].authorization).toBe(`Bearer ${acquired.leaseToken}`)
    expect(seen[3]).toMatchObject({
      authorization: `Bearer ${acquired.leaseToken}`,
      body: { nonce: status.nonce, action: 'init', opModeName: 'Drive Test' }
    })
    expect(seen[4]).toMatchObject({
      authorization: `Bearer ${acquired.leaseToken}`,
      body: { action: 'stop' }
    })
    expect(seen[4].body).toEqual({ action: 'stop' })
  })

  it('accepts a status response without a nonce while robot access is gated off', async () => {
    const origin = await startJsonServer(async (_req, res) => {
      sendJson(res, 200, {
        protocolVersion: 1,
        dashboardEnabled: true,
        agentControlArmed: false,
        robotAvailable: true,
        accessEnabled: false,
        activeOpMode: null,
        activeOpModeStatus: 'STOPPED',
        opModes: [],
        nonce: null,
        nonceExpiresInMs: null
      })
    })
    const client = new DashboardOpModeClient(origin)
    const status = await client.getRobotStatus('private-lease-token-1234567890')
    expect(status.nonce).toBeNull()
    expect(status.accessEnabled).toBe(false)
  })

  it('preserves structured dashboard errors', async () => {
    const origin = await startJsonServer(async (_req, res) => {
      sendJson(res, 409, { error: { code: 'LEASE_HELD', message: 'Another lease is active' } })
    })
    const client = new DashboardOpModeClient(origin)
    await expect(client.acquireLease(0)).rejects.toMatchObject({
      name: 'DashboardApiError',
      status: 409,
      code: 'LEASE_HELD',
      message: 'Another lease is active'
    })
  })

  it('rejects a robot lease longer than the five-second safety contract', async () => {
    const origin = await startJsonServer(async (_req, res) => {
      sendJson(res, 200, {
        protocolVersion: 1,
        leaseToken: 'robot-private-lease-token-123456',
        leaseExpiresInMs: 5001,
        dashboardEnabled: true,
        agentControlArmed: true,
        robotAvailable: true
      })
    })
    const client = new DashboardOpModeClient(origin)
    await expect(client.acquireLease(0)).rejects.toMatchObject({
      code: 'INVALID_DASHBOARD_RESPONSE'
    })
  })
})

describe('OpMode MCP schema', () => {
  it('requires a nonce for init/start and forbids one for stop', () => {
    const schema = LOGVUE_MCP_TOOLS.controlOpMode.config.inputSchema
    expect(LOGVUE_MCP_TOOLS.getRobotStatus.config.annotations.readOnlyHint).toBe(false)
    expect(schema.safeParse({ nonce: '1234567890123456', action: 'init' }).success).toBe(false)
    expect(
      schema.safeParse({ nonce: '1234567890123456', action: 'init', opModeName: 'Drive Test' }).success
    ).toBe(true)
    expect(schema.safeParse({ action: 'start' }).success).toBe(false)
    expect(schema.safeParse({ nonce: '1234567890123456', action: 'start' }).success).toBe(true)
    expect(
      schema.safeParse({ nonce: '1234567890123456', action: 'start', opModeName: 'Drive Test' }).success
    ).toBe(false)
    expect(schema.safeParse({ action: 'stop' }).success).toBe(true)
    expect(schema.safeParse({ nonce: '1234567890123456', action: 'stop' }).success).toBe(false)
    expect(schema.safeParse({ action: 'stop', opModeName: 'Drive Test' }).success).toBe(false)
  })
})

async function startJsonServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>
): Promise<string> {
  const server = createServer((req, res) => {
    void readJsonBody(req).then((body) => handler(req, res, body))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

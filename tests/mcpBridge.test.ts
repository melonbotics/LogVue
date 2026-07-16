import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createLogVueMcpBridge } from '../src/mcp-bridge/bridge'
import { LOGVUE_MCP_TOOLS } from '../src/shared/mcp/tools'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('LogVue MCP bridge', () => {
  it('initializes and lists tools without reading a live LogVue endpoint', async () => {
    const discoveryPath = join(temporaryDirectory(), 'missing-mcp.json')
    const { bridge, client } = await connectToBridge(discoveryPath)

    try {
      const listed = await client.listTools()
      expect(listed.tools.map(({ name }) => name)).toEqual([
        'get_status',
        'list_hub_logs',
        'create_session',
        'import_hub_log'
      ])

      const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_status', arguments: {} }))
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('LogVue is unavailable. Start LogVue and retry this tool call.')
      })
    } finally {
      await client.close()
      await bridge.close()
    }
  })

  it('discovers and forwards a tool call only when the tool is invoked', async () => {
    const token = 'test-token-that-is-at-least-32-characters-long'
    const authorizations: Array<string | undefined> = []
    const discoveryPath = join(temporaryDirectory(), 'mcp.json')
    const upstream = createServer((req, res) => {
      authorizations.push(req.headers.authorization)
      void handleUpstreamRequest(req, res)
    })
    const { bridge, client } = await connectToBridge(discoveryPath)
    try {
      expect(authorizations).toEqual([])
      await client.listTools()
      expect(authorizations).toEqual([])

      await new Promise<void>((resolve, reject) => {
        upstream.once('error', reject)
        upstream.listen(0, '127.0.0.1', resolve)
      })
      const port = (upstream.address() as AddressInfo).port
      writeFileSync(
        discoveryPath,
        JSON.stringify({ version: 1, port, path: '/mcp', token }),
        'utf8'
      )

      const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_status', arguments: {} }))
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({ online: true })
      expect(authorizations.length).toBeGreaterThan(0)
      expect(authorizations.every((header) => header === `Bearer ${token}`)).toBe(true)
    } finally {
      await client.close()
      await bridge.close()
      if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'logvue-mcp-bridge-'))
  temporaryPaths.push(path)
  return path
}

async function connectToBridge(discoveryPath: string): Promise<{ bridge: McpServer; client: Client }> {
  const bridge = createLogVueMcpBridge(discoveryPath)
  const client = new Client({ name: 'logvue-bridge-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await bridge.connect(serverTransport)
  await client.connect(clientTransport)
  return { bridge, client }
}

async function handleUpstreamRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url !== '/mcp' || req.method !== 'POST') {
    res.writeHead(404).end()
    return
  }

  const server = new McpServer({ name: 'logvue-test-upstream', version: '1.0.0' })
  server.registerTool(
    LOGVUE_MCP_TOOLS.getStatus.name,
    LOGVUE_MCP_TOOLS.getStatus.config,
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ online: true }) }],
      structuredContent: { online: true }
    })
  )
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await transport.close()
    await server.close()
  }
  res.once('close', () => void close())
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}

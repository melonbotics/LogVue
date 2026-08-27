import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { LOGVUE_MCP_INSTRUCTIONS, LOGVUE_MCP_TOOLS } from '../shared/mcp/tools'

const BRIDGE_VERSION = '1.0.0'
const CONNECT_TIMEOUT_MS = 3_000
const TOOL_TIMEOUT_MS = 30 * 60_000

const Discovery = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65535),
  path: z.string().startsWith('/'),
  token: z.string().min(32)
})

/**
 * Create an MCP server that is always available to its stdio client. The
 * Electron app is discovered and contacted only from a tool handler.
 */
export function createLogVueMcpBridge(discoveryPath: string): McpServer {
  const bridge = new McpServer(
    { name: 'logvue', version: BRIDGE_VERSION },
    { instructions: LOGVUE_MCP_INSTRUCTIONS }
  )

  bridge.registerTool(LOGVUE_MCP_TOOLS.getStatus.name, LOGVUE_MCP_TOOLS.getStatus.config, async (_args, extra) =>
    forwardToolCall(discoveryPath, LOGVUE_MCP_TOOLS.getStatus.name, {}, extra.signal)
  )

  bridge.registerTool(
    LOGVUE_MCP_TOOLS.listHubLogs.name,
    LOGVUE_MCP_TOOLS.listHubLogs.config,
    async (args, extra) => forwardToolCall(discoveryPath, LOGVUE_MCP_TOOLS.listHubLogs.name, args, extra.signal)
  )

  bridge.registerTool(
    LOGVUE_MCP_TOOLS.createSession.name,
    LOGVUE_MCP_TOOLS.createSession.config,
    async (args, extra) => forwardToolCall(discoveryPath, LOGVUE_MCP_TOOLS.createSession.name, args, extra.signal)
  )

  bridge.registerTool(
    LOGVUE_MCP_TOOLS.importHubLog.name,
    LOGVUE_MCP_TOOLS.importHubLog.config,
    async (args, extra) => forwardToolCall(discoveryPath, LOGVUE_MCP_TOOLS.importHubLog.name, args, extra.signal)
  )

  bridge.registerTool(
    LOGVUE_MCP_TOOLS.getRobotStatus.name,
    LOGVUE_MCP_TOOLS.getRobotStatus.config,
    async (_args, extra) =>
      forwardToolCall(discoveryPath, LOGVUE_MCP_TOOLS.getRobotStatus.name, {}, extra.signal)
  )

  bridge.registerTool(
    LOGVUE_MCP_TOOLS.controlOpMode.name,
    LOGVUE_MCP_TOOLS.controlOpMode.config,
    async (args, extra) =>
      forwardToolCall(discoveryPath, LOGVUE_MCP_TOOLS.controlOpMode.name, args, extra.signal)
  )

  return bridge
}

async function forwardToolCall(
  discoveryPath: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<CallToolResult> {
  let client: Client | undefined
  try {
    const discovery = readDiscovery(discoveryPath)
    const host = await findLogVueHost(discovery.port)
    const url = new URL(`http://${host}:${discovery.port}${discovery.path}`)
    const http = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } }
    })
    client = new Client({ name: 'logvue-stdio-bridge', version: BRIDGE_VERSION })
    await client.connect(http, { signal, timeout: CONNECT_TIMEOUT_MS })
    const forwarded = await client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: TOOL_TIMEOUT_MS }
    )
    const parsed = CallToolResultSchema.safeParse(forwarded)
    if (!parsed.success) throw new Error('LogVue returned an unsupported task result')
    return parsed.data
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`LogVue is unavailable. Start LogVue and retry this tool call. ${detail}`)
  } finally {
    await client?.close().catch(() => undefined)
  }
}

function readDiscovery(discoveryPath: string): z.infer<typeof Discovery> {
  if (!existsSync(discoveryPath)) {
    throw new Error(`Connection details were not found at ${discoveryPath}`)
  }
  return Discovery.parse(JSON.parse(readFileSync(discoveryPath, 'utf8')))
}

async function findLogVueHost(port: number): Promise<string> {
  if (await portIsOpen('127.0.0.1', port)) return '127.0.0.1'

  const windowsHost = windowsHostFromDefaultRoute()
  if (await portIsOpen(windowsHost, port)) return windowsHost

  throw new Error('The MCP endpoint is not reachable')
}

function windowsHostFromDefaultRoute(): string {
  if (!isWsl()) throw new Error('The MCP endpoint is not reachable on loopback')
  const output = execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' })
  const gateway = /\bvia\s+(\S+)/.exec(output)?.[1]
  if (!gateway) throw new Error('Could not discover the Windows host from the WSL default route')
  return gateway
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'))
  } catch {
    return false
  }
}

function portIsOpen(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port })
    const finish = (open: boolean) => {
      socket.destroy()
      done(open)
    }
    socket.setTimeout(350, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

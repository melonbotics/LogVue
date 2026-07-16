import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { getSettings } from '../config/settings'
import { createSessionCommand } from '../commands'
import { listHubLogs } from '../services/adb/hublogs'
import { getAdbClient } from '../services/adb/runtime'
import { readMetadata } from '../services/archive/SessionStore'
import { runSingleImportTask } from '../services/import/importTask'
import { INTERNAL_DIR } from '../services/archive/paths'
import { LOGVUE_MCP_INSTRUCTIONS, LOGVUE_MCP_TOOLS } from '@shared/mcp/tools'
import type { McpStatus } from '@shared/types/ipc'

export const MCP_HOST = '0.0.0.0'
export const MCP_PORT = 47831
export const MCP_PATH = '/mcp'
export const MCP_DISCOVERY_FILE = 'mcp.json'
export const MCP_BRIDGE_FILE = 'logvue-mcp.cjs'

let httpServer: HttpServer | null = null
let bearerToken: string | null = null
let discoveryPath: string | null = null
let lastRequestAt: string | null = null

function mcpDataPath(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'LogVue', 'MCP')
  }
  return join(app.getPath('userData'), 'MCP')
}

function appDiscoveryPath(): string {
  return join(mcpDataPath(), MCP_DISCOVERY_FILE)
}

function appBridgePath(): string {
  return join(mcpDataPath(), MCP_BRIDGE_FILE)
}

function loadStableBearerToken(): string {
  const candidates = [appDiscoveryPath(), join(app.getPath('userData'), MCP_DISCOVERY_FILE)]
  const archiveRoot = getSettings().archiveRoot
  if (archiveRoot) candidates.push(join(archiveRoot, INTERNAL_DIR, MCP_DISCOVERY_FILE))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { token?: unknown }
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed.token
    } catch {
      // Try the next location, then generate a new credential below.
    }
  }
  return randomBytes(32).toString('base64url')
}

export function getMcpStatus(): McpStatus {
  const path = discoveryPath ?? appDiscoveryPath()
  return {
    running: httpServer !== null,
    discoveryReady: existsSync(path),
    bridgeReady: existsSync(appBridgePath()),
    endpoint: `http://127.0.0.1:${MCP_PORT}${MCP_PATH}`,
    discoveryPath: path,
    bridgePath: appBridgePath(),
    lastRequestAt
  }
}

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  }
}

function archivePath(input: string | undefined, requireSession: boolean): { root: string; path: string } {
  const configuredRoot = getSettings().archiveRoot
  if (!configuredRoot) throw new Error('No LogVue archive root is configured')
  const root = resolve(configuredRoot)
  const normalized = normalizeAgentPath(input?.trim() || '.')
  const path = normalized === '.' ? root : resolve(isAbsolute(normalized) ? normalized : join(root, normalized))
  const fromRoot = relative(root, path)
  if (fromRoot.startsWith('..') || resolve(root, fromRoot) !== path) {
    throw new Error('Path must identify a folder within the configured archive root')
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Archive folder does not exist: ${path}`)
  if (requireSession && (!fromRoot || !readMetadata(path))) throw new Error(`No session.json found at ${path}`)
  return { root, path }
}

/** Accept the /mnt/c/... spelling commonly supplied by WSL agents to the Windows app. */
function normalizeAgentPath(input: string): string {
  const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(input.replace(/\\/g, '/'))
  return wsl ? `${wsl[1].toUpperCase()}:\\${(wsl[2] ?? '').replace(/\//g, '\\')}` : input
}

function createLogVueMcpServer(appVersion: string): McpServer {
  const server = new McpServer(
    { name: 'logvue', version: appVersion },
    { instructions: LOGVUE_MCP_INSTRUCTIONS }
  )

  server.registerTool(
    LOGVUE_MCP_TOOLS.getStatus.name,
    LOGVUE_MCP_TOOLS.getStatus.config,
    async () => result({ settings: getSettings(), adb: await getAdbClient().getStatus(), mcp: getMcpStatus() })
  )

  server.registerTool(
    LOGVUE_MCP_TOOLS.listHubLogs.name,
    LOGVUE_MCP_TOOLS.listHubLogs.config,
    async ({ limit }) => {
      const root = getSettings().archiveRoot
      const logs = await listHubLogs(getAdbClient(), root)
      return result({ logs: logs.slice(0, limit), returned: Math.min(logs.length, limit), total: logs.length })
    }
  )

  server.registerTool(
    LOGVUE_MCP_TOOLS.createSession.name,
    LOGVUE_MCP_TOOLS.createSession.config,
    async ({ parentPath, displayName, sessionType }) => {
      const { root, path: resolvedParent } = archivePath(parentPath, false)
      const session = createSessionCommand(root, {
        parentPath: resolvedParent,
        displayName,
        sessionType
      })
      return result({ session, archiveRelativePath: relative(root, session.path) })
    }
  )

  server.registerTool(
    LOGVUE_MCP_TOOLS.importHubLog.name,
    LOGVUE_MCP_TOOLS.importHubLog.config,
    async ({ remotePath, sessionPath: inputPath, force }) => {
      const { root, path: sessionPath } = archivePath(inputPath, true)
      const remote = (await listHubLogs(getAdbClient(), root)).find((log) => log.remote_path === remotePath)
      if (!remote) throw new Error(`Control Hub log is no longer available: ${remotePath}`)
      const imported = await runSingleImportTask(getAdbClient(), root, {
        remotePath: remote.remote_path,
        filename: remote.filename,
        fileSize: remote.file_size_bytes,
        recordedAt: remote.parsed_timestamp,
        sessionPath,
        force
      })
      return result({ result: imported })
    }
  )

  return server
}

export async function startMcpServer(appVersion: string): Promise<void> {
  if (httpServer) return
  bearerToken = loadStableBearerToken()
  lastRequestAt = null
  installMcpBridge()

  httpServer = createServer((req, res) => {
    if (req.url !== MCP_PATH) {
      res.writeHead(404).end()
      return
    }
    if (!isAuthorizedRequest(req.socket.remoteAddress, req.headers.origin, req.headers.authorization)) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }))
      return
    }
    lastRequestAt = new Date().toISOString()
    void handleMcpRequest(req, res, appVersion)
  })

  await new Promise<void>((resolveReady, reject) => {
    httpServer?.once('error', reject)
    httpServer?.listen(MCP_PORT, MCP_HOST, () => resolveReady())
  })
  writeDiscoveryFile(bearerToken)
  console.info(`LogVue MCP server listening on port ${MCP_PORT} (loopback + authenticated WSL access)`)
}

/** Publish a dependency-bundled bridge at a stable path outside the app install. */
function installMcpBridge(): void {
  const packagedSource = join(__dirname, 'mcpBridge.js')
  const developmentSource = join(__dirname, '../mcp/mcpBridge.js')
  const source = !app.isPackaged && existsSync(developmentSource) ? developmentSource : packagedSource
  const destination = appBridgePath()
  mkdirSync(mcpDataPath(), { recursive: true })
  copyFileSync(source, destination)
  try {
    chmodSync(destination, 0o700)
  } catch {
    // Windows does not implement POSIX executable permissions.
  }
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  appVersion: string
): Promise<void> {
  const server = createLogVueMcpServer(appVersion)
  const requestTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await requestTransport.close()
    await server.close()
  }
  res.once('close', () => void close())
  try {
    await server.connect(requestTransport)
    await requestTransport.handleRequest(req, res)
  } catch (error) {
    console.error('LogVue MCP request failed:', error)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end()
  }
}

function isAuthorizedRequest(
  remoteAddress: string | undefined,
  originHeader: string | undefined,
  authorizationHeader: string | undefined
): boolean {
  const loopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  if (loopback) return !originHeader || isLoopbackHostname(originHeader)
  if (originHeader || !bearerToken) return false
  const supplied = authorizationHeader?.match(/^Bearer (.+)$/i)?.[1]
  if (!supplied) return false
  const actual = Buffer.from(bearerToken)
  const candidate = Buffer.from(supplied)
  return actual.length === candidate.length && timingSafeEqual(actual, candidate)
}

function isLoopbackHostname(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

function writeDiscoveryFile(token: string): void {
  const nextPath = appDiscoveryPath()
  mkdirSync(mcpDataPath(), { recursive: true })
  writeFileSync(
    nextPath,
    JSON.stringify({ version: 1, port: MCP_PORT, path: MCP_PATH, token, pid: process.pid }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 }
  )
  discoveryPath = nextPath
}

/** Recreate the app-level discovery file without changing the stable credential. */
export function refreshMcpDiscoveryFile(): void {
  if (!httpServer || !bearerToken) return
  if (discoveryPath) rmSync(discoveryPath, { force: true })
  discoveryPath = null
  writeDiscoveryFile(bearerToken)
}

export async function stopMcpServer(): Promise<void> {
  discoveryPath = null
  const currentHttp = httpServer
  httpServer = null
  await new Promise<void>((resolveClosed) => {
    if (!currentHttp) return resolveClosed()
    currentHttp.close(() => resolveClosed())
  })
  bearerToken = null
  lastRequestAt = null
}

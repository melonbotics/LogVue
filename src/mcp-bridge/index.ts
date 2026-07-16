import { dirname, join, resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createLogVueMcpBridge } from './bridge'

async function main(): Promise<void> {
  // LogVue installs this bridge beside mcp.json. Retain the optional argument
  // for compatibility with configurations created by the prototype.
  const discoveryPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(dirname(resolve(process.argv[1])), 'mcp.json')

  const bridge = createLogVueMcpBridge(discoveryPath)
  await bridge.connect(new StdioServerTransport())
}

void main().catch((error) => {
  console.error('LogVue MCP bridge failed to initialize:', error)
  process.exit(1)
})

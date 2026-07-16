# LogVue MCP integration

While the LogVue desktop application is running, it exposes an MCP Streamable HTTP endpoint. Windows-native and WSL mirrored-network clients can use:

```text
http://127.0.0.1:47831/mcp
```

The server is hosted by Electron's main process. MCP-triggered imports therefore use the same ADB client, archive services, index, and Activity task registry as renderer-triggered imports. Non-loopback requests require the stable random bearer token written beside the installed bridge in LogVue's per-user MCP directory.

## One-time client configuration

Each time it starts, LogVue installs a dependency-bundled stdio bridge at a stable per-user path beside `mcp.json`:

```text
Windows: %LOCALAPPDATA%\LogVue\MCP\logvue-mcp.cjs
macOS:   ~/Library/Application Support/LogVue/MCP/logvue-mcp.cjs
Linux:   <Electron userData>/MCP/logvue-mcp.cjs
```

Add that file to any MCP-compatible client as a local stdio server with command `node` and the bridge path as its only argument. The MCP setup dialog shows the exact path and provides generic server JSON plus optional Codex and Claude Code commands. No token or discovery-file argument is required.

The bridge starts and advertises LogVue's tool contract without contacting the desktop app. It reads `mcp.json` and probes loopback or the Windows host used by WSL only when a LogVue tool is called. Consequently, an installed connector stays quiet while LogVue is closed; an attempted tool call returns a normal MCP tool error telling the caller to start LogVue.

The configuration remains stable across LogVue updates, library changes, and WSL networking changes. A bridge that was initialized while LogVue was closed can use the app after it opens without being restarted. In WSL, use the `/mnt/<drive>/...` spelling shown by the setup dialog. On each tool call, the bridge tries loopback first and only uses WSL default-route discovery when loopback is unavailable.

## Tools

- `get_status`: configured archive, MCP endpoint, and ADB status.
- `list_hub_logs`: newest RLOG files available from the configured Control Hub or folder source (20 by default, up to 100).
- `create_session`: creates a schema-valid session at the archive root or beneath an existing folder.
- `import_hub_log`: imports one listed remote log into an existing archive session.

Reading, navigation, grep, notes and metadata editing, and bulk analysis remain filesystem-native. LogVue's archive watcher refreshes the index and renderer after direct file edits. MCP is intentionally limited to LogVue-owned imports and live Control Hub access.

## Testing

For an agent-driven smoke test and optional end-to-end test, see
[`doc/mcp-agent-test.md`](doc/mcp-agent-test.md).

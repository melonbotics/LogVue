# LogVue MCP integration

While the LogVue desktop application is running, it exposes an MCP Streamable HTTP endpoint. Windows-native and WSL mirrored-network clients can use:

```text
http://127.0.0.1:47831/mcp
```

The server is hosted by Electron's main process. MCP-triggered imports therefore use the same ADB client, archive services, index, and Activity task registry as renderer-triggered imports. Every HTTP request, including loopback, requires a fresh random 256-bit bearer token minted for that LogVue launch and written beside the installed bridge in LogVue's per-user MCP directory. The bridge rereads and supplies it automatically; the token is never recovered from archive content or exposed through MCP or the renderer.

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
- `get_robot_status`: returns current FTC Dashboard/OpMode state and, only when all safety gates are effective, a fresh short-lived nonce.
- `control_opmode`: initializes or starts an OpMode using the nonce from the immediately preceding `get_robot_status` call, or stops the exact lease-owned OpMode without a nonce.

Reading, navigation, grep, notes and metadata editing, and bulk analysis remain filesystem-native. LogVue's archive watcher refreshes the index and renderer after direct file edits. MCP is intentionally limited to LogVue-owned imports and live Control Hub access.

## Agent OpMode control safety

Agent OpMode control always starts disabled when LogVue launches. An operator must enable it from the MCP setup dialog while the Control Hub ADB source is selected. While enabled, a red toolbar indicator remains visible and doubles as an immediate disable control. Closing, losing, or hanging the renderer also revokes the operator gate. Enabling starts a private lease with the FTC Dashboard hook at the host from the configured ADB address on port `8080`. Independently, use the Driver Station to run `Enable/Disable Agent OpMode Control` from the `Dashboard` group and press Start to arm the robot-side gate.

Lease acquisition and one-second heartbeats run in a dedicated worker thread. This keeps them alive while Electron's main thread performs synchronous archive or index work. The robot expires the lease after five seconds without a heartbeat and stops an OpMode owned by that lease. If LogVue observes a lost or expired lease, or the configured Control Hub target changes, it latches control off and never silently reacquires after a previously established lease. Explicitly disabling control releases the lease immediately.

The robot lease credential remains only inside the worker. It is never persisted, logged, returned to an MCP caller, or exposed to the renderer. UI health polling reads only cached heartbeat metadata and cannot mint a nonce. `get_robot_status` and `control_opmode` do not renew the lease.

The robot-side lease and nonce provide ownership, freshness, and fail-safe behavior; they are not a substitute for an isolated robot network. The Dashboard hook uses HTTP on the Control Hub, and FTC Dashboard's existing WebSocket control channel remains separate. Keep the Control Hub network trusted and do not expose its web ports beyond that network.

Every `init` or `start` transition needs a new status read and consumes its nonce. `stop` never fetches, accepts, or consumes a nonce; it still requires the active LogVue lease and can only stop the exact OpMode instance owned by that lease. When `accessEnabled` is false, status still returns the robot state but `nonce` and `nonceExpiresInMs` are `null`. Never attempt robot control unless the robot is physically secured, the field is clear, and a human is ready to stop it from the Driver Station.

Initialization is asynchronous: an accepted `init` means it was queued. Poll `get_robot_status` until `activeOpMode` exactly matches the requested name and `activeOpModeStatus` is `INIT`, then use the fresh nonce from that confirming response for `start`. The independent worker heartbeat continues throughout this wait.

## Testing

For an agent-driven smoke test and optional end-to-end test, see
[`doc/mcp-agent-test.md`](doc/mcp-agent-test.md).

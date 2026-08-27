# MCP integration

## Purpose

LogVue's MCP surface is intentionally action-oriented. Agents already navigate the archive, read `session.json`, patch `notes.md`, grep text, and analyse logs effectively through the filesystem. MCP exists for operations that must go through the running application:

- discover live or folder-backed hub logs;
- create sessions using LogVue's naming and schema rules;
- import logs through LogVue's duplicate detection, Activity task, metadata, and indexing pipeline.
- inspect and, with explicit operator and robot-side permission, control the FTC OpMode lifecycle.

Do not duplicate general filesystem search or file-editing tools in MCP.

## Architecture

The Electron main process hosts a stateless Streamable HTTP MCP server on port `47831`. Each HTTP POST receives a fresh MCP server and transport, as required by the SDK's stateless lifecycle.

All MCP clients use the same local stdio bridge. The bridge handles MCP initialization and tool listing locally, then connects on demand for a tool call. It connects over loopback on Windows, macOS, Linux, and mirrored-network WSL. In WSL NAT mode it falls back to the Windows host:

```text
MCP client
  -> stdio MCP
  -> <stable user-data>/MCP/logvue-mcp.cjs
  -> authenticated Streamable HTTP
  -> LogVue Electron main process
```

LogVue requires a fresh random 256-bit bearer token for every HTTP request, including loopback. A new credential is minted on each LogVue launch, written only to the per-user connection file, and never adopted from an archive or other user content. The stdio bridge rereads and supplies it automatically from:

```text
<stable user-data>/MCP/mcp.json
```

The active archive is not part of the bridge configuration. Agents discover it from `get_status`, and all archive tools follow the library currently selected in LogVue.

The bridge and discovery file live together. The bridge does not read discovery or probe the endpoint during MCP client startup. When a tool is invoked, it rereads discovery (including the current launch's credential), tries `127.0.0.1` first, and only reads WSL's default route when it is actually running under WSL. LogVue refreshes the dependency-bundled bridge on every start.

The credential is not returned by MCP or exposed to the renderer. Browser-style requests are additionally restricted by Origin: loopback peers may use only loopback origins, while non-loopback WSL requests must omit Origin.

## Client installation

Start LogVue and open its MCP setup dialog. Add the displayed bridge as a local stdio server using the generic configuration:

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["<displayed path>/logvue-mcp.cjs"]
}
```

Client-specific shortcuts configure those same stdio details:

```sh
codex mcp add logvue -- node "<displayed path>/logvue-mcp.cjs"
claude mcp add --scope user logvue -- node "<displayed path>/logvue-mcp.cjs"
```

Restart the client after initial configuration or tool-schema changes. Configuration is required once per client, not once per library or LogVue version.

When LogVue is closed, the bridge still initializes cleanly and exposes the bundled tool schemas. It contacts the app only if one of those tools is called; that call returns an actionable tool error if the app is unavailable. Opening LogVue later makes subsequent calls work without restarting the MCP client.

## Tool contract

### `get_status`

Returns application settings, MCP endpoint status, and the current ADB/folder-source connection status.

### `list_hub_logs`

Returns newest-first logs from the configured ADB or folder source:

```json
{ "limit": 20 }
```

`limit` defaults to 20 and is restricted to 1–100. Results include `returned` and `total`. Keeping this bounded matters because a development log directory can overwhelm an agent's context.

### `create_session`

Creates a schema-valid session using the same archive service as the UI:

```json
{
  "parentPath": "APOC26",
  "displayName": "Q12 Blue B2",
  "sessionType": "official_match"
}
```

`parentPath` defaults to the archive root and accepts an archive-relative path, Windows absolute path, or WSL `/mnt/<drive>/...` path. Results include the session and `archiveRelativePath`.

### `import_hub_log`

Imports one exact `remote_path` returned by `list_hub_logs`. The remote log is revalidated immediately before import, and the operation uses LogVue's Activity task and index pipeline.

`sessionPath` accepts the same path forms as `create_session`. Set `force` only when deliberately importing another copy after duplicate detection.

### `get_robot_status`

Returns FTC Dashboard availability, the robot-side agent-control gate, active OpMode state, and the registered OpMode list. When Dashboard is enabled, the robot is available, the robot-side gate is armed, and LogVue holds an active operator-enabled lease, the result also contains a fresh ten-second nonce. Otherwise `nonce` and `nonceExpiresInMs` are `null`.

Calling this tool does not renew the robot lease. It is the required first half of every `init` or `start` transition; a newer status call replaces the preceding local nonce. `stop` does not require a status call or nonce.

### `control_opmode`

Requests one exact FTC lifecycle transition:

```json
{
  "nonce": "<unchanged nonce from get_robot_status>",
  "action": "init",
  "opModeName": "Drive Test"
}
```

`action` is `init`, `start`, or `stop`; `opModeName` is required for `init` and must be omitted for `start` and `stop`. For `init` and `start`, the nonce is consumed by the attempt even if the robot rejects the transition, so call `get_robot_status` again before any retry or next nonce-protected transition.

An accepted `init` only means the asynchronous FTC SDK initialization was queued. Poll `get_robot_status` until `activeOpMode` exactly equals the requested name and `activeOpModeStatus` is `INIT`; then issue `start` with the fresh nonce from that confirming status response. An immediate start may be rejected because ownership and lifecycle state have not settled yet. Lease heartbeats continue independently in the worker during polling.

For `stop`, omit both `nonce` and `opModeName`:

```json
{
  "action": "stop"
}
```

Stop does not fetch or consume a nonce, but still requires LogVue's current lease and is restricted to the exact OpMode instance owned by that lease. No control call renews the lease.

### Operator lease

The MCP setup dialog owns a runtime-only operator switch which always defaults off at process start. A persistent red toolbar indicator appears while enabled and can disable control immediately. LogVue also revokes the gate if its renderer closes, exits, fails to load, or becomes unresponsive; access is never intentionally maintained without a working operator UI. Independently, the operator must use the Driver Station to run `Enable/Disable Agent OpMode Control` from the `Dashboard` group and press Start. When enabled with the Control Hub ADB source selected, LogVue derives the robot host from `settings.adbAddress` and talks to FTC web port `8080`. A dedicated worker thread acquires `POST /dash/api/v1/opmode/lease` and sends monotonically sequenced heartbeats every second. The lease token never leaves that worker.

The Dashboard lease expires after five seconds without a successful heartbeat. LogVue uses a monotonic deadline as its own fail-closed check. Once an established lease expires, is rejected, or the configured hub target or source changes, the operator switch latches off and must be manually re-enabled. Explicit disable sends `DELETE /dash/api/v1/opmode/lease`; an abrupt app or host failure is covered by the robot watchdog. Renderer polling reads cached worker health only and therefore cannot request status or mint nonces.

The lease/nonce protocol protects transition freshness and exact ownership, not an untrusted LAN. Robot traffic is HTTP, and FTC Dashboard's pre-existing WebSocket lifecycle controls are a separate channel. Use this only on the isolated Control Hub network and do not publish the robot web ports externally.

## Filesystem responsibilities

Agents should use normal filesystem tools for archive traversal, `session.json`, `notes.md`, grep, bulk analysis, and specialised log inspection. The archive watcher rebuilds the derived index and refreshes the renderer after direct edits.

Agents must not edit LogVue's internal data, including `index.sqlite` and the app-level `mcp.json`.

## Verification

Use the Linux Node installation described in `AGENTS.md`:

```sh
PATH=$HOME/.local/node/bin:$PATH npm run typecheck
PATH=$HOME/.local/node/bin:$PATH npm run build
PATH=$HOME/.local/node/bin:$PATH TZ=UTC npm test
```

The current checkpoint passes the production build, full typecheck, and full test suite.

## Troubleshooting

- Missing `logvue-mcp.cjs`: LogVue has not started the MCP-enabled build on this user profile yet. A missing `mcp.json` does not break client startup, but LogVue tool calls fail until the app recreates it.
- WSL `127.0.0.1` fails in NAT mode: use the stdio bridge rather than the direct HTTP URL.
- HTTP 500 during initialization: ensure each stateless POST creates a fresh MCP server and transport.
- A client still reports an offline startup failure: start the updated LogVue build once to install the fail-lazy bridge, then fully exit and restart the client.
- Restart both LogVue and the MCP client after tool-schema changes.

## Further work

- Decide whether MCP is enabled by default or controlled by a setting.
- Expand protocol-level tests to cover direct endpoint authentication and WSL NAT forwarding.
- Test Windows, WSL, relative, and archive-escape path resolution.
- Add a cursor or date boundary if agents need logs older than the newest 100.
- Improve structured error codes for duplicates, missing sessions, and unavailable sources.
- Add a deliberately supervised hardware-in-the-loop test for lease expiry and OpMode stop behavior.

## Commit history

- `c95544d` — initial action-oriented MCP prototype.
- `b4e8990` — authenticated bridge supporting WSL NAT and mirrored networking.
- Current checkpoint — fail-lazy stdio startup, corrected stateless lifecycle, bounded hub-log results, filesystem-first guidance, flexible paths, and session creation.

# MCP integration

## Purpose

LogVue's MCP surface is intentionally action-oriented. Agents already navigate the archive, read `session.json`, patch `notes.md`, grep text, and analyse logs effectively through the filesystem. MCP exists for operations that must go through the running application:

- discover live or folder-backed hub logs;
- create sessions using LogVue's naming and schema rules;
- import logs through LogVue's duplicate detection, Activity task, metadata, and indexing pipeline.

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

LogVue permits unauthenticated loopback access and requires a stable random 256-bit bearer token for non-loopback requests. Connection information is stored at the app-level path:

```text
<stable user-data>/MCP/mcp.json
```

The active archive is not part of the bridge configuration. Agents discover it from `get_status`, and all archive tools follow the library currently selected in LogVue.

The bridge and discovery file live together. The bridge does not read discovery or probe the endpoint during MCP client startup. When a tool is invoked, it locates discovery automatically, tries `127.0.0.1` first, and only reads WSL's default route when it is actually running under WSL. LogVue refreshes the dependency-bundled bridge on every start.

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

## Commit history

- `c95544d` — initial action-oriented MCP prototype.
- `b4e8990` — authenticated bridge supporting WSL NAT and mirrored networking.
- Current checkpoint — fail-lazy stdio startup, corrected stateless lifecycle, bounded hub-log results, filesystem-first guidance, flexible paths, and session creation.

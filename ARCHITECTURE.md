# LogVue — Architecture

FTC Control Hub RLOG organiser. Desktop app to browse `.rlog` files on a Control Hub
over ADB, import them into a local **folder-based** archive, and annotate them as
sessions (competitions, matches, tuning runs, workshop tests…).

This document is the design contract. It should be read alongside
[`ftc_control_hub_rlog_organiser_spec.md`](./ftc_control_hub_rlog_organiser_spec.md),
which defines *what* to build; this defines *how*.

---

## 1. Stack

| Concern            | Choice                                   | Why |
|--------------------|------------------------------------------|-----|
| Shell              | **Electron**                             | Cross-platform desktop, web UI, direct Node access to `adb`/fs/sqlite |
| UI                 | **React 18 + TypeScript**                | Best-covered by tooling; large ecosystem for tree/table widgets |
| Build              | **electron-vite**                        | One Vite config for main / preload / renderer; fast HMR |
| Renderer state     | **Zustand** (UI state) + **TanStack Query** (main-process calls) | Query gives caching/loading/refetch over IPC for free |
| Local index        | **better-sqlite3**                       | Synchronous, fast, native; index lives in the main process only |
| ADB                | subprocess wrapper over system `adb`     | No native android deps; tolerant of shell differences (spec §7) |
| FTCScout           | GraphQL over `fetch` (`api.ftcscout.org/graphql`) | Optional, online-only, cached to sqlite |
| Packaging          | **electron-builder** (win/mac/linux)     | Standard, code-sign ready later |
| Testing            | **Vitest** (unit) + **Playwright-Electron** (e2e, later) | Vitest shares Vite config |

> The spec suggested Python/PySide6; we deliberately chose Electron/React for the
> web UI and cross-platform packaging. Every spec *concept* still maps 1:1 (below).

> **Native module (`better-sqlite3`)**: it has an ABI-specific binary. `npm install`
> fetches the Node-ABI build (what Vitest uses), so **run `npm run rebuild` after any
> install** to rebuild it for Electron's ABI before `npm run dev`. The native module is
> isolated to `index/IndexStore.ts` and tests only exercise the pure `collectIndexRows`
> path, so the two ABIs never conflict.

---

## 2. Process model

Electron's three contexts, plus MCP as a second trusted-process front door:

```
┌──────────────────────────────────────────────────────────────────┐
│ RENDERER  (Chromium, sandboxed, NO node integration)               │
│   React app. Pure UI. Talks to the world only through window.api.  │
│   – Zustand stores, TanStack Query                                 │
│   – SessionTree · HubLogTable · SessionDetails · NotesEditor       │
└───────────────▲──────────────────────────────────────────────────┘
                │  window.api.*  (typed, promise-based)
┌───────────────┴──────────────────────────────────────────────────┐
│ PRELOAD  (contextBridge, contextIsolation: true)                   │
│   Exposes a small, typed, allow-listed API. No raw ipcRenderer,    │
│   no fs, no child_process reach the renderer.                      │
└───────────────▲──────────────────────────────────────────────────┘
                │  ipcMain.handle(channel, …)  ⇄  ipcRenderer.invoke
┌───────────────┴──────────────────────────────────────────────────┐
│ MAIN FRONT DOORS  (Node.js — trusted)                              │
│   Electron IPC registry                         MCP server          │
│              └──────────────┬──────────────────────┘               │
│                      shared commands                               │
│         mutation → reindex/rebuild → typed renderer event          │
│   – AdbClient (child_process)      – ArchiveService (fs)           │
│   – IndexStore (better-sqlite3)    – FtcScoutClient (fetch)        │
│   – ImportService (disk mutation)  – Watcher (chokidar)            │
└──────────────────────────────────────────────────────────────────┘
```

Security posture: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
The renderer can never touch fs/adb directly — it asks main via the allow-listed
bridge. IPC request/event contracts define that bridge; IPC and MCP mutations then
share the same main-process command choreography instead of calling services in
transport-specific sequences.

---

## 3. Repository layout

```
LogVue/
  package.json
  electron.vite.config.ts
  electron-builder.yml
  tsconfig.json                # references the three below
  ARCHITECTURE.md
  ftc_control_hub_rlog_organiser_spec.md

  src/
    main/                      # Node / trusted
      index.ts                 # app lifecycle, window creation
      commands/
        index.ts               # shared mutation → projection → notification choreography
      ipc/
        registry.ts            # typed IPC adapter over commands and read services
        events.ts              # typed main → renderer event broadcaster
      mcp/
        server.ts              # MCP transport/tool adapter over commands + read services
      services/
        adb/
          AdbClient.ts         # device detection, ls/find discovery, pull
          parseLs.ts           # tolerant `ls -l` / `find` parsing
          rlogFilename.ts      # opmode + timestamp parsing
          hublogs.ts           # assemble HubLog[] + resolve import status vs index
        archive/
          ArchiveService.ts    # scan / create / read / write sessions
          SessionStore.ts      # session.json + notes.md read/write
          discovery.ts         # folders without session.json → sessions
          paths.ts             # archive root, safe folder naming
        index/
          IndexStore.ts        # better-sqlite3 open/migrate/query (only native-module file)
          schema.ts            # index DDL as a string const (rebuildable; ships in the bundle)
          rebuild.ts           # pure disk→rows projection + full rebuild
          indexService.ts      # owns the open store per archive root; cold-start/rebuild
        import/
          ImportService.ts     # pull → copy → session.json (+ new-session batch)
          importTask.ts        # activity-toast wrapper around import commands
          identity.ts          # duplicate detection (§14)
          fileKind.ts          # guess FileKind from filename (§6)
        ftcscout/
          FtcScoutClient.ts    # GraphQL queries
          syncEvent.ts         # merge remote matches → local sessions
        watcher/
          Watcher.ts           # chokidar → debounced full rebuild + archive notification
      config/
        settings.ts            # archive root, adb path, prefs (electron-store)

    preload/
      index.ts                 # contextBridge.exposeInMainWorld('api', …)

    renderer/
      index.html
      main.tsx
      App.tsx
      api/                     # thin typed wrappers over window.api
      stores/                  # Zustand: mode, selection, filters
      queries/                 # TanStack Query hooks per domain
      components/
        layout/                # Toolbar, StatusBar, split panes
        SessionTree/
        HubLogTable/
        SessionDetails/
        NotesEditor/
        dialogs/               # create-session, import-conflict, annotate
      styles/

    shared/                    # imported by BOTH main and renderer
      types/
        session.ts             # Session, SessionMetadata, SessionFile
        hublog.ts              # HubLog, ImportStatus
        ftcscout.ts
        ipc.ts                 # typed IPC request/response + push-event contracts
      constants/
        sessionTypes.ts        # §4.3
        fileKinds.ts           # §6
      schema/
        sessionJson.ts         # zod schema + schema_version migrations

  tests/
```

`shared/` is the spine: types defined once, used by main (to validate) and
renderer (to render). `IpcApi` and `IpcEvents` in `shared/types/ipc.ts` are the
request and push-event seams; mutating front doors converge in `main/commands/`.

---

## 4. Data model (mirrors spec §4–6)

TypeScript in `shared/types/`, validated at the fs boundary with **zod**
(`shared/schema/sessionJson.ts`) so a hand-edited or older `session.json` never
crashes the app — it migrates or falls back to discovery defaults (spec §4.2).
A file that won't even parse (corrupt JSON, non-object, half-written) is a
distinct state from "no session.json" (`probeMetadata`: missing | invalid |
valid): both display as a bare folder, but invalid is flagged
(`metadataInvalid`) with a warning in the UI, and if the app ever writes
metadata to that folder it first preserves the unreadable file as
`session.json.bak` (unique-suffixed). Reads never mutate or destroy it, and one
bad file never fails the tree scan or index rebuild. All app-owned sidecar
writes (`session.json`, `notes.md`, settings) go through a temp-file + rename
(`main/lib/atomicWrite.ts`) that preserves the target's permission bits and
cleans up stale temps from interrupted writes; `.tmp`/`~` artifacts are excluded
from listings, indexing, and watching by one shared predicate
(`paths.isTransientArtifact`).

```ts
type SessionType =
  | 'competition_event' | 'official_match' | 'practice_match' | 'replay'
  | 'workshop_session'  | 'tuning_session' | 'debug_session'
  | 'test_session'      | 'general_session' | 'other';

interface SessionMetadata {
  schema_version: number;          // 1; migrations keyed off this
  session_id?: string;             // minted on first write; reads never generate ids
  session_type: SessionType;
  display_name: string;            // seeded from folder name on discovery
  created_at: string; updated_at: string;
  session_start?: string | null; session_end?: string | null;
  sort_key?: string | null;
  tags: string[];
  notes_file: string;              // 'notes.md'
  files: SessionFile[];
  // optional typed extensions, present only for relevant types:
  event?: EventInfo;               // competition_event  (§5.1)
  match?: MatchInfo;               // official_match      (§5.2)
  session?: GeneralInfo;           // workshop/general    (§5.4)
  teams?: number[];
}

type FileKind =
  | 'auto_log' | 'teleop_log' | 'match_log' | 'practice_log' | 'tuning_log'
  | 'debug_log' | 'crash_log' | 'test_log'
  | 'video' | 'screenshot' | 'advantage_scope_layout' | 'notes' | 'other';

interface SessionFile {
  filename: string; kind: FileKind; source: string; // 'control_hub' | …
  imported_at: string;
  remote_path?: string | null; original_filename?: string | null;
  file_size_bytes?: number | null;
  // future media sync (§17): time_source, offset_seconds …
}

interface HubLog {                 // a remote file on the Control Hub
  remote_path: string; filename: string;
  opmode: string | null; parsed_timestamp: string | null;
  file_size_bytes: number | null;
  import_status: ImportStatus;     // resolved against the index
}

type ImportStatus =
  | { state: 'not_imported' }
  | { state: 'ignored' }
  | { state: 'imported'; sessionPath: string; sessionLabel: string };
```

### Source of truth vs derived

| Thing                         | Lives in                    | Authoritative? |
|-------------------------------|-----------------------------|----------------|
| Session existence & nesting   | **folders on disk**         | ✅ yes |
| Session metadata / files      | **`session.json`**          | ✅ yes |
| Human notes                   | **`notes.md`**              | ✅ yes |
| Fast browse/filter/search     | `.logvue/index.sqlite`              | ❌ rebuildable |
| Ignored-remote-log markers    | `.logvue/index.sqlite` (spec §15)   | ❌ cache |
| FTCScout event/match cache    | `.logvue/index.sqlite`              | ❌ cache |

**Rule:** the index is disposable. Delete `.logvue/index.sqlite`, relaunch, and a full
rescan (`index/rebuild.ts`) reconstructs everything (spec §13). This is enforced
by never writing app-critical state *only* to sqlite.

---

## 5. IPC contract (`shared/types/ipc.ts`)

`IpcApi` is one typed map of `channel → (request) => response`. `preload` exposes
exactly these; `main/ipc/registry.ts` implements exactly these; the renderer's
`api/` wraps them. Adding a request capability = adding one entry here.

```ts
interface IpcApi {
  // ── settings / archive root ──────────────────────────────
  'settings:get':            () => AppSettings;
  'settings:pickArchiveRoot':() => string | null;      // native dir dialog
  'settings:setArchiveRoot': (path: string) => AppSettings;

  // ── ADB ──────────────────────────────────────────────────
  'adb:status':      () => { connected: boolean; device?: string; adbMissing?: boolean };
  'adb:listHubLogs': () => HubLog[];                    // ls + parse + status

  // ── MCP ──────────────────────────────────────────────────
  'mcp:status':      () => McpStatus;                    // endpoint + discovery + last request

  // ── archive / sessions ───────────────────────────────────
  'archive:tree':        () => SessionNode[];           // for SessionTree
  'archive:getSession':  (path: string) => Session;
  'archive:createSession':(input: CreateSessionInput) => Session;
  'archive:updateMeta':  (path: string, patch: Partial<SessionMetadata>) => Session;
  'archive:deleteSession':(path: string) => DeleteSessionSummary;
  'archive:promoteFolder':(path: string) => Session;
  'archive:readNotes':   (path: string) => string;
  'archive:writeNotes':  (path: string, md: string) => void;
  'archive:rebuildIndex':() => { sessions: number; files: number };

  // ── filter / search over the index (§12) ─────────────────
  'index:query':         (q: SessionQuery) => SessionQueryResult; // rows + whole-archive facets

  // ── import ───────────────────────────────────────────────
  'import:toSession':    (req: ImportRequest) => ImportResult;   // append, not replace
  'import:batchToSession':(req: BatchImportRequest) => ImportResult[];
  'import:toNewSession': (req: NewSessionImportRequest) => NewSessionImportResult;
  'adb:ignoreHubLog':    (entry: HubLogRef) => void;

  // ── FTCScout (online only) ───────────────────────────────
  'ftcscout:searchEvents':(q: { season: number; text: string }) => EventHit[];
  'ftcscout:syncEvent':   (req: SyncRequest) => SyncResult;   // merge, preserve local

}

interface IpcEvents {
  'archive:changed': ArchiveChangedEvent;
  'tasks:update': Task;
}
```

`IpcEvents` separately maps every main → renderer channel to its payload. Watcher
and task broadcasts go through the single generic `ipc/events.ts` helper, so a
channel and payload cannot drift independently. The preload deliberately exposes
only two named subscriptions (`onArchiveChanged`, `onTaskUpdate`), not a raw or
arbitrary `ipcRenderer` listener.

### 5.1 Shared mutation commands

`main/commands/` is the application boundary shared by the Electron IPC and MCP
adapters. A command owns the whole domain sequence:

```text
service mutation → indexService.reindexSession (or full rebuild) → archive:changed
```

Create, metadata update, and promotion reindex one session. Delete preserves its
full rebuild because descendant rows may disappear. Notes need no index write but
still emit the typed archive event. Import commands pause watcher flushing across
their multi-file work, perform one final reindex, and notify; their activity tasks
remain presentation wrappers outside the command. Read-only handlers can call
services directly.

Chokidar will still observe app-owned writes and run its accepted debounced full
rebuild about 400 ms later. Replacing that redundant rebuild with scoped reindexing
is deliberately deferred to the next hardening item.

---

## 6. Key data flows

### 6.1 Import a hub log (the core action, spec §7.4 / §9.3)

```
renderer: user clicks "Import latest" on Q4 Blue B2
  → api.import.toSession({ remote_path, sessionPath, kind })
IPC adapter → activity-task wrapper → shared importHubLogCommand
  → ImportService.importToSession:
  1. identity check (§14): remote_path+filename+size vs index (skipped when force)
        └─ if match → return { status:'duplicate', existing } → renderer offers
           Cancel / Import another copy (force). [Link existing / Reassign: deferred]
  2. adb pull <remote_path> → <sessionPath>/<original_filename>   (append;
     collisions get a _2 suffix — uniqueFilePath). A bare target folder is promoted
     to a session first, so an import always lands in something recognised.
  3. SessionStore: add SessionFile to session.json, bump updated_at
  4. command → indexService.reindexSession: upsert the session row + replace its file rows,
     so the hub-log status flips without a full rescan
  5. command emits typed archive:changed; return ImportResult
       → Query invalidates 'archive:tree' + 'archive:session' + 'adb:hubLogs'
renderer: hub log row flips to "Imported → APOC26 / Q4 Blue B2"
```

Never renames/deletes the remote file (spec §7.4, §22). Import **appends** (§4).
The MCP `import_hub_log` tool reaches the same command through the same activity
wrapper. `import:toNewSession` composes createSession + a forced import loop for
the general "Create session from selected" workflow (§10). Ignored logs (§15) live in
`ignored_hublogs` (index-only) via `adb:ignoreHubLog`/`adb:unignoreHubLog`; the UI
hides them behind a "Show ignored" toggle.

### 6.2 Cold start / open archive (spec §13)

```
app boot → settings.archiveRoot
  → if .logvue/index.sqlite missing OR schema out of date → rebuild.ts scans every folder,
     parses session.json (zod; discovery defaults for bare folders) → populates index
  → Watcher (chokidar) starts; a debounced change currently triggers a full rebuild
     and typed archive:changed event (scoped reindex is the next hardening item)
  → renderer requests archive:tree from disk; filter/search queries use the index
```

### 6.3 FTCScout sync (spec §8.3 — merge, never clobber)

**FTCScout's job is to pre-create the empty match sessions with correct metadata,
so that at the event logs drop straight into ready-made folders.** It is a scaffold
generator, not a data source — no logs come from FTCScout, only structure.

```
online (before event): user syncs APOC26 for team 12345
  → FtcScoutClient GraphQL: event + team's match schedule
  → syncEvent.ts merges into local competition session:
       • CREATE a child folder + session.json per official match the team plays,
         pre-filled: display_name (e.g. "Q4 Blue B2"), match.{label,type,number,
         alliance,station}, team_number, tags — but files: [] (empty, awaiting import)
       • on re-sync: update FTCScout-owned match fields in place
       • PRESERVE notes.md, tags, imported files, custom child sessions
  → cache raw response in index for offline reuse

at event (offline): Import logs into those pre-made match folders (flow 6.1).
```

The merge writes only FTCScout-owned fields (`match.*`, `event.*`, `last_synced`);
user-owned fields (`tags`, `files`, notes, custom children) are untouched. This is
invariant #5 and gets an explicit unit test. The whole point is that a synced-but-
empty `Q4_Blue_B2/` is already a valid, importable session before a single log exists.

---

## 7. ADB strategy (spec §7)

- Wrap **system `adb`** (from `PATH`) via `child_process`. No bundled binary and no
  configurable path — if `adb` isn't on `PATH`, show a friendly error + install hint.
- **Coexist with an existing adb server; never own it.** `adb` uses a single shared
  host daemon (the adb server) per machine. The FTC IDE / Android Studio very likely
  already started it and may have the device open. Therefore:
    - **Never** run `adb kill-server` or `adb start-server` — that would yank the
      device out from under the IDE. We attach to whatever server is already running
      (a plain `adb` command auto-starts one only if none exists).
    - Our operations are read-only-ish and concurrency-safe: `adb devices`,
      `adb shell ls/find`, `adb pull`. Multiple clients sharing one server is fine.
    - Be resilient to transient "device busy"/offline states from concurrent IDE
      access: surface them and let the user retry, don't crash or auto-restart adb.
- Device detection: parse `adb devices`; poll on an interval **and** offer manual
  refresh; emit `adb:changed` on transitions.
- Discovery: try `find /sdcard/FIRST/SpiderKit -name "*.rlog" -type f`; **fall back** to
  `ls -l` parsing when `find` is unavailable (Android shells vary — spec §7.2).
  All parsing isolated in `parseLs.ts` + `rlogFilename.ts` so it's unit-testable
  against captured real-device output.
- Assume ADB (Control Hub Wi-Fi) and internet may be mutually exclusive (spec §8.4):
  FTCScout features degrade gracefully to cached data; nothing blocks on network.

---

## 8. Index schema (rebuildable — `index/schema.ts`)

```sql
sessions(path PK, session_id, session_type, display_name, event_code,
         team_number, alliance, session_start, sort_key, updated_at);
files(id PK, session_path FK, filename, kind, remote_path, original_filename,
      file_size_bytes, imported_at);
session_tags(session_path FK, tag, PK(session_path, tag)); -- derived; "tagged X" join
file_metadata(session_path FK, filename, key, value,       -- derived; RLOG-embedded
              PK(session_path, filename, key));            -- Logger.recordMetadata k/v
ignored_hublogs(remote_path PK, filename, file_size_bytes, ignored_at);
ftcscout_cache(event_code, season, payload_json, last_synced);
```

Identity in the derived tables is the **folder path** — the one fact a rescan can
never see twice. Paths are stored as **archive-relative keys** with `/` separators,
canonicalised (case, symlinks, drive letter) at the `IndexStore` boundary via
`realpath`: absolute paths go in and come out, relative keys are what SQLite
compares. This means a moved/synced archive's index stays valid without a rebuild,
and Windows case/separator variants of the same folder can't mint duplicate rows.
`session_id` is carried as data only: it is `NULL` for a bare folder (ids are
minted on write, never on read) and may be duplicated when a user copies a session
folder in Explorer — both copies then index and search normally.

Everything here is derivable from disk. Filters (spec §12) become indexed queries
(`session_type`, `event_code`, `alliance`, tag join, "has file kind", "missing
teleop"). Search examples in §12.2 are all expressible over these tables. The pure
`index/query.ts` (`buildSessionQuery`) turns a `SessionQuery` into a fully
parametrised WHERE body; `IndexStore.querySessions`/`facets` execute it and the
whole-archive facet counts. `session_tags` and `file_metadata` are *derived* tables
(rebuilt from disk alongside `sessions`/`files`) — a stale `INDEX_SCHEMA_VERSION`
drops and repopulates the derived tables on next open (§6.2). Metadata edits
(`updateMeta`/`createSession`/`promoteFolder`) flow through shared commands that
reindex the single touched session and emit `archive:changed`, so filters and every
renderer stay in step without a full rescan. Session deletion is the exception: its
command performs a full rebuild because an entire descendant subtree may vanish.

`file_metadata` holds the key/value map SpiderKit's `Logger.recordMetadata()` embeds in
each `.rlog` (`/Metadata/*` string records in the first log cycle — e.g. GitSHA,
GitBranch, OpMode name). `rlog/rlogMetadata.ts` decodes it from the *head* of the
file only (128 KiB cap), at import (`reindexSession`) and full rebuild; the log file
itself is the source of truth, so the table needs no `session.json` involvement.

---

## 9. MVP → phased build order

Tracks spec §18 (MVP) then §19 (post-MVP). Each phase is independently runnable.

| Phase | Deliverable | Spec |
|------:|-------------|------|
| **0** | Scaffold: electron-vite boots empty window; IPC ping; shared types; CI lint/typecheck | — |
| **1** | Archive core: pick root, scan, session.json read/write, discovery, tree UI, sqlite index + rebuild | §3,4,13 |
| **2** | ADB read-only: device status, list hub logs, filename parsing, HubLogTable with import-status | §7.1–7.3,10.1 |
| **3** | Import: pull→copy→append→index, duplicate detection, ignored logs, general/date workflow | §7.4,9.3,10,14,15 |
| **4** | Competition workflow (manual): nested sessions, match rows, notes editor, filters | §9,11,12,16 |
| **5** | FTCScout: event search, sync/merge, offline cache | §8,9.1 |
| **6+**| Drag-drop, AdvantageScope "open log", video/media, zip export, validate/repair | §17,19 |

Phases 0–4 = a genuinely useful offline tool with no external API dependency —
matching the spec's "get the local archive model working first, add FTCScout after."

---

## 10. Open questions → decided defaults (spec §22)

Adopting the spec's recommended defaults, encoded as constants/behaviour:

- Ordering by `sort_key` (falls back to `session_start`, then folder mtime). **No**
  numeric folder prefixes.
- Keep original `.rlog` filenames on import.
- Ignored-log markers live in the index only.
- MVP optimises for one selected team; multi-team is a later view concern.
- FTCScout code and local display code are separate fields (`event.ftcscout_code`
  vs `event.display_code`).
- Files are physically copied into the session folder (no external references in MVP).
- Import-only: never delete/rename on the Control Hub.

Anything here can be revisited, but the code assumes these until changed.

### 10.1 Grouping folders are sessions

The app's core model is "everything is a session." A date folder or organisational
grouping such as `2026/` is therefore just a lightweight `general_session`, not a
separate container type. This keeps grouping folders searchable, visible in facets,
and editable with the same metadata/notes model as every other archive node.

Bare folders without `session.json` can still appear in the tree when discovered on
disk. The lightweight `FolderDetails` view offers **Recognise as session**, which
writes a normal `general_session` `session.json`. The "Date folder" creation flow also
creates a `general_session`.

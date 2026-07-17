import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import type { ImportStatus } from '@shared/types/hublog'
import type { HubLogRef } from '@shared/types/import'
import type { FtcScoutEventPayload } from '@shared/types/ftcscout'
import type { FacetCounts, SessionQuery, SessionQueryRow } from '@shared/types/query'
import type { SessionType, FileKind } from '@shared/types/session'
import { LOG_KINDS } from '@shared/constants/fileKinds'
import { DERIVED_TABLES, INDEX_SCHEMA_VERSION, SCHEMA_SQL } from './schema'
import type { FileMetadataRow, FileRow, IndexRows, SessionRow, TagRow } from './rebuild'
import { fromArchiveKey, toArchiveKey } from './indexPaths'
import { buildSessionQuery, escapeLikeText } from './query'
import type { ImportIdentity } from '../import/identity'

/** Upsert a `sessions` row keyed by path (used by both a full rebuild and a single-session reindex). */
const INSERT_SESSION_SQL = `INSERT INTO sessions
    (path, session_id, session_type, display_name, event_code, team_number,
     alliance, session_start, sort_key, updated_at)
   VALUES
    (@path, @session_id, @session_type, @display_name, @event_code, @team_number,
     @alliance, @session_start, @sort_key, @updated_at)
   ON CONFLICT(path) DO UPDATE SET
     session_id=excluded.session_id, session_type=excluded.session_type,
     display_name=excluded.display_name, event_code=excluded.event_code,
     team_number=excluded.team_number, alliance=excluded.alliance,
     session_start=excluded.session_start, sort_key=excluded.sort_key,
     updated_at=excluded.updated_at`

const INSERT_FILE_SQL = `INSERT INTO files
    (session_path, filename, kind, remote_path, original_filename, file_size_bytes, imported_at, recorded_at)
   VALUES
    (@session_path, @filename, @kind, @remote_path, @original_filename, @file_size_bytes, @imported_at, @recorded_at)`

const INSERT_TAG_SQL = `INSERT OR IGNORE INTO session_tags (session_path, tag) VALUES (@session_path, @tag)`

const INSERT_FILE_META_SQL = `INSERT OR REPLACE INTO file_metadata (session_path, filename, key, value)
   VALUES (@session_path, @filename, @key, @value)`

/**
 * The local index (ARCHITECTURE.md §8) — the *only* module that touches the native
 * `better-sqlite3` binary. Everything it holds is derivable from disk, so it's safe
 * to delete `.logvue/index.sqlite` and rebuild (§4). Keeping the native dependency isolated
 * here means the disk → rows projection (`rebuild.collectIndexRows`) stays unit-
 * testable under Vitest without an Electron-ABI rebuild of the binary.
 */
export class IndexStore {
  private readonly db: Db

  /**
   * Canonical archive root this index belongs to. Rows are stored under
   * archive-relative keys; absolute paths are converted at this class's
   * boundary in both directions, so callers only ever see absolute paths and
   * the stored keys survive the archive being moved.
   */
  readonly archiveRoot: string

  constructor(dbPath: string, archiveRoot: string) {
    this.archiveRoot = archiveRoot
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.ensureSchema()
  }

  /** Archive-relative storage key for an absolute (canonical) session path. */
  private toKey(absPath: string): string {
    return toArchiveKey(this.archiveRoot, absPath)
  }

  /** Absolute path for a stored session key. */
  private toAbs(key: string): string {
    return fromArchiveKey(this.archiveRoot, key)
  }

  private toStoredSession(row: SessionRow): SessionRow {
    return { ...row, path: this.toKey(row.path) }
  }

  private toStoredFile(row: FileRow): FileRow {
    return { ...row, session_path: this.toKey(row.session_path) }
  }

  private toStoredTag(row: TagRow): TagRow {
    return { ...row, session_path: this.toKey(row.session_path) }
  }

  private toStoredMeta(row: FileMetadataRow): FileMetadataRow {
    return { ...row, session_path: this.toKey(row.session_path) }
  }

  /**
   * Create the schema, recreating the *derived* tables when the on-disk schema
   * version is stale (§6.2 cold start). User/cache tables are left alone unless the
   * whole file is being created fresh.
   */
  private ensureSchema(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    if (current !== INDEX_SCHEMA_VERSION) {
      // Derived tables may have an old shape — drop and let SCHEMA_SQL rebuild them.
      // (They're repopulated from disk by rebuildIndex.)
      for (const table of DERIVED_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    this.db.exec(SCHEMA_SQL)
    this.db.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`)
  }

  /**
   * Atomically replace the derived `sessions`/`files` rows with a fresh rescan.
   * Runs in a single transaction so a crash mid-rebuild can't leave a half-index.
   * Preserves `ignored_hublogs` and `ftcscout_cache`.
   */
  replaceSessions(rows: IndexRows): void {
    const insertSession = this.db.prepare(INSERT_SESSION_SQL)
    const insertFile = this.db.prepare(INSERT_FILE_SQL)
    const insertTag = this.db.prepare(INSERT_TAG_SQL)
    const insertMeta = this.db.prepare(INSERT_FILE_META_SQL)
    const replace = this.db.transaction((data: IndexRows) => {
      this.db.exec('DELETE FROM file_metadata')
      this.db.exec('DELETE FROM session_tags')
      this.db.exec('DELETE FROM files')
      this.db.exec('DELETE FROM sessions')
      for (const s of data.sessions) insertSession.run(this.toStoredSession(s))
      for (const f of data.files) insertFile.run(this.toStoredFile(f))
      for (const t of data.tags) insertTag.run(this.toStoredTag(t))
      for (const m of data.fileMeta) insertMeta.run(this.toStoredMeta(m))
    })
    replace(rows)
  }

  /**
   * Re-index a single session after an import (spec §6.1 step 4): upsert its row and
   * replace just that session's file rows, so a hub log's import status flips without
   * a full rescan. The `files` change is bounded to one `session_id`.
   */
  indexSession(
    session: SessionRow,
    files: FileRow[],
    tags: TagRow[] = [],
    fileMeta: FileMetadataRow[] = []
  ): void {
    const insertSession = this.db.prepare(INSERT_SESSION_SQL)
    const insertFile = this.db.prepare(INSERT_FILE_SQL)
    const insertTag = this.db.prepare(INSERT_TAG_SQL)
    const insertMeta = this.db.prepare(INSERT_FILE_META_SQL)
    const deleteFiles = this.db.prepare('DELETE FROM files WHERE session_path = ?')
    const deleteTags = this.db.prepare('DELETE FROM session_tags WHERE session_path = ?')
    const deleteMeta = this.db.prepare('DELETE FROM file_metadata WHERE session_path = ?')
    const key = this.toKey(session.path)
    const write = this.db.transaction(() => {
      insertSession.run(this.toStoredSession(session))
      deleteFiles.run(key)
      deleteTags.run(key)
      deleteMeta.run(key)
      for (const f of files) insertFile.run(this.toStoredFile(f))
      for (const t of tags) insertTag.run(this.toStoredTag(t))
      for (const m of fileMeta) insertMeta.run(this.toStoredMeta(m))
    })
    write()
  }

  /**
   * Existing imports of a remote file, with where each landed — the raw material for
   * duplicate detection (spec §14). Matching on identity fields is done purely in
   * `import/identity.findDuplicates`.
   */
  importsOf(remotePath: string): ImportIdentity[] {
    const rows = this.db
      .prepare(
        `SELECT f.remote_path, f.original_filename, f.file_size_bytes, f.filename,
                s.path AS sessionPath, s.display_name AS sessionLabel
           FROM files f JOIN sessions s ON s.path = f.session_path
          WHERE f.remote_path = ?`
      )
      .all(remotePath) as ImportIdentity[]
    return rows.map((r) => ({ ...r, sessionPath: this.toAbs(r.sessionPath) }))
  }

  /** Mark a remote hub log as ignored (spec §15) — hidden from the default log view. */
  ignoreHubLog(entry: HubLogRef): void {
    this.db
      .prepare(
        `INSERT INTO ignored_hublogs (remote_path, filename, file_size_bytes, ignored_at)
         VALUES (@remote_path, @filename, @file_size_bytes, @ignored_at)
         ON CONFLICT(remote_path) DO UPDATE SET
           filename=excluded.filename, file_size_bytes=excluded.file_size_bytes,
           ignored_at=excluded.ignored_at`
      )
      .run({
        remote_path: entry.remotePath,
        filename: entry.filename,
        file_size_bytes: entry.fileSize,
        ignored_at: new Date().toISOString()
      })
  }

  /** Un-ignore a remote hub log (spec §15 — reversible). */
  unignoreHubLog(remotePath: string): void {
    this.db.prepare('DELETE FROM ignored_hublogs WHERE remote_path = ?').run(remotePath)
  }

  /** Cached FTCScout event payload. Preserved across index rebuilds. */
  getFtcScoutEvent(eventCode: string, season: number): FtcScoutEventPayload | null {
    const row = this.db
      .prepare(
        `SELECT payload_json
           FROM ftcscout_cache
          WHERE event_code = ? AND season = ?
          LIMIT 1`
      )
      .get(eventCode.toUpperCase(), season) as { payload_json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.payload_json) as FtcScoutEventPayload
    } catch {
      return null
    }
  }

  /** Store the full normalized FTCScout event payload for offline/later sync fallback. */
  putFtcScoutEvent(payload: FtcScoutEventPayload): void {
    this.db
      .prepare(
        `INSERT INTO ftcscout_cache (event_code, season, payload_json, last_synced)
         VALUES (@event_code, @season, @payload_json, @last_synced)
         ON CONFLICT(event_code, season) DO UPDATE SET
           payload_json=excluded.payload_json,
           last_synced=excluded.last_synced`
      )
      .run({
        event_code: payload.code.toUpperCase(),
        season: payload.season,
        payload_json: JSON.stringify(payload),
        last_synced: payload.lastSynced
      })
  }

  /**
   * Resolve a remote hub log's import status against the index (spec §7.3): whether
   * it's already been imported into a session, or the user has hidden it. "Imported"
   * wins over "ignored" — an actually-present file is the stronger fact.
   */
  importStatusFor(remotePath: string): ImportStatus {
    const imported = this.db
      .prepare(
        `SELECT s.path AS path, s.display_name AS label
           FROM files f JOIN sessions s ON s.path = f.session_path
          WHERE f.remote_path = ? LIMIT 1`
      )
      .get(remotePath) as { path: string; label: string } | undefined
    if (imported) {
      return { state: 'imported', sessionPath: this.toAbs(imported.path), sessionLabel: imported.label }
    }
    const ignored = this.db
      .prepare('SELECT 1 FROM ignored_hublogs WHERE remote_path = ? LIMIT 1')
      .get(remotePath)
    return ignored ? { state: 'ignored' } : { state: 'not_imported' }
  }

  /**
   * Run a structured filter over the index (spec §12) and return matching sessions
   * newest-first, each hydrated with its file/log counts and tags. The WHERE body is
   * built (and fully parametrised) by the pure {@link buildSessionQuery}; kinds and
   * tags for the matched rows are fetched in two batch queries (no N+1 per session).
   */
  querySessions(query: SessionQuery): SessionQueryRow[] {
    const { where, params } = buildSessionQuery(query)
    const rows = this.db
      .prepare(
        `SELECT path, session_type, display_name, event_code,
                team_number, alliance, session_start, sort_key
           FROM sessions s
          WHERE (${where})
          ORDER BY (COALESCE(s.sort_key, s.session_start) IS NULL),
                   COALESCE(s.sort_key, s.session_start) DESC,
                   s.display_name COLLATE NOCASE`
      )
      .all(params) as Array<{
      path: string
      session_type: string
      display_name: string
      event_code: string | null
      team_number: number | null
      alliance: string | null
      session_start: string | null
      sort_key: string | null
    }>

    const paths = rows.map((r) => r.path)
    const kinds = this.kindsBySession(paths)
    const tags = this.tagsBySession(paths)

    return rows.map((r) => {
      const rowKinds = kinds.get(r.path) ?? []
      return {
        path: this.toAbs(r.path),
        sessionType: r.session_type as SessionType,
        displayName: r.display_name,
        eventCode: r.event_code,
        teamNumber: r.team_number,
        alliance: r.alliance,
        sessionStart: r.session_start,
        sortKey: r.sort_key,
        fileCount: rowKinds.length,
        logCount: rowKinds.filter((k) => LOG_KINDS.has(k as FileKind)).length,
        tags: tags.get(r.path) ?? []
      }
    })
  }

  /**
   * The imported log files matching a session-level filter, with their session
   * context — the rows behind the "All logs" dashboard (quick-find). Free text is
   * widened here to also match the *filename*, since the unit of result is a file.
   * Timestamps are parsed from filenames by the caller; ordering happens there too.
   */
  queryLogs(query: SessionQuery): Array<{
    filename: string
    kind: string
    file_size_bytes: number | null
    imported_at: string | null
    recorded_at: string | null
    path: string
    display_name: string
    session_type: string
    alliance: string | null
  }> {
    const { text, ...rest } = query
    const { where, params } = buildSessionQuery(rest)
    let textClause = '1'
    const trimmed = text?.trim()
    if (trimmed) {
      params.ftext = `%${escapeLikeText(trimmed)}%`
      // Stored session keys are archive-relative with '/' separators on every platform.
      textClause =
        `(f.filename LIKE @ftext ESCAPE '\\'` +
        ` OR EXISTS (SELECT 1 FROM sessions ancestor WHERE ` +
        `(s.path = ancestor.path OR ` +
        `(substr(s.path, 1, length(ancestor.path)) = ancestor.path ` +
        `AND substr(s.path, length(ancestor.path) + 1, 1) = '/'))` +
        ` AND (ancestor.display_name LIKE @ftext ESCAPE '\\'` +
        ` OR ancestor.event_code LIKE @ftext ESCAPE '\\'` +
        ` OR EXISTS (SELECT 1 FROM session_tags ancestor_tag` +
        ` WHERE ancestor_tag.session_path = ancestor.path` +
        ` AND ancestor_tag.tag LIKE @ftext ESCAPE '\\'))))`
    }
    const rows = this.db
      .prepare(
        `SELECT f.filename, f.kind, f.file_size_bytes, f.imported_at, f.recorded_at,
                s.path, s.display_name, s.session_type, s.alliance
           FROM files f JOIN sessions s ON s.path = f.session_path
          WHERE (${where}) AND ${textClause}`
      )
      .all(params) as Array<{
      filename: string
      kind: string
      file_size_bytes: number | null
      imported_at: string | null
      recorded_at: string | null
      path: string
      display_name: string
      session_type: string
      alliance: string | null
    }>
    return rows.map((r) => ({ ...r, path: this.toAbs(r.path) }))
  }

  /** Map of session path → its file kinds (one entry per file), for the matched paths only. */
  private kindsBySession(paths: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (paths.length === 0) return out
    const placeholders = paths.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT session_path, kind FROM files WHERE session_path IN (${placeholders})`)
      .all(...paths) as Array<{ session_path: string; kind: string }>
    for (const { session_path, kind } of rows) {
      const list = out.get(session_path) ?? []
      list.push(kind)
      out.set(session_path, list)
    }
    return out
  }

  /** Map of session path → its tags, for the matched paths only. */
  private tagsBySession(paths: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (paths.length === 0) return out
    const placeholders = paths.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT session_path, tag FROM session_tags WHERE session_path IN (${placeholders}) ORDER BY tag`)
      .all(...paths) as Array<{ session_path: string; tag: string }>
    for (const { session_path, tag } of rows) {
      const list = out.get(session_path) ?? []
      list.push(tag)
      out.set(session_path, list)
    }
    return out
  }

  /**
   * Distinct filter values across the WHOLE archive (unfiltered), with per-value
   * session counts — the raw material for the filter sidebar (spec §12.1). Computed
   * independently of any active query so the controls stay stable while refining.
   */
  facets(): FacetCounts {
    const groupCount = <T = string>(sql: string): { value: T; count: number }[] =>
      this.db.prepare(sql).all() as { value: T; count: number }[]

    return {
      sessionTypes: groupCount(
        `SELECT session_type AS value, COUNT(*) AS count FROM sessions
          GROUP BY session_type ORDER BY count DESC, value`
      ),
      events: groupCount(
        `SELECT event_code AS value, COUNT(*) AS count FROM sessions
          WHERE event_code IS NOT NULL AND event_code <> ''
          GROUP BY event_code ORDER BY count DESC, value`
      ),
      teams: groupCount<number>(
        `SELECT team_number AS value, COUNT(*) AS count FROM sessions
          WHERE team_number IS NOT NULL
          GROUP BY team_number ORDER BY count DESC, value`
      ),
      alliances: groupCount(
        `SELECT alliance AS value, COUNT(*) AS count FROM sessions
          WHERE alliance IS NOT NULL AND alliance <> ''
          GROUP BY alliance ORDER BY count DESC, value`
      ),
      kinds: groupCount(
        `SELECT kind AS value, COUNT(DISTINCT session_path) AS count FROM files
          GROUP BY kind ORDER BY count DESC, value`
      ),
      tags: groupCount(
        `SELECT tag AS value, COUNT(*) AS count FROM session_tags
          GROUP BY tag ORDER BY count DESC, value`
      )
    }
  }

  /** Total bytes of every indexed file — the library size shown on the tree root row. */
  totalFileSizeBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(file_size_bytes), 0) AS n FROM files')
      .get() as { n: number }
    return row.n
  }

  /** Row counts for the derived tables (what `archive:rebuildIndex` reports back). */
  counts(): { sessions: number; files: number } {
    const sessions = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    const files = this.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }
    return { sessions: sessions.n, files: files.n }
  }

  close(): void {
    this.db.close()
  }
}

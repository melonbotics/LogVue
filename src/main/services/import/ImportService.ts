import { basename } from 'path'
import { rm, utimes } from 'fs/promises'
import type {
  BatchImportRequest,
  HubLogRef,
  ImportRequest,
  ImportResult,
  NewSessionImportRequest,
  NewSessionImportResult
} from '@shared/types/import'
import type { Session, SessionFile } from '@shared/types/session'
import { createSession } from '../archive/ArchiveService'
import { readMetadataOrDefault, writeMetadata } from '../archive/SessionStore'
import { reserveUniqueFilePath } from '../archive/paths'
import type { AdbLike } from '../adb/AdbClient'
import { getIndexStore } from '../index/indexService'
import { guessFileKind } from './fileKind'
import { findDuplicates } from './identity'
import { withPullProgress } from './pullProgress'

/**
 * Progress taps for the activity toast stack. Purely observational — the import
 * behaves identically when nothing is listening (tests, watcher-driven paths).
 */
export interface ImportHooks {
  onFileStart?(remotePath: string): void
  onFileBytes?(remotePath: string, bytes: number): void
  onFileEnd?(remotePath: string, result: ImportResult): void
}

/**
 * The filesystem mutation behind the import command (ARCHITECTURE §6.1, spec
 * §7.4): pull a remote hub log into a session folder and append it to
 * `session.json`. Never renames or deletes the remote file (invariant #7);
 * import *appends* (invariant #4). The command layer owns the resulting reindex
 * and renderer notification.
 *
 *   1. duplicate check against the index (skipped when `force`) — spec §14
 *   2. `adb pull` into the session folder (original name kept, collisions suffixed)
 *   3. append a `SessionFile` to `session.json`, bumping `updated_at`
 */
export async function importToSession(
  adb: AdbLike,
  root: string | null | undefined,
  req: ImportRequest,
  hooks?: ImportHooks
): Promise<ImportResult> {
  if (!req.force) {
    const store = getIndexStore(root)
    if (store) {
      const existing = findDuplicates(req, store.importsOf(req.remotePath))
      if (existing.length > 0) {
        const result: ImportResult = { status: 'duplicate', existing }
        hooks?.onFileEnd?.(req.remotePath, result)
        return result
      }
    }
  }

  // The target must be a real session; a bare folder gets a session.json written
  // (discovery defaults) so the import always lands in something recognised.
  const { metadata } = readMetadataOrDefault(req.sessionPath)

  hooks?.onFileStart?.(req.remotePath)
  const destPath = await reserveUniqueFilePath(req.sessionPath, req.filename)
  try {
    await withPullProgress(
      destPath,
      (bytes) => hooks?.onFileBytes?.(req.remotePath, bytes),
      () => adb.pull(req.remotePath, destPath)
    )
  } catch (error) {
    // ADB can write part of the destination before reporting a disconnect or pull
    // failure. This path was atomically reserved for this import, so cleanup cannot
    // remove a pre-existing file or another concurrent import's destination.
    try {
      await rm(destPath, { force: true })
    } catch (cleanupError) {
      console.error(`Unable to remove incomplete import at ${destPath}:`, cleanupError)
    }
    throw error
  }
  const recordedMs = req.recordedAt ? Date.parse(req.recordedAt) : NaN
  if (Number.isFinite(recordedMs)) {
    const recordedDate = new Date(recordedMs)
    await utimes(destPath, recordedDate, recordedDate)
  }

  const file: SessionFile = {
    filename: basename(destPath),
    kind: req.kind ?? guessFileKind(req.filename),
    source: 'control_hub',
    imported_at: new Date().toISOString(),
    recorded_at: Number.isFinite(recordedMs) ? new Date(recordedMs).toISOString() : null,
    remote_path: req.remotePath,
    original_filename: req.filename,
    file_size_bytes: req.fileSize
  }

  const written = writeMetadata(req.sessionPath, {
    ...metadata,
    files: [...metadata.files, file]
  })
  const session: Session = {
    path: req.sessionPath,
    name: basename(req.sessionPath),
    metadata: written,
    hasSessionJson: true
  }
  const result: ImportResult = { status: 'imported', session, file }
  hooks?.onFileEnd?.(req.remotePath, result)
  return result
}

/**
 * Import each log in turn, converting a thrown pull into a `failed` result so one
 * unreadable file (device unplugged mid-batch, permission denied) doesn't abandon
 * the logs behind it. Order matches `logs`.
 */
async function importEach(
  adb: AdbLike,
  root: string | null | undefined,
  logs: HubLogRef[],
  sessionPath: string,
  force: boolean,
  hooks?: ImportHooks
): Promise<ImportResult[]> {
  const results: ImportResult[] = []
  for (const log of logs) {
    try {
      results.push(
        await importToSession(adb, root, {
          remotePath: log.remotePath,
          filename: log.filename,
          fileSize: log.fileSize,
          recordedAt: log.recordedAt,
          sessionPath,
          force
        }, hooks)
      )
    } catch (err) {
      const result: ImportResult = {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err)
      }
      hooks?.onFileEnd?.(log.remotePath, result)
      results.push(result)
    }
  }
  return results
}

/** Import several selected logs into one existing session, holding duplicates (spec §14). */
export function importBatchToSession(
  adb: AdbLike,
  root: string | null | undefined,
  req: BatchImportRequest,
  hooks?: ImportHooks
): Promise<ImportResult[]> {
  return importEach(adb, root, req.logs, req.sessionPath, req.force ?? false, hooks)
}

/**
 * "Create session from selected" (spec §10): make a fresh session, then import the
 * chosen logs into it. Imports are forced — a brand-new folder can't hold a
 * duplicate, and the user explicitly asked for these logs here.
 */
export async function importToNewSession(
  adb: AdbLike,
  root: string | null | undefined,
  req: NewSessionImportRequest,
  hooks?: ImportHooks
): Promise<NewSessionImportResult> {
  const session = createSession({
    parentPath: req.parentPath,
    displayName: req.displayName,
    sessionType: req.sessionType
  })

  const results = await importEach(adb, root, req.logs, session.path, true, hooks)
  return { session, results }
}

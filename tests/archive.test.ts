import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSession,
  deleteSession,
  deleteSessionSummary,
  getSession,
  listFolderFiles,
  promoteFolder,
  scanTree,
  updateMeta
} from '../src/main/services/archive/ArchiveService'
import { parseSessionJson, makeDefaultMetadata } from '../src/shared/schema/sessionJson'
import { toFolderName } from '../src/main/services/archive/paths'

let root: string

function writeSession(dir: string, meta: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.json'), JSON.stringify(meta, null, 2))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'logvue-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanTree', () => {
  it('nests sessions and counts logs from disk', () => {
    const apoc = join(root, '2026', 'APOC26')
    writeSession(apoc, { schema_version: 1, session_type: 'competition_event', display_name: 'APOC26' })
    const q4 = join(apoc, 'Q4_Blue_B2')
    writeSession(q4, {
      schema_version: 1,
      session_type: 'official_match',
      display_name: 'Q4 Blue B2',
      match: { label: 'Q4', alliance: 'blue', station: 'B2', team_number: 12345 }
    })
    writeFileSync(join(q4, 'AutoOpMode_log_1.rlog'), 'x')
    writeFileSync(join(q4, 'TeleOp_log_2.rlog'), 'x')

    const tree = scanTree(root)
    const year = tree.find((n) => n.name === '2026')!
    expect(year.hasSessionJson).toBe(false) // bare grouping folder
    expect(year.match).toBeNull() // grouping folder carries no match block
    const event = year.children[0]
    expect(event.displayName).toBe('APOC26')
    expect(event.sessionType).toBe('competition_event')
    const match = event.children[0]
    expect(match.displayName).toBe('Q4 Blue B2')
    expect(match.logCount).toBe(2)
    expect(match.match).toMatchObject({ alliance: 'blue', station: 'B2', team_number: 12345 })
  })

  it('treats a folder with corrupt session.json as bare instead of failing the scan', () => {
    const broken = join(root, 'Broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'session.json'), '{ "display_name": "half writ')
    writeSession(join(root, 'Fine'), { schema_version: 1, display_name: 'Fine' })

    const tree = scanTree(root)
    expect(tree.map((n) => n.name).sort()).toEqual(['Broken', 'Fine'])
    const brokenNode = tree.find((n) => n.name === 'Broken')!
    expect(brokenNode.hasSessionJson).toBe(false) // degraded to bare-folder defaults
    expect(brokenNode.metadataInvalid).toBe(true) // distinct from a genuinely bare folder
    expect(brokenNode.displayName).toBe('Broken')
    expect(tree.find((n) => n.name === 'Fine')!.metadataInvalid).toBe(false)
    // Reading never touches the corrupt file.
    expect(readFileSync(join(broken, 'session.json'), 'utf-8')).toBe('{ "display_name": "half writ')
  })

  it('excludes transient artifacts (.tmp, editor backups) from counts and listings', () => {
    const dir = join(root, 'Session')
    writeSession(dir, { schema_version: 1, display_name: 'Session' })
    writeFileSync(join(dir, 'Real_log.rlog'), 'log')
    writeFileSync(join(dir, 'session.json.1234.tmp'), '{ half')
    writeFileSync(join(dir, 'notes.md~'), 'editor backup')

    expect(scanTree(root)[0].fileCount).toBe(1)
    expect(listFolderFiles(dir).map((f) => f.filename)).toEqual(['Real_log.rlog'])
  })

  it('drops a malformed files[] entry without voiding the rest of session.json', () => {
    const dir = join(root, 'Partial')
    writeSession(dir, {
      schema_version: 1,
      display_name: 'Partial but valid',
      files: [
        { kind: 'auto_log' }, // hand-edit lost the filename
        { filename: 'Present_log.rlog', kind: 'auto_log', source: 'control_hub' }
      ]
    })
    writeFileSync(join(dir, 'Present_log.rlog'), 'log')

    const session = getSession(dir)
    expect(session.hasSessionJson).toBe(true)
    expect(session.metadata.display_name).toBe('Partial but valid')
    expect(session.metadata.files.map((f) => f.filename)).toEqual(['Present_log.rlog'])
  })

  it('returns [] for a missing root', () => {
    expect(scanTree(join(root, 'nope'))).toEqual([])
  })

  it('does not expose the .logvue app-data directory as a session', () => {
    writeSession(join(root, 'Visible'), { display_name: 'Visible' })
    mkdirSync(join(root, '.logvue'), { recursive: true })
    writeFileSync(join(root, '.logvue', 'index.sqlite'), 'internal')

    expect(scanTree(root).map((node) => node.name)).toEqual(['Visible'])
  })
})

describe('listFolderFiles', () => {
  it('lists loose files with guessed kinds, skipping plumbing', () => {
    const dir = join(root, 'Unsorted_Dump')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'AutoOpMode_log_1.rlog'), 'x')
    writeFileSync(join(dir, 'TeleOp_log_2.rlog'), 'xy')
    writeFileSync(join(dir, 'notes.md'), '# hi') // plumbing → skipped
    writeFileSync(join(dir, 'session.json'), '{}') // plumbing → skipped

    const files = listFolderFiles(dir)
    expect(files.map((f) => f.filename)).toEqual(['AutoOpMode_log_1.rlog', 'TeleOp_log_2.rlog'])
    expect(files[0]).toMatchObject({ kind: 'auto_log', sizeBytes: 1, tracked: false })
    expect(files[1]).toMatchObject({ kind: 'teleop_log', sizeBytes: 2, tracked: false })
  })

  it('marks files present in session.json as tracked and uses their curated kind', () => {
    const dir = join(root, 'Q4_Blue_B2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'DriveTest_log_9.rlog'), 'x')
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({
        schema_version: 1,
        session_type: 'official_match',
        display_name: 'Q4',
        files: [{ filename: 'DriveTest_log_9.rlog', kind: 'tuning_log', source: 'control_hub' }]
      })
    )
    const files = listFolderFiles(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ kind: 'tuning_log', tracked: true })
  })

  it('returns [] for a missing folder', () => {
    expect(listFolderFiles(join(root, 'nope'))).toEqual([])
  })

  it('drops session.json entries whose files were deleted from disk', () => {
    const dir = join(root, 'Q4_Blue_B2')
    writeSession(dir, {
      session_id: 'q4',
      session_type: 'official_match',
      display_name: 'Q4',
      files: [
        { filename: 'Present_log.rlog', kind: 'auto_log', source: 'control_hub' },
        { filename: 'Deleted_log.rlog', kind: 'teleop_log', source: 'control_hub' }
      ]
    })
    writeFileSync(join(dir, 'Present_log.rlog'), 'log')

    const session = getSession(dir)

    expect(session.metadata.files.map((file) => file.filename)).toEqual(['Present_log.rlog'])
    expect(scanTree(root)[0].logCount).toBe(1)
    // Passive reconciliation must not silently rewrite user-owned sidecars.
    expect(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf-8')).files).toHaveLength(2)
  })
})

describe('createSession', () => {
  it('creates a folder-safe dir and session.json without placeholder notes', () => {
    const s = createSession({ parentPath: root, displayName: 'Q4 Blue B2', sessionType: 'official_match' })
    expect(s.name).toBe('Q4_Blue_B2')
    expect(s.metadata.display_name).toBe('Q4 Blue B2')
    expect(s.metadata.session_type).toBe('official_match')
    expect(s.hasSessionJson).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(s.path, 'session.json'), 'utf-8'))
    expect(onDisk.session_id).toBeTruthy()
    expect(existsSync(join(s.path, 'notes.md'))).toBe(false)
  })

  it('disambiguates colliding names', () => {
    const a = createSession({ parentPath: root, displayName: 'Test', sessionType: 'test_session' })
    const b = createSession({ parentPath: root, displayName: 'Test', sessionType: 'test_session' })
    expect(a.name).toBe('Test')
    expect(b.name).toBe('Test_2')
  })
})

describe('promoteFolder', () => {
  it('writes discovery-default metadata for a bare folder', () => {
    const bare = join(root, 'Random_Folder')
    mkdirSync(bare, { recursive: true })
    expect(getSession(bare).hasSessionJson).toBe(false)
    const promoted = promoteFolder(bare)
    expect(promoted.hasSessionJson).toBe(true)
    expect(promoted.metadata.display_name).toBe('Random_Folder')
    expect(promoted.metadata.session_type).toBe('general_session')
    expect(existsSync(join(bare, 'notes.md'))).toBe(false)
  })

  it('mints a session_id only on write, never on read', () => {
    const bare = join(root, 'Random_Folder')
    mkdirSync(bare, { recursive: true })
    expect(getSession(bare).metadata.session_id).toBeUndefined() // reading is id-free
    const promoted = promoteFolder(bare)
    expect(promoted.metadata.session_id).toBeTruthy()
    // The persisted id is stable across subsequent reads and writes.
    expect(getSession(bare).metadata.session_id).toBe(promoted.metadata.session_id)
    expect(updateMeta(bare, { tags: ['x'] }).metadata.session_id).toBe(promoted.metadata.session_id)
  })

  it('leaves no temp files behind after atomic sidecar writes', () => {
    const s = createSession({ parentPath: root, displayName: 'Atomic', sessionType: 'general_session' })
    updateMeta(s.path, { tags: ['a'] })
    expect(readdirSync(s.path).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('cleans up stale temp files from an interrupted earlier write', () => {
    const s = createSession({ parentPath: root, displayName: 'Crashy', sessionType: 'general_session' })
    writeFileSync(join(s.path, 'session.json.99999.tmp'), '{ interrupted')
    updateMeta(s.path, { tags: ['recovered'] })
    expect(readdirSync(s.path).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  // POSIX-only: Windows chmod/stat only model the read-only attribute, so owner/
  // group/other bits can't round-trip there (stat reports a synthesized ~0o666).
  it.skipIf(process.platform === 'win32')(
    'preserves existing permission bits across an atomic replace',
    () => {
      const s = createSession({ parentPath: root, displayName: 'Private', sessionType: 'general_session' })
      const file = join(s.path, 'session.json')
      chmodSync(file, 0o600)
      updateMeta(s.path, { tags: ['secret'] })
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  )

  it('backs up an invalid session.json before replacing it, never silently destroying it', () => {
    const dir = join(root, 'Damaged')
    mkdirSync(dir, { recursive: true })
    const corrupt = '{ "display_name": "was hand-edited bad'
    writeFileSync(join(dir, 'session.json'), corrupt)

    const promoted = promoteFolder(dir)

    expect(promoted.hasSessionJson).toBe(true)
    expect(readFileSync(join(dir, 'session.json.bak'), 'utf-8')).toBe(corrupt) // original preserved
    const rewritten = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf-8'))
    expect(rewritten.display_name).toBe('Damaged')

    // A later invalid file gets its own backup rather than clobbering the first.
    writeFileSync(join(dir, 'session.json'), '{ corrupt again')
    updateMeta(dir, { tags: ['repaired'] })
    expect(readFileSync(join(dir, 'session.json.bak'), 'utf-8')).toBe(corrupt)
    expect(readFileSync(join(dir, 'session.json_2.bak'), 'utf-8')).toBe('{ corrupt again')
  })
})

describe('updateMeta', () => {
  it('merges a patch and bumps updated_at', async () => {
    const s = createSession({ parentPath: root, displayName: 'Tuning', sessionType: 'tuning_session' })
    const before = s.metadata.updated_at
    await new Promise((r) => setTimeout(r, 5))
    const updated = updateMeta(s.path, { tags: ['swerve', 'heading-pid'] })
    expect(updated.metadata.tags).toEqual(['swerve', 'heading-pid'])
    expect(updated.metadata.updated_at > before).toBe(true)
    expect(updated.metadata.display_name).toBe('Tuning') // preserved
  })
})

describe('deleteSession', () => {
  it('summarises and recursively deletes files, notes, and child folders', () => {
    const parent = createSession({
      parentPath: root,
      displayName: 'Heading PID',
      sessionType: 'tuning_session'
    })
    writeFileSync(join(parent.path, 'heading.rlog'), 'log')
    writeFileSync(join(parent.path, 'notes.md'), '# findings')
    const child = createSession({
      parentPath: parent.path,
      displayName: 'Child',
      sessionType: 'test_session'
    })
    writeFileSync(join(child.path, 'child.rlog'), 'log')

    expect(deleteSessionSummary(root, parent.path)).toMatchObject({
      path: parent.path,
      displayName: 'Heading PID',
      fileCount: 3,
      childFolderCount: 1
    })

    const deleted = deleteSession(root, parent.path)
    expect(deleted.fileCount).toBe(3)
    expect(existsSync(parent.path)).toBe(false)
  })

  it('reports an empty session without counting session.json as user data', () => {
    const session = createSession({
      parentPath: root,
      displayName: 'Empty',
      sessionType: 'general_session'
    })
    expect(deleteSessionSummary(root, session.path)).toMatchObject({
      fileCount: 0,
      childFolderCount: 0
    })
  })

  it('refuses to delete the archive root or a folder outside it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'logvue-outside-'))
    try {
      expect(() => deleteSessionSummary(root, root)).toThrow(/outside the archive root/)
      expect(() => deleteSessionSummary(root, outside)).toThrow(/outside the archive root/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('schema resilience', () => {
  it('falls back unknown enums to "other" and preserves unknown keys', () => {
    const m = parseSessionJson(
      { session_type: 'martian_session', display_name: 'X', custom_future_field: 42 },
      'Folder'
    )
    expect(m.session_type).toBe('other')
    expect((m as Record<string, unknown>).custom_future_field).toBe(42)
  })

  it('makeDefaultMetadata seeds display_name from folder name', () => {
    expect(makeDefaultMetadata('My_Folder').display_name).toBe('My_Folder')
  })
})

describe('toFolderName', () => {
  it('keeps names readable and filesystem-safe', () => {
    expect(toFolderName('Q4 Blue B2')).toBe('Q4_Blue_B2')
    expect(toFolderName('Drive: test/run?')).toBe('Drive_testrun')
    expect(toFolderName('  spaced  out  ')).toBe('spaced_out')
  })
})

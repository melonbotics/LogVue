import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractRlogMetadata } from '../src/main/services/rlog/rlogMetadata'
import { collectIndexRows } from '../src/main/services/index/rebuild'

// ── synthetic RLOG R2 builders (format: SpiderKit RLOGEncoder) ──

function timestamp(t: number): Buffer {
  const b = Buffer.alloc(9)
  b.writeUInt8(0, 0)
  b.writeDoubleBE(t, 1)
  return b
}

function keyDef(id: number, key: string, type: string): Buffer {
  const kb = Buffer.from(key, 'utf8')
  const tb = Buffer.from(type, 'utf8')
  const b = Buffer.alloc(1 + 2 + 2 + kb.length + 2 + tb.length)
  let pos = 0
  b.writeUInt8(1, pos); pos += 1
  b.writeInt16BE(id, pos); pos += 2
  b.writeUInt16BE(kb.length, pos); pos += 2
  kb.copy(b, pos); pos += kb.length
  b.writeUInt16BE(tb.length, pos); pos += 2
  tb.copy(b, pos)
  return b
}

function stringValue(id: number, value: string): Buffer {
  const vb = Buffer.from(value, 'utf8')
  const b = Buffer.alloc(1 + 2 + 2 + vb.length)
  b.writeUInt8(2, 0)
  b.writeInt16BE(id, 1)
  b.writeUInt16BE(vb.length, 3)
  vb.copy(b, 5)
  return b
}

function doubleValue(id: number, value: number): Buffer {
  const b = Buffer.alloc(1 + 2 + 2 + 8)
  b.writeUInt8(2, 0)
  b.writeInt16BE(id, 1)
  b.writeUInt16BE(8, 3)
  b.writeDoubleBE(value, 5)
  return b
}

function rlog(...records: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([2]), ...records])
}

const SAMPLE = rlog(
  timestamp(0.02),
  keyDef(0, '/Metadata/GitSHA', 'string'),
  stringValue(0, 'a1b2c3d4e5f6'),
  keyDef(1, '/Metadata/GitDirty', 'string'),
  stringValue(1, 'true'),
  keyDef(2, 'RealOutputs/Drivetrain/x', 'double'),
  doubleValue(2, 1.25),
  timestamp(0.04),
  doubleValue(2, 1.5)
)

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'logvue-rlog-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(name: string, data: Buffer): string {
  const p = join(root, name)
  writeFileSync(p, data)
  return p
}

describe('extractRlogMetadata', () => {
  it('extracts /Metadata string entries with the prefix stripped', () => {
    const path = write('a.rlog', SAMPLE)
    expect(extractRlogMetadata(path)).toEqual({ GitSHA: 'a1b2c3d4e5f6', GitDirty: 'true' })
  })

  it('ignores legacy metadata namespaces', () => {
    const path = write('b.rlog', rlog(
      timestamp(0),
      keyDef(0, 'RealMetadata/OpMode Name', 'string'),
      stringValue(0, 'FIELD CENTRIC')
    ))
    expect(extractRlogMetadata(path)).toEqual({})
  })

  it('accepts the standard /Metadata prefix', () => {
    const path = write('standard.rlog', rlog(
      timestamp(0),
      keyDef(0, '/Metadata/Build/gitVersion', 'string'),
      stringValue(0, 'a1b2c3d4e5f6-dirty')
    ))
    expect(extractRlogMetadata(path)).toEqual({ 'Build/gitVersion': 'a1b2c3d4e5f6-dirty' })
  })

  it('ignores non-string and non-metadata keys', () => {
    const path = write('c.rlog', rlog(
      timestamp(0),
      keyDef(0, '/Metadata/Odd', 'double'),
      doubleValue(0, 3),
      keyDef(1, 'RealOutputs/NotMeta', 'string'),
      stringValue(1, 'x')
    ))
    expect(extractRlogMetadata(path)).toEqual({})
  })

  it('returns null for an unsupported revision or unreadable file', () => {
    const bad = write('d.rlog', Buffer.from([9, 0, 0]))
    expect(extractRlogMetadata(bad)).toBeNull()
    expect(extractRlogMetadata(join(root, 'missing.rlog'))).toBeNull()
  })

  it('tolerates a file truncated mid-record', () => {
    const path = write('e.rlog', SAMPLE.subarray(0, SAMPLE.length - 5))
    expect(extractRlogMetadata(path)).toEqual({ GitSHA: 'a1b2c3d4e5f6', GitDirty: 'true' })
  })
})

describe('collectIndexRows file metadata', () => {
  it('emits file_metadata rows for rlogs found in a session folder', () => {
    const dir = join(root, 'TestSession')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.json'), JSON.stringify({
      schema_version: 1,
      session_id: 's-1',
      session_type: 'general_session',
      display_name: 'Test',
      tags: [],
      notes_file: 'notes.md',
      files: []
    }))
    writeFileSync(join(dir, 'Tele_log_1.rlog'), SAMPLE)
    writeFileSync(join(dir, 'notes.txt'), 'not a log')

    const { fileMeta } = collectIndexRows(root)
    expect(fileMeta).toEqual(
      expect.arrayContaining([
        { session_path: dir, filename: 'Tele_log_1.rlog', key: 'GitSHA', value: 'a1b2c3d4e5f6' },
        { session_path: dir, filename: 'Tele_log_1.rlog', key: 'GitDirty', value: 'true' }
      ])
    )
    expect(fileMeta).toHaveLength(2)
  })
})

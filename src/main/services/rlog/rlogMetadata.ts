import { closeSync, openSync, readSync } from 'fs'

/**
 * Extracts the metadata map from the head of a SpiderKit RLOG R2 file.
 *
 * `Logger.recordMetadata()` values are written as ordinary string records under
 * the `/Metadata/` subtable during the first
 * log cycle, so only the head of the file needs decoding — never the full log.
 *
 * On-disk format (see SpiderKit `RLOGEncoder`): byte 0 is the log revision (2),
 * then a stream of records, each prefixed with a 1-byte type:
 *   0x00 [double timestamp]                          — cycle delimiter
 *   0x01 [i16 keyId][u16 len][key][u16 len][type]    — key definition
 *   0x02 [i16 keyId][u16 len][payload]               — value update
 * All integers/doubles are big-endian; strings are UTF-8.
 */

/** How much of the file to read — the first cycle comfortably fits in this. */
const MAX_HEAD_BYTES = 128 * 1024
/** Stop after this many cycles; metadata is recorded before cycle 1 starts. */
const MAX_CYCLES = 8

const METADATA_KEY_RE = /^\/Metadata\//

/**
 * Metadata key → value from the head of an `.rlog` file, with the
 * metadata prefix stripped. Returns null when the file can't be read or
 * isn't a supported RLOG (wrong revision), and {} when it's a valid log that
 * simply recorded no metadata. Truncated trailing records are tolerated — the
 * scan just stops there.
 */
export function extractRlogMetadata(filePath: string): Record<string, string> | null {
  let buf: Buffer
  try {
    const fd = openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(MAX_HEAD_BYTES)
      const bytesRead = readSync(fd, head, 0, MAX_HEAD_BYTES, 0)
      buf = head.subarray(0, bytesRead)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  if (buf.length < 1 || buf[0] !== 2) return null

  const keyDefs = new Map<number, { key: string; type: string }>()
  const out: Record<string, string> = {}
  let pos = 1
  let cycles = 0

  while (pos < buf.length) {
    const recordType = buf[pos]
    pos += 1
    if (recordType === 0) {
      if (pos + 8 > buf.length) break
      pos += 8
      cycles += 1
      if (cycles > MAX_CYCLES) break
    } else if (recordType === 1) {
      if (pos + 4 > buf.length) break
      const keyId = buf.readInt16BE(pos)
      const keyLen = buf.readUInt16BE(pos + 2)
      pos += 4
      if (pos + keyLen + 2 > buf.length) break
      const key = buf.toString('utf8', pos, pos + keyLen)
      pos += keyLen
      const typeLen = buf.readUInt16BE(pos)
      pos += 2
      if (pos + typeLen > buf.length) break
      keyDefs.set(keyId, { key, type: buf.toString('utf8', pos, pos + typeLen) })
      pos += typeLen
    } else if (recordType === 2) {
      if (pos + 4 > buf.length) break
      const keyId = buf.readInt16BE(pos)
      const payloadLen = buf.readUInt16BE(pos + 2)
      pos += 4
      if (pos + payloadLen > buf.length) break
      const def = keyDefs.get(keyId)
      if (def?.type === 'string') {
        const match = METADATA_KEY_RE.exec(def.key)
        if (match) {
          out[def.key.slice(match[0].length)] = buf.toString('utf8', pos, pos + payloadLen)
        }
      }
      pos += payloadLen
    } else {
      // Unknown record type — likely desynced; stop rather than misread.
      break
    }
  }
  return out
}

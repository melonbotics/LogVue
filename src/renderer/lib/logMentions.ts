import type { FolderFile } from '@shared/types/session'

const MARKDOWN_MENTION_RE = /\[@([^\]]+)\]\(logvue-log:([^)]+)\)/g
const CANONICAL_RLOG_RE = /^(.+)_log_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(\d{3})(?:_\d+)?\.rlog$/i

export interface LogMentionCandidate {
  filename: string
  label: string
  opmode: string
  detail: string
}

export type NoteSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; filename: string; label: string }

function safelyDecodeFilename(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** Split notes Markdown into ordinary text and LogVue-owned log mentions. */
export function parseLogMentionMarkdown(value: string): NoteSegment[] {
  const segments: NoteSegment[] = []
  let offset = 0

  for (const match of value.matchAll(MARKDOWN_MENTION_RE)) {
    const index = match.index ?? 0
    if (index > offset) segments.push({ type: 'text', value: value.slice(offset, index) })

    const filename = safelyDecodeFilename(match[2])
    if (filename) segments.push({ type: 'mention', filename, label: match[1] })
    else segments.push({ type: 'text', value: match[0] })
    offset = index + match[0].length
  }

  if (offset < value.length) segments.push({ type: 'text', value: value.slice(offset) })
  return segments
}

/** Encode a mention as readable Markdown while keeping the exact filename as its target. */
export function logMentionMarkdown(filename: string, label: string): string {
  const safeLabel = label.replace(/]/g, '')
  // encodeURIComponent deliberately leaves parentheses unescaped, but `)` would
  // terminate the Markdown destination early. Encode its RFC 3986 exceptions too.
  const target = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `[@${safeLabel}](logvue-log:${target})`
}

/**
 * Compact, disambiguated presentation for canonical SpiderKit filenames. The date/time
 * suffix matters because a session commonly contains many logs from the same op-mode.
 */
export function toLogMentionCandidate(file: FolderFile): LogMentionCandidate {
  const canonical = CANONICAL_RLOG_RE.exec(file.filename)
  if (!canonical) {
    const opmode = file.filename.replace(/\.rlog$/i, '')
    return { filename: file.filename, label: opmode, opmode, detail: file.filename }
  }

  const [, opmode, year, month, day, hour, minute, second, millis] = canonical
  const when = `${year}-${month}-${day} ${hour}:${minute}:${second}.${millis}`
  return {
    filename: file.filename,
    label: `${opmode} · ${month}-${day} ${hour}:${minute}:${second}.${millis}`,
    opmode,
    detail: `${when} · ${file.filename}`
  }
}

function matchScore(candidate: LogMentionCandidate, query: string): number {
  if (!query) return 4
  const q = query.toLocaleLowerCase()
  const opmode = candidate.opmode.toLocaleLowerCase()
  const filename = candidate.filename.toLocaleLowerCase()
  if (opmode === q) return 0
  if (opmode.startsWith(q)) return 1
  if (opmode.includes(q)) return 2
  if (filename.includes(q)) return 3
  return Number.POSITIVE_INFINITY
}

/** Rank filename suggestions by op-mode first and retain the timestamp for disambiguation. */
export function suggestLogMentions(
  files: FolderFile[],
  query: string,
  limit = 8
): LogMentionCandidate[] {
  return files
    .filter((file) => file.filename.toLocaleLowerCase().endsWith('.rlog'))
    .map(toLogMentionCandidate)
    .map((candidate) => ({ candidate, score: matchScore(candidate, query) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || a.candidate.filename.localeCompare(b.candidate.filename))
    .slice(0, limit)
    .map(({ candidate }) => candidate)
}

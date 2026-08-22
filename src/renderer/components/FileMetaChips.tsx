import { useState } from 'react'

/** Chips shown before the "+N more" overflow toggle collapses the rest. */
const VISIBLE_CHIP_LIMIT = 6
/** Values longer than this are truncated in the chip (full value in the tooltip). */
const VALUE_DISPLAY_LIMIT = 24

/**
 * Presentation for metadata keys we recognise (our SpiderKit conventions). Anything
 * not listed falls through to a generic `key: value` chip, so unknown keys from
 * other teams' robot code still display — the registry is purely cosmetic.
 */
const KNOWN_KEYS: Record<string, { label: string; format?: (v: string) => string; warnWhen?: (v: string) => boolean }> = {
  GitSHA: { label: 'commit', format: (v) => v.slice(0, 7) },
  GitBranch: { label: 'branch' },
  GitDirty: {
    label: 'build',
    format: (v) => (isTruthy(v) ? 'dirty' : 'clean'),
    warnWhen: isTruthy
  },
  BuildDate: { label: 'built' },
  'OpMode Name': { label: 'opmode' },
  'OpMode type': { label: 'type' }
}

function isTruthy(v: string): boolean {
  return v === 'true' || v === '1'
}

function truncate(v: string): string {
  return v.length > VALUE_DISPLAY_LIMIT ? `${v.slice(0, VALUE_DISPLAY_LIMIT)}…` : v
}

/** Known keys first (in registry order), then the rest alphabetically. */
function orderedEntries(metadata: Record<string, string>): Array<[string, string]> {
  const known = Object.keys(KNOWN_KEYS).filter((k) => k in metadata)
  const rest = Object.keys(metadata)
    .filter((k) => !(k in KNOWN_KEYS))
    .sort((a, b) => a.localeCompare(b))
  return [...known, ...rest].map((k) => [k, metadata[k]])
}

/**
 * The RLOG-embedded metadata of one file as a row of chips. Click a chip to copy
 * its full value; long rows collapse behind a "+N more" toggle.
 */
export default function FileMetaChips({ metadata }: { metadata: Record<string, string> }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const entries = orderedEntries(metadata)
  const visible = expanded ? entries : entries.slice(0, VISIBLE_CHIP_LIMIT)
  const hidden = entries.length - visible.length

  return (
    <div className="file-meta">
      {visible.map(([key, value]) => {
        const known = KNOWN_KEYS[key]
        const display = known?.format?.(value) ?? truncate(value)
        const warn = known?.warnWhen?.(value) ?? false
        return (
          <button
            type="button"
            key={key}
            className={`chip meta${warn ? ' warn' : ''}`}
            title={`${key} = ${value}\n(click to copy)`}
            onClick={() => void navigator.clipboard.writeText(value)}
          >
            <span className="meta-key">{known?.label ?? key}</span> {display}
          </button>
        )
      })}
      {hidden > 0 && (
        <button type="button" className="chip meta more" onClick={() => setExpanded(true)}>
          +{hidden} more
        </button>
      )}
      {expanded && entries.length > VISIBLE_CHIP_LIMIT && (
        <button type="button" className="chip meta more" onClick={() => setExpanded(false)}>
          less
        </button>
      )}
    </div>
  )
}

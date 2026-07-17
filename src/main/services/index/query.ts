import type { SessionQuery } from '@shared/types/query'

/** A parametrised SQL fragment: the WHERE body (without the `WHERE` keyword) and its bound params. */
export interface BuiltQuery {
  /** WHERE clause without the leading `WHERE`; `'1'` when the query is empty (matches all). */
  where: string
  /** Named bind parameters referenced by `where`. */
  params: Record<string, unknown>
}

/** Escape user text so SQLite LIKE treats its wildcard and escape characters literally. */
export function escapeLikeText(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

/** Emit `col IN (@p0, @p1, …)` and register each value under a unique name. */
function inClause(
  col: string,
  values: readonly (string | number)[],
  prefix: string,
  params: Record<string, unknown>
): string {
  const names = values.map((v, i) => {
    const name = `${prefix}${i}`
    params[name] = v
    return `@${name}`
  })
  return `${col} IN (${names.join(', ')})`
}

/** Match a search term on the current session or any ancestor grouping session. */
function descendantTextMatch(param: string): string {
  // Stored session keys are archive-relative with '/' separators on every platform.
  const ancestorScope =
    `(s.path = ancestor.path OR ` +
    `(substr(s.path, 1, length(ancestor.path)) = ancestor.path ` +
    `AND substr(s.path, length(ancestor.path) + 1, 1) = '/'))`
  const ancestorText =
    `(ancestor.display_name LIKE @${param} ESCAPE '\\'` +
    ` OR ancestor.event_code LIKE @${param} ESCAPE '\\'` +
    ` OR EXISTS (SELECT 1 FROM session_tags ancestor_tag` +
    ` WHERE ancestor_tag.session_path = ancestor.path` +
    ` AND ancestor_tag.tag LIKE @${param} ESCAPE '\\'))`
  return `EXISTS (SELECT 1 FROM sessions ancestor WHERE ${ancestorScope} AND ${ancestorText})`
}

/**
 * Turn a {@link SessionQuery} into a parametrised WHERE body over the `sessions`
 * table aliased `s` (with `session_tags`/`files` reachable by correlated subquery).
 *
 * Pure and side-effect-free so it's unit-testable without the native sqlite binary.
 * Empty facets are skipped; blank/whitespace values are dropped; an empty query
 * yields `where: '1'` (match everything). All values are bound, never interpolated.
 */
export function buildSessionQuery(query: SessionQuery): BuiltQuery {
  const params: Record<string, unknown> = {}
  const clauses: string[] = []

  const text = query.text?.trim()
  if (text) {
    params.text = `%${escapeLikeText(text)}%`
    clauses.push(descendantTextMatch('text'))
  }

  const types = (query.sessionTypes ?? []).filter(Boolean)
  if (types.length) clauses.push(inClause('s.session_type', types, 'type', params))

  const events = (query.events ?? []).filter(Boolean)
  if (events.length) clauses.push(inClause('s.event_code', events, 'evt', params))

  const teams = (query.teams ?? []).filter((n) => Number.isFinite(n))
  if (teams.length) clauses.push(inClause('s.team_number', teams, 'team', params))

  const alliances = (query.alliances ?? []).filter(Boolean)
  if (alliances.length) clauses.push(inClause('s.alliance', alliances, 'alli', params))

  if (query.noAlliance) clauses.push(`(s.alliance IS NULL OR s.alliance = '')`)

  // Tags: session must carry EVERY listed tag → one EXISTS per tag.
  const tags = (query.tags ?? []).map((t) => t.trim()).filter(Boolean)
  tags.forEach((tag, i) => {
    const name = `tag${i}`
    params[name] = tag
    clauses.push(`EXISTS (SELECT 1 FROM session_tags t WHERE t.session_path = s.path AND t.tag = @${name})`)
  })

  // Has kind: session must contain a file of EVERY listed kind.
  const hasKinds = (query.hasKinds ?? []).filter(Boolean)
  hasKinds.forEach((kind, i) => {
    const name = `has${i}`
    params[name] = kind
    clauses.push(`EXISTS (SELECT 1 FROM files f WHERE f.session_path = s.path AND f.kind = @${name})`)
  })

  // Missing kind: session must contain a file of NONE of these kinds.
  const missingKinds = (query.missingKinds ?? []).filter(Boolean)
  missingKinds.forEach((kind, i) => {
    const name = `miss${i}`
    params[name] = kind
    clauses.push(`NOT EXISTS (SELECT 1 FROM files f WHERE f.session_path = s.path AND f.kind = @${name})`)
  })

  return { where: clauses.length ? clauses.join(' AND ') : '1', params }
}

import { describe, expect, it } from 'vitest'
import { buildSessionQuery } from '../src/main/services/index/query'
import { toSessionQuery } from '../src/renderer/stores/appStore'

describe('buildSessionQuery', () => {
  it('matches everything for an empty query', () => {
    const { where, params } = buildSessionQuery({})
    expect(where).toBe('1')
    expect(params).toEqual({})
  })

  it('ignores empty/blank facet arrays and blank text', () => {
    const { where } = buildSessionQuery({
      text: '   ',
      sessionTypes: [],
      teams: [],
      tags: ['  ']
    })
    expect(where).toBe('1')
  })

  it('builds a case-insensitive substring match over name, event, and tags', () => {
    const { where, params } = buildSessionQuery({ text: 'shooter' })
    expect(params.text).toBe('%shooter%')
    expect(where).toContain('ancestor.display_name LIKE @text')
    expect(where).toContain('ancestor.event_code LIKE @text')
    expect(where).toContain('session_tags')
    expect(where).toContain('sessions ancestor')
    expect(where).toContain('ancestor.path')
  })

  it('treats SQL LIKE wildcard characters as literal search text', () => {
    const { params } = buildSessionQuery({ text: String.raw`100%_ready\now` })

    expect(params.text).toBe(String.raw`%100\%\_ready\\now%`)
  })

  it('emits a parametrised IN clause for multi-value facets', () => {
    const { where, params } = buildSessionQuery({
      sessionTypes: ['official_match', 'practice_match']
    })
    expect(where).toBe('s.session_type IN (@type0, @type1)')
    expect(params).toEqual({ type0: 'official_match', type1: 'practice_match' })
  })

  it('drops non-finite team numbers', () => {
    const { where, params } = buildSessionQuery({ teams: [12345, NaN] })
    expect(where).toBe('s.team_number IN (@team0)')
    expect(params).toEqual({ team0: 12345 })
  })

  it('requires ALL tags via one EXISTS each, ANDed together', () => {
    const { where, params } = buildSessionQuery({ tags: ['localization', 'shooter'] })
    // One EXISTS-over-session_tags per requested tag (the clauses' own AND is internal).
    const existsCount = where.match(/EXISTS \(SELECT 1 FROM session_tags/g)?.length
    expect(existsCount).toBe(2)
    expect(where).toContain('@tag0')
    expect(where).toContain('@tag1')
    expect(params).toEqual({ tag0: 'localization', tag1: 'shooter' })
  })

  it('models noAlliance as NULL-or-empty on the alliance column', () => {
    const { where, params } = buildSessionQuery({ noAlliance: true })
    expect(where).toBe(`(s.alliance IS NULL OR s.alliance = '')`)
    expect(params).toEqual({})
  })

  it('models has-kind as EXISTS and missing-kind as NOT EXISTS', () => {
    const has = buildSessionQuery({ hasKinds: ['auto_log'] })
    expect(has.where).toContain('EXISTS (SELECT 1 FROM files f')
    expect(has.where).not.toContain('NOT EXISTS')

    const missing = buildSessionQuery({ missingKinds: ['teleop_log'] })
    expect(missing.where).toContain('NOT EXISTS (SELECT 1 FROM files f')
  })

  it('ANDs facets across categories with unique param names', () => {
    const { where, params } = buildSessionQuery({
      sessionTypes: ['official_match'],
      alliances: ['blue'],
      teams: [12345],
      hasKinds: ['auto_log'],
      missingKinds: ['teleop_log']
    })
    // No param name collisions across categories.
    expect(Object.keys(params).sort()).toEqual(['alli0', 'has0', 'miss0', 'team0', 'type0'])
    // Each category contributes its own top-level fragment.
    expect(where).toContain('s.session_type IN (@type0)')
    expect(where).toContain('s.alliance IN (@alli0)')
    expect(where).toContain('s.team_number IN (@team0)')
    expect(where).toContain('EXISTS (SELECT 1 FROM files f WHERE f.session_path = s.path AND f.kind = @has0)')
    expect(where).toContain('NOT EXISTS (SELECT 1 FROM files f WHERE f.session_path = s.path AND f.kind = @miss0)')
  })
})

describe('toSessionQuery', () => {
  it('maps simplified type chips to preserved session type buckets', () => {
    expect(toSessionQuery('', 'all', 'match').sessionTypes).toEqual(['official_match', 'replay'])
    expect(toSessionQuery('', 'all', 'practice').sessionTypes).toEqual(['practice_match'])
    expect(toSessionQuery('', 'all', 'general').sessionTypes).toEqual([
      'general_session',
      'workshop_session',
      'tuning_session',
      'debug_session',
      'test_session',
      'other'
    ])
  })
})

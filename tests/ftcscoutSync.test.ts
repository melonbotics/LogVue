import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FtcScoutEventPayload } from '../src/shared/types/ftcscout'
import type { FtcScoutClient } from '../src/main/services/ftcscout/FtcScoutClient'
import { createSession, getSession, updateMeta } from '../src/main/services/archive/ArchiveService'
import { syncFtcScoutEvent } from '../src/main/services/ftcscout/syncEvent'

const index = vi.hoisted(() => ({
  store: {
    putFtcScoutEvent: vi.fn(),
    getFtcScoutEvent: vi.fn()
  }
}))

vi.mock('../src/main/services/index/indexService', () => ({
  getIndexStore: () => index.store
}))

describe('FTCScout event sync', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'logvue-ftcscout-sync-'))
    index.store.putFtcScoutEvent.mockReset()
    index.store.getFtcScoutEvent.mockReset()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('updates FTCScout fields without clobbering local files, tags, notes, or custom children', async () => {
    const event = createSession({
      parentPath: root,
      displayName: 'APOC notes and scouting',
      sessionType: 'competition_event'
    })
    const match = createSession({
      parentPath: event.path,
      displayName: 'Our Q4 review',
      sessionType: 'official_match'
    })
    const importedFilename = 'TeleOp_log_1.rlog'
    writeFileSync(join(match.path, importedFilename), 'log')
    writeFileSync(join(match.path, 'notes.md'), '# Keep this diagnosis')
    updateMeta(match.path, {
      tags: ['driver-review'],
      files: [
        {
          filename: importedFilename,
          kind: 'teleop_log',
          source: 'control_hub',
          imported_at: '2026-07-04T01:15:00.000Z'
        }
      ],
      match: {
        ftcscout_id: 1004,
        label: 'Custom Q4 label',
        alliance: 'red',
        station: 'R1'
      }
    })
    const customChild = createSession({
      parentPath: event.path,
      displayName: 'Pit tuning',
      sessionType: 'tuning_session'
    })

    const payload: FtcScoutEventPayload = {
      season: 2026,
      code: 'APOC',
      name: 'Asia Pacific Open Championship',
      timezone: 'Australia/Sydney',
      start: '2026-07-04',
      end: '2026-07-05',
      hasMatches: true,
      lastSynced: '2026-07-03T22:00:00.000Z',
      matches: [
        {
          ftcscoutId: 1004,
          season: 2026,
          eventCode: 'APOC',
          tournamentLevel: 'Quals',
          series: 1,
          matchNum: 4,
          description: 'Qualification 4',
          scheduledStartTime: '2026-07-04T01:00:00.000Z',
          actualStartTime: '2026-07-04T01:03:00.000Z',
          hasBeenPlayed: true,
          match: {
            source: 'ftcscout',
            ftcscout_id: 1004,
            label: 'Q4',
            type: 'qualification',
            number: 4,
            alliance: 'blue',
            station: 'B2',
            team_number: 12345
          }
        }
      ]
    }
    const client = {
      fetchEventForTeam: vi.fn(async () => payload)
    } as unknown as FtcScoutClient
    const touched: string[] = []

    const result = await syncFtcScoutEvent(
      client,
      root,
      { eventPath: event.path, season: 2026, eventCode: ' apoc ', teamNumber: 12345 },
      undefined,
      (path) => touched.push(path)
    )

    const updated = getSession(match.path).metadata
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 0, fromCache: false })
    expect(client.fetchEventForTeam).toHaveBeenCalledWith(2026, 'APOC', 12345)
    expect(index.store.putFtcScoutEvent).toHaveBeenCalledWith(payload)
    expect(updated.display_name).toBe('Our Q4 review')
    expect(updated.tags).toEqual(['driver-review', 'ftcscout'])
    expect(updated.files.map((file) => file.filename)).toEqual([importedFilename])
    expect(updated.match).toMatchObject({ label: 'Q4', alliance: 'blue', station: 'B2' })
    expect(readFileSync(join(match.path, 'notes.md'), 'utf-8')).toBe('# Keep this diagnosis')
    expect(existsSync(customChild.path)).toBe(true)
    expect(getSession(customChild.path).metadata.session_type).toBe('tuning_session')
    expect(touched).toEqual([match.path, event.path])
  })
})

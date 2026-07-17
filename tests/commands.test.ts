import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionCommand,
  deleteSessionCommand,
  importHubLogCommand
} from '../src/main/commands'
import type { AdbLike } from '../src/main/services/adb/AdbClient'
import { createSession } from '../src/main/services/archive/ArchiveService'

describe('archive commands', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'logvue-command-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates metadata before reindexing and notifying renderers', () => {
    const calls: string[] = []
    const reindexSession = vi.fn((archiveRoot: string | null | undefined, path: string) => {
      expect(archiveRoot).toBe(root)
      expect(existsSync(join(path, 'session.json'))).toBe(true)
      calls.push('reindex')
    })
    const notifyArchiveChanged = vi.fn((archiveRoot: string, paths: string[]) => {
      expect(archiveRoot).toBe(root)
      calls.push('notify')
    })

    const session = createSessionCommand(
      root,
      {
        parentPath: root,
        displayName: 'Command seam',
        sessionType: 'tuning_session'
      },
      { reindexSession, notifyArchiveChanged }
    )

    const metadata = JSON.parse(readFileSync(join(session.path, 'session.json'), 'utf8'))
    expect(metadata).toMatchObject({
      display_name: 'Command seam',
      session_type: 'tuning_session'
    })
    expect(metadata.session_id).toEqual(expect.any(String))
    expect(reindexSession).toHaveBeenCalledWith(root, session.path)
    expect(notifyArchiveChanged).toHaveBeenCalledWith(root, [session.path])
    expect(calls).toEqual(['reindex', 'notify'])
  })

  it('imports under a watcher pause, then reindexes and notifies before completion', async () => {
    const session = createSession({
      parentPath: root,
      displayName: 'Import target',
      sessionType: 'test_session'
    })
    const calls: string[] = []
    const resumeWatcher = vi.fn(() => calls.push('resume'))
    const effects = {
      pauseArchiveWatcher: vi.fn(() => {
        calls.push('pause')
        return resumeWatcher
      }),
      reindexSession: vi.fn((_archiveRoot: string | null | undefined, path: string) => {
        const metadata = JSON.parse(readFileSync(join(path, 'session.json'), 'utf8'))
        expect(metadata.files).toHaveLength(1)
        calls.push('reindex')
      }),
      notifyArchiveChanged: vi.fn(() => calls.push('notify'))
    }
    const adb = {
      pull: vi.fn(async (_remotePath: string, destination: string) => {
        writeFileSync(destination, 'log')
      })
    }

    const result = await importHubLogCommand(
      adb as unknown as AdbLike,
      root,
      {
        remotePath: '/sdcard/FIRST/PsiKit/Test_log_1.rlog',
        filename: 'Test_log_1.rlog',
        fileSize: 3,
        sessionPath: session.path,
        force: true
      },
      { onFileEnd: () => calls.push('end') },
      effects
    )

    expect(result.status).toBe('imported')
    expect(effects.reindexSession).toHaveBeenCalledWith(root, session.path)
    expect(effects.notifyArchiveChanged).toHaveBeenCalledWith(root, [session.path])
    expect(calls).toEqual(['pause', 'reindex', 'notify', 'end', 'resume'])
  })

  it('always resumes the watcher when an import throws and skips projection side effects', async () => {
    const session = createSession({
      parentPath: root,
      displayName: 'Failed import target',
      sessionType: 'test_session'
    })
    const calls: string[] = []
    const effects = {
      pauseArchiveWatcher: vi.fn(() => {
        calls.push('pause')
        return () => calls.push('resume')
      }),
      reindexSession: vi.fn(),
      notifyArchiveChanged: vi.fn()
    }
    const adb = {
      pull: vi.fn(async () => {
        throw new Error('device disconnected')
      })
    }

    await expect(
      importHubLogCommand(
        adb as unknown as AdbLike,
        root,
        {
          remotePath: '/sdcard/FIRST/PsiKit/Failed_log_1.rlog',
          filename: 'Failed_log_1.rlog',
          fileSize: 3,
          sessionPath: session.path,
          force: true
        },
        undefined,
        effects
      )
    ).rejects.toThrow('device disconnected')

    expect(calls).toEqual(['pause', 'resume'])
    expect(effects.reindexSession).not.toHaveBeenCalled()
    expect(effects.notifyArchiveChanged).not.toHaveBeenCalled()
  })

  it('deletes archive truth before rebuilding the index and notifying renderers', () => {
    const session = createSession({
      parentPath: root,
      displayName: 'Delete through command',
      sessionType: 'test_session'
    })
    const calls: string[] = []
    const effects = {
      rebuild: vi.fn(() => {
        expect(existsSync(session.path)).toBe(false)
        calls.push('rebuild')
        return { sessions: 0, files: 0 }
      }),
      notifyArchiveChanged: vi.fn((_archiveRoot: string, paths: string[]) => {
        expect(paths).toEqual([session.path])
        calls.push('notify')
      })
    }

    const summary = deleteSessionCommand(root, session.path, effects)

    expect(summary.path).toBe(session.path)
    expect(effects.rebuild).toHaveBeenCalledWith(root)
    expect(effects.notifyArchiveChanged).toHaveBeenCalledWith(root, [session.path])
    expect(calls).toEqual(['rebuild', 'notify'])
  })
})

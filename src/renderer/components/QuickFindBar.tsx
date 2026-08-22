import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import type { SessionNode } from '@shared/types/session'
import {
  useAdbStatus,
  useArchiveTree,
  useHubLogs,
  useHubTime,
  useImportBatchToSession,
  useImportToNewSession,
  useLogQuery,
  useSession,
  useSettings
} from '../api/hooks'
import { allianceClass } from '../lib/alliance'
import {
  dateSessionKey,
  latestSessionLogTime,
  logsForQuickCatchUp,
  sessionLogIsFromEarlierDay
} from '../lib/hubLogSelection'
import { correctedHubTimestamp, formatRelative, formatTimestamp } from '../lib/time'
import { findNode } from '../lib/tree'
import StaleSessionImportDialog from './StaleSessionImportDialog'

/**
 * The quick-find bar above the archive view: free-text search and a "Latest"
 * jump button.
 */
export default function QuickFindBar({
  onNewTopLevel
}: {
  onNewTopLevel: () => void
}): JSX.Element {
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const select = useAppStore((s) => s.select)
  const focusLog = useAppStore((s) => s.focusLog)
  const selectedPath = useAppStore((s) => s.selectedPath)
  const [showStaleWarning, setShowStaleWarning] = useState(false)
  const { data: settings } = useSettings()
  const { data: adb } = useAdbStatus()
  const sourceIsFolder = settings?.hubDataSource === 'folder'
  const sourceConnected = sourceIsFolder ? !!settings?.hubLogFolder : !!adb?.connected
  const sourceName = sourceIsFolder ? 'Folder Import' : 'Control Hub'
  const { data: hubLogs, isLoading: hubLogsLoading } = useHubLogs(sourceConnected)
  const { data: hubTime } = useHubTime(sourceConnected)
  const importBatch = useImportBatchToSession()
  const importNew = useImportToNewSession()

  function activateSearch(): void {
    // Search results live in the Library dashboard. Selecting the root here makes
    // search work immediately even when the user is viewing a session.
    select(null)
  }

  // Unfiltered query — the latest log across the whole archive.
  const { data: allLogs } = useLogQuery({})
  const { data: tree } = useArchiveTree(true)
  const selectedNode = selectedPath && tree ? findNode(tree, selectedPath) : null
  const activeSessionNode = selectedNode?.hasSessionJson ? selectedNode : null
  const { data: activeSession, isLoading: activeSessionLoading } = useSession(
    activeSessionNode?.path ?? null
  )
  const latest = allLogs?.[0]
  const latestPath = latest ? (tree ? findNode(tree, latest.sessionPath)?.path ?? latest.sessionPath : latest.sessionPath) : null
  const dateKey = dateSessionKey()
  const catchUpLogs = logsForQuickCatchUp(hubLogs ?? [])
  const importing = importBatch.isPending || importNew.isPending
  const quickTargetLabel = activeSessionNode?.displayName ?? dateKey
  const activeFiles = activeSession?.metadata.files ?? []
  const activeSessionIsStale = !!activeSessionNode && sessionLogIsFromEarlierDay(activeFiles)
  const latestActiveLogTime = latestSessionLogTime(activeFiles)

  async function importCatchUp(target: 'active' | 'date'): Promise<void> {
    if (!settings?.archiveRoot || !tree || catchUpLogs.length === 0 || importing) return
    const existingDateSession = tree.find(
      (node: SessionNode) => node.displayName === dateKey || node.name === dateKey
    )
    const refs = catchUpLogs.map((log) => ({
      remotePath: log.remote_path,
      filename: log.filename,
      fileSize: log.file_size_bytes,
      recordedAt: correctedHubTimestamp(
        log.parsed_timestamp,
        hubTime?.hubTimezoneOffsetMinutes ?? null,
        hubTime?.offsetMs ?? 0
      )
    }))
    if (target === 'active' && activeSessionNode) {
      await importBatch.mutateAsync({
        sessionPath: activeSessionNode.path,
        logs: refs,
        force: false
      })
    } else if (existingDateSession) {
      await importBatch.mutateAsync({
        sessionPath: existingDateSession.path,
        logs: refs,
        force: false
      })
    } else {
      await importNew.mutateAsync({
        parentPath: settings.archiveRoot,
        displayName: dateKey,
        sessionType: 'general_session',
        logs: refs
      })
    }
    setShowStaleWarning(false)
  }

  function requestCatchUpImport(): void {
    if (activeSessionIsStale) {
      setShowStaleWarning(true)
      return
    }
    void importCatchUp(activeSessionNode ? 'active' : 'date').catch(() => {})
  }

  return (
    <div className="quickfind">
      <div className="quickfind-search">
        <input
          id="library-search-input"
          type="text"
          value={search}
          onFocus={activateSearch}
          onChange={(e) => {
            activateSearch()
            setSearch(e.target.value)
          }}
          placeholder="Search — try an opmode, “red”, “blue”, a tag, or a filename…"
        />
        <button
          className="quick-btn library-import-btn"
          disabled={
            !sourceConnected ||
            hubLogsLoading ||
            !tree ||
            (!!activeSessionNode && activeSessionLoading) ||
            catchUpLogs.length === 0 ||
            importing
          }
          onClick={requestCatchUpImport}
          title={
            !sourceConnected
              ? `${sourceName} unavailable`
              : catchUpLogs.length === 0
                ? 'No unimported logs newer than the latest imported log'
                : catchUpLogs.length === 1
                  ? `Import the latest unimported log into ${quickTargetLabel}`
                  : `Import all unimported logs newer than the latest imported log into ${quickTargetLabel}`
          }
        >
          {importing
            ? 'Importing…'
            : catchUpLogs.length === 0
              ? `Up to date → ${quickTargetLabel}`
              : catchUpLogs.length === 1
                ? `Import latest → ${quickTargetLabel}`
                : `Import ${catchUpLogs.length} new logs → ${quickTargetLabel}`}
        </button>
        {latest && (
          <button
            className="latest-btn"
            onClick={() => latestPath && focusLog(latestPath, latest.filename)}
            title={latest.filename}
          >
            <span className={`dot ${allianceClass(latest.alliance)}`} />
            <span className="muted">Latest:</span>
            <span className="latest-name">
              {latest.opmode ?? latest.filename} · {latest.sessionLabel}
            </span>
            {latest.recorded && <span className="latest-when">{formatRelative(latest.recorded)}</span>}
          </button>
        )}
        <button className="sm quick-new-session-btn" onClick={onNewTopLevel}>
          + New session
        </button>
      </div>
      {showStaleWarning && activeSessionNode && latestActiveLogTime !== null && (
        <StaleSessionImportDialog
          sessionLabel={activeSessionNode.displayName}
          dateKey={dateKey}
          latestLogLabel={formatTimestamp(new Date(latestActiveLogTime).toISOString())}
          logCount={catchUpLogs.length}
          busy={importing}
          onCancel={() => setShowStaleWarning(false)}
          onUseCurrentSession={() => void importCatchUp('active').catch(() => {})}
          onUseDateSession={() => void importCatchUp('date').catch(() => {})}
        />
      )}
    </div>
  )
}

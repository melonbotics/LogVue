import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ADB_NOT_FOUND_HINT } from '@shared/constants/adb'
import { formatBytes } from '@shared/format/bytes'
import type { SessionNode } from '@shared/types/session'
import type { HubLog, ImportStatus } from '@shared/types/hublog'
import {
  useAdbStatus,
  useArchiveTree,
  useHubLogs,
  useHubTime,
  useIgnoreHubLog,
  useImportBatchToSession,
  useImportToNewSession,
  useSettings,
  useUnignoreHubLog
} from '../api/hooks'
import { useAppStore } from '../stores/appStore'
import { guessAlliance } from '../lib/alliance'
import { dateSessionKey } from '../lib/hubLogSelection'
import {
  correctedHubTimestamp,
  formatHubOffset,
  formatRecentTimestamp,
  formatTimestamp
} from '../lib/time'
import ImportDialog from './ImportDialog'

/** Control Hub view: the remote `.rlog` files, with selection + import/ignore actions (spec §10). */
export default function HubLogTable(): JSX.Element {
  const qc = useQueryClient()
  const { data: settings } = useSettings()
  const { data: adb } = useAdbStatus()
  const sourceIsFolder = settings?.hubDataSource === 'folder'
  const connected = sourceIsFolder ? !!settings?.hubLogFolder : !!adb?.connected
  const sourceName = sourceIsFolder ? 'Folder Import' : 'Control Hub'
  const { data: logs, isLoading, isError, error } = useHubLogs(connected)
  const { data: hubTime, isLoading: hubTimeLoading, isError: hubTimeError } = useHubTime(connected)
  const { data: tree } = useArchiveTree(true)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showIgnored, setShowIgnored] = useState(false)
  const [correctHubTime, setCorrectHubTime] = useState(true)
  const [dialog, setDialog] = useState<{ logs: HubLog[]; mode: 'existing' | 'new' } | null>(null)
  const selectionAnchor = useRef<string | null>(null)

  const ignore = useIgnoreHubLog()
  const unignore = useUnignoreHubLog()
  const importBatch = useImportBatchToSession()
  const importNew = useImportToNewSession()
  const shade = useAppStore((s) => s.shade)

  // By default hide ignored logs (spec §15); keep selection in sync with what's shown.
  const visible = useMemo(
    () => (logs ?? []).filter((l) => showIgnored || l.import_status.state !== 'ignored'),
    [logs, showIgnored]
  )
  const ignoredCount = (logs ?? []).filter((l) => l.import_status.state === 'ignored').length

  if (sourceIsFolder && !settings?.hubLogFolder) {
    return <Notice title="No folder selected">Choose a hub log folder in Settings.</Notice>
  }
  if (!sourceIsFolder && adb?.adbMissing) return <Notice title="adb not found">{ADB_NOT_FOUND_HINT}</Notice>
  if (!connected) {
    return (
      <Notice title="No Control Hub connected">
        Connect the Control Hub over USB (or Wi-Fi ADB) and it will appear here. Status refreshes
        automatically.
      </Notice>
    )
  }
  if (isLoading) return <div className="details-empty">Reading logs from {sourceIsFolder ? 'the folder' : 'the hub'}…</div>
  if (isError) {
    return <Notice title="Couldn’t read logs">{(error as Error)?.message ?? 'ADB command failed.'}</Notice>
  }
  if (!logs || logs.length === 0) {
    return <Notice title="No .rlog files found">
      {sourceIsFolder ? 'No .rlog files were found in the selected folder.' : 'Nothing under the hub’s SpiderKit log folder yet.'}
    </Notice>
  }

  const selectedLogs = visible.filter((l) => selected.has(l.remote_path))
  const allShownSelected = visible.length > 0 && visible.every((l) => selected.has(l.remote_path))
  const importing = importBatch.isPending || importNew.isPending
  const dateKey = dateSessionKey()

  function toggle(path: string, extendRange = false) {
    const anchor = selectionAnchor.current
    setSelected((prev) => {
      const next = new Set(prev)
      const shouldSelect = !prev.has(path)
      const anchorIndex = anchor
        ? visible.findIndex((log) => log.remote_path === anchor)
        : -1
      const targetIndex = visible.findIndex((log) => log.remote_path === path)

      if (extendRange && anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        for (const log of visible.slice(start, end + 1)) {
          if (shouldSelect) next.add(log.remote_path)
          else next.delete(log.remote_path)
        }
      } else if (shouldSelect) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return next
    })
    selectionAnchor.current = path
  }
  function toggleAll() {
    setSelected(allShownSelected ? new Set() : new Set(visible.map((l) => l.remote_path)))
    selectionAnchor.current = null
  }
  function openDialog(target: HubLog[], mode: 'existing' | 'new') {
    if (target.length > 0) setDialog({ logs: target, mode })
  }

  /** Import without a dialog into today's root-level date session. */
  async function quickImport(target: HubLog[]) {
    if (target.length === 0 || !settings?.archiveRoot || importing) return
    const existingDateSession = (tree ?? []).find(
      (node: SessionNode) => node.displayName === dateKey || node.name === dateKey
    )
    const refs = target.map((l) => ({
      remotePath: l.remote_path,
      filename: l.filename,
      fileSize: l.file_size_bytes,
      recordedAt: correctHubTime
        ? correctedHubTimestamp(l.parsed_timestamp, hubTime?.hubTimezoneOffsetMinutes ?? null, hubTime?.offsetMs ?? 0)
        : null
    }))
    if (existingDateSession) {
      await importBatch.mutateAsync({ sessionPath: existingDateSession.path, logs: refs, force: false })
    } else {
      await importNew.mutateAsync({
        parentPath: settings.archiveRoot,
        displayName: dateKey,
        sessionType: 'general_session',
        logs: refs
      })
    }
    setSelected(new Set())
    selectionAnchor.current = null
  }

  return (
    <div className="hublogs">
      <div className="hublogs-head">
        <h3>
          {sourceName} <span className="muted small">({visible.length})</span>
        </h3>
        <div className="hublogs-actions">
          <button
            className="ghost sm"
            onClick={() => qc.invalidateQueries({ queryKey: ['adb', 'hubLogs'] })}
          >
            Refresh logs
          </button>
          <button
            className="sm"
            disabled={selectedLogs.length === 0 || importing}
            onClick={() => openDialog(selectedLogs, 'existing')}
          >
            Import selected…
          </button>
          <button
            className="ghost sm"
            disabled={selectedLogs.length === 0 || importing}
            onClick={() => openDialog(selectedLogs, 'new')}
          >
            New session…
          </button>
          {ignoredCount > 0 && (
            <label className="show-ignored small">
              <input
                type="checkbox"
                checked={showIgnored}
                onChange={(e) => setShowIgnored(e.target.checked)}
              />
              Show ignored ({ignoredCount})
            </label>
          )}
          <label className="show-ignored small" title="Apply the clock offset between this computer and the log source">
            <input
              type="checkbox"
              checked={correctHubTime}
              onChange={(e) => setCorrectHubTime(e.target.checked)}
              disabled={hubTimeLoading || hubTimeError || !hubTime}
            />
            Correct log time {hubTime ? `(${formatHubOffset(hubTime.offsetMs)})` : hubTimeLoading ? '(checking...)' : ''}
          </label>
        </div>
      </div>

      <div className="table-wrap">
        <table className="hublog-table">
          <thead>
            <tr>
              <th className="pick">
                <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              <th>Op-mode</th>
              <th>Recorded</th>
              <th className="num">Size</th>
              <th>Status</th>
              <th>Filename</th>
              <th className="row-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((log) => (
              <Row
                key={log.remote_path}
                log={log}
                recorded={
                  correctHubTime
                    ? correctedHubTimestamp(
                        log.parsed_timestamp,
                        hubTime?.hubTimezoneOffsetMinutes ?? null,
                        hubTime?.offsetMs ?? 0
                      )
                    : log.parsed_timestamp
                }
                tint={shade === 'tint'}
                checked={selected.has(log.remote_path)}
                onToggle={(extendRange) => toggle(log.remote_path, extendRange)}
                onImport={() => openDialog([log], 'existing')}
                onQuickImport={() => quickImport([log])}
                quickTargetLabel={dateKey}
                onIgnore={() =>
                  ignore.mutate({
                    remotePath: log.remote_path,
                    filename: log.filename,
                    fileSize: log.file_size_bytes
                  })
                }
                onUnignore={() => unignore.mutate(log.remote_path)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {dialog && settings?.archiveRoot && (
        <ImportDialog
          logs={dialog.logs}
          archiveRoot={settings.archiveRoot}
          correctHubTime={correctHubTime}
          hubTime={hubTime}
          initialMode={dialog.mode}
          onImported={() => {
            setSelected(new Set())
            selectionAnchor.current = null
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

interface RowProps {
  log: HubLog
  recorded: string | null
  tint: boolean
  checked: boolean
  onToggle: (extendRange: boolean) => void
  onImport: () => void
  onQuickImport: () => void
  quickTargetLabel: string
  onIgnore: () => void
  onUnignore: () => void
}

function Row({
  log,
  recorded,
  tint,
  checked,
  onToggle,
  onImport,
  onQuickImport,
  quickTargetLabel,
  onIgnore,
  onUnignore
}: RowProps): JSX.Element {
  const ignored = log.import_status.state === 'ignored'
  const colour = guessAlliance(log.opmode, log.filename)
  return (
    <tr
      className={`${checked ? 'is-selected ' : ''}${ignored ? 'is-ignored' : ''}${tint ? ` tint-${colour}` : ''}`}
      aria-selected={checked}
      onClick={(event) => onToggle(event.shiftKey)}
    >
      <td className={`pick striped ${colour}`}>
        <input
          type="checkbox"
          checked={checked}
          readOnly
          onClick={(event) => {
            event.stopPropagation()
            onToggle(event.shiftKey)
          }}
          aria-label={`Select ${log.filename}`}
        />
      </td>
      <td>
        <span className="opmode-cell">
          <span className={`dot ${colour}`} />
          {log.opmode ?? <span className="muted">—</span>}
        </span>
      </td>
      <td className="mono" title={formatTimestamp(recorded)}>
        {formatRecentTimestamp(recorded)}
      </td>
      <td className="num mono">{formatBytes(log.file_size_bytes)}</td>
      <td>
        <StatusBadge status={log.import_status} />
      </td>
      <td className="mono filename" title={log.remote_path}>
        {log.filename}
      </td>
      <td className="row-actions" onClick={(event) => event.stopPropagation()}>
        <button className="link-btn" onClick={onImport}>
          Import
        </button>
        <button
          className="link-btn quick"
          onClick={onQuickImport}
          title={`Import straight into ${quickTargetLabel}`}
        >
          Quick import
        </button>
        {ignored ? (
          <button className="link-btn muted" onClick={onUnignore}>
            Un-ignore
          </button>
        ) : (
          <button className="link-btn muted" onClick={onIgnore}>
            Ignore
          </button>
        )}
      </td>
    </tr>
  )
}

function StatusBadge({ status }: { status: ImportStatus }): JSX.Element {
  if (status.state === 'imported') {
    return (
      <span className="pill imported" title={status.sessionPath}>
        ✓ {status.sessionLabel}
      </span>
    )
  }
  if (status.state === 'ignored') return <span className="pill ignored">Ignored</span>
  return <span className="pill new">Not imported</span>
}

function Notice({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="hublogs hub-notice-wrap">
      <div className="callout hub-notice">
        <div>
          <strong>{title}</strong>
          <p className="muted small">{children}</p>
        </div>
      </div>
    </div>
  )
}

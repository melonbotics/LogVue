import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AppSettings } from '@shared/types/session'
import type { McpStatus } from '@shared/types/ipc'
import {
  useAdbStatus,
  useAgentOpModeStatus,
  useConnectAdb,
  useMcpStatus,
  usePickArchiveRoot,
  useSetAgentOpModeControlEnabled
} from '../api/hooks'
import { useAppStore } from '../stores/appStore'

const MCP_ACTIVE_WINDOW_MS = 5 * 60 * 1000

interface Props {
  settings: AppSettings
  onSettings: () => void
  onMcpSetup: () => void
}

export default function Toolbar({ settings, onSettings, onMcpSetup }: Props): JSX.Element {
  const pick = usePickArchiveRoot()
  const qc = useQueryClient()
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const { data: adb } = useAdbStatus()
  const { data: mcp } = useMcpStatus()
  const { data: agentOpMode } = useAgentOpModeStatus()
  const setAgentOpModeControl = useSetAgentOpModeControlEnabled()
  const connect = useConnectAdb()
  const sourceIsFolder = settings.hubDataSource === 'folder'
  const sourceName = sourceIsFolder ? 'Folder Import' : 'Control Hub'
  const sourceConnected = sourceIsFolder ? !!settings.hubLogFolder : !!adb?.connected
  const sourceLabel = sourceIsFolder
    ? settings.hubLogFolder
      ? 'folder source'
      : 'folder not set'
    : adb?.adbMissing
      ? 'adb not found'
      : adb?.connected
        ? adb.device ?? 'Control Hub'
        : 'not connected'

  return (
    <header className="toolbar">
      <span className="brand">LogVue</span>

      <div className="root">
        <span className="root-label">Library</span>
        <code className="root-path" title={settings.archiveRoot ?? ''}>
          {settings.archiveRoot ?? 'none'}
        </code>
        <button className="ghost sm" onClick={() => pick.mutate()}>
          Change…
        </button>
      </div>

      <div className="source-switch">
        <div className="tabs" role="tablist">
          <button
            className={`tab ${view === 'archive' ? 'active' : ''}`}
            role="tab"
            aria-selected={view === 'archive'}
            onClick={() => setView('archive')}
          >
            Library
          </button>
          <button
            className={`tab ${view === 'simulate' ? 'active' : ''}`}
            role="tab"
            aria-selected={view === 'simulate'}
            onClick={() => setView('simulate')}
          >
            Simulate
          </button>
          <button
            className={`tab ${view === 'device' ? 'active' : ''}`}
            role="tab"
            aria-selected={view === 'device'}
            onClick={() => setView('device')}
          >
            Control Hub
          </button>
        </div>
        <SourceBadge
          connected={sourceConnected}
          label={sourceLabel}
          sourceName={sourceName}
          address={settings.adbAddress}
          connecting={connect.isPending}
          onConnect={!sourceIsFolder && !adb?.adbMissing ? () => connect.mutate() : undefined}
        />
      </div>

      <div className="spacer" />

      {agentOpMode?.operatorEnabled && (
        <button
          type="button"
          className="source-status agent-control-live"
          title="Disable agent OpMode control immediately"
          disabled={setAgentOpModeControl.isPending}
          onClick={() => setAgentOpModeControl.mutate(false)}
        >
          <span className="dot" />
          <span>
            {setAgentOpModeControl.isPending
              ? 'Disabling agent control…'
              : `Agent control ${agentOpMode.state === 'active' ? 'ON' : agentOpMode.state}`}
          </span>
          {!setAgentOpModeControl.isPending && <span className="agent-control-disable">· disable</span>}
        </button>
      )}

      <McpBadge status={mcp} onClick={onMcpSetup} />

      <button className="ghost sm" onClick={onSettings}>
        Settings
      </button>

      {view === 'device' && (
        <button className="ghost sm" onClick={() => qc.invalidateQueries({ queryKey: ['adb', 'hubLogs'] })}>
          Refresh logs
        </button>
      )}

    </header>
  )
}

function McpBadge({ status, onClick }: { status: McpStatus | undefined; onClick: () => void }): JSX.Element {
  const available = !!status?.running && !!status.discoveryReady && !!status.bridgeReady
  const lastRequestMs = status?.lastRequestAt ? Date.parse(status.lastRequestAt) : Number.NaN
  const [, refreshClock] = useState(0)

  useEffect(() => {
    if (!available || !Number.isFinite(lastRequestMs)) return
    const remainingMs = lastRequestMs + MCP_ACTIVE_WINDOW_MS - Date.now()
    if (remainingMs <= 0) return
    const timer = window.setTimeout(() => refreshClock((tick) => tick + 1), remainingMs)
    return () => window.clearTimeout(timer)
  }, [available, lastRequestMs])

  const recentlyUsed =
    available && Number.isFinite(lastRequestMs) && Date.now() - lastRequestMs < MCP_ACTIVE_WINDOW_MS
  const availabilityLabel = !status
    ? 'MCP checking…'
    : available
      ? recentlyUsed
        ? 'MCP active'
        : 'MCP ready'
      : status.running
        ? 'MCP setup incomplete'
        : 'MCP unavailable'
  const stateClass = recentlyUsed ? 'active' : available ? 'ready' : 'off'

  return (
    <button
      type="button"
      className={`source-status mcp-status ${stateClass}`}
      title="Open MCP setup instructions"
      onClick={onClick}
    >
      <span className="dot" />
      <span>{availabilityLabel}</span>
    </button>
  )
}

function SourceBadge({
  connected,
  label,
  sourceName,
  address,
  connecting,
  onConnect
}: {
  connected: boolean
  label: string
  sourceName: string
  address: string
  connecting: boolean
  onConnect?: () => void
}): JSX.Element {
  const connectable = !!onConnect && !connected
  const displayLabel = connecting ? 'Connecting ADB…' : connectable ? 'Connect ADB' : label
  return (
    <button
      type="button"
      className={`source-status ${connected ? 'ok' : 'off'}${connectable ? ' connectable' : ''}${connecting ? ' connecting' : ''}`}
      title={
        connectable
          ? `Connect ADB to ${address}`
          : `${sourceName}: ${connected ? 'connected' : 'disconnected'}`
      }
      onClick={connectable ? onConnect : undefined}
      disabled={!connectable || connecting}
    >
      <span className="dot" />
      <span>{displayLabel}</span>
    </button>
  )
}

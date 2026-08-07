import { useState } from 'react'
import type { AppSettings } from '@shared/types/session'
import { formatRelative } from '../lib/time'
import {
  useAgentOpModeStatus,
  useMcpStatus,
  useSetAgentOpModeControlEnabled
} from '../api/hooks'

interface Props {
  settings: AppSettings
  onClose: () => void
}

function toWslPath(path: string): string {
  const windows = /^([a-zA-Z]):[\\/](.*)$/.exec(path)
  return windows ? `/mnt/${windows[1].toLowerCase()}/${windows[2].replace(/\\/g, '/')}` : path
}

export default function McpSetupDialog({ settings, onClose }: Props): JSX.Element {
  const { data: status } = useMcpStatus()
  const { data: opModeStatus } = useAgentOpModeStatus()
  const setOpModeControl = useSetAgentOpModeControlEnabled()
  const [copied, setCopied] = useState<string | null>(null)
  const available = !!status?.running && !!status.discoveryReady && !!status.bridgeReady
  const discoveryPath = status?.discoveryPath ?? '<LogVue user-data>/mcp.json'
  const bridgePath = status?.bridgePath ?? '<LogVue user-data>/logvue-mcp.cjs'
  const wslBridgePath = toWslPath(bridgePath)
  const clientBridgePath = wslBridgePath !== bridgePath ? wslBridgePath : bridgePath
  const quotedBridgePath = JSON.stringify(clientBridgePath)
  const serverConfig = JSON.stringify({ type: 'stdio', command: 'node', args: [bridgePath] }, null, 2)
  const wslServerConfig =
    wslBridgePath === bridgePath
      ? null
      : JSON.stringify({ type: 'stdio', command: 'node', args: [wslBridgePath] }, null, 2)
  const codexCommand = `codex mcp add logvue -- node ${quotedBridgePath}`
  const claudeCommand = `claude mcp add --scope user logvue -- node ${quotedBridgePath}`

  async function copyText(label: string, value: string): Promise<void> {
    await navigator.clipboard.writeText(value)
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1600)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal mcp-setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-setup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="mcp-setup-title">MCP setup</h2>

        <div className={`mcp-setup-state ${available ? 'available' : 'unavailable'}`}>
          <span className="dot" />
          <span>
            {available
              ? `Available${status?.lastRequestAt ? ` · last request ${formatRelative(status.lastRequestAt)}` : ''}`
              : status?.running
                ? 'Running, but discovery is not ready'
                : 'Not available'}
          </span>
        </div>

        <p className="mcp-setup-intro">
          Add LogVue as a local stdio MCP server once in your agent client. This setup remains valid when LogVue is
          closed, updated, or using a different library. The bridge contacts LogVue only when one of its tools is
          called.
        </p>

        <section className="settings-section vertical">
          <h3>1. LogVue MCP files</h3>
          <span className="muted small">LogVue keeps the bridge at this stable per-user path:</span>
          <code className="settings-path" title={bridgePath}>
            {bridgePath}
          </code>
          <span className="muted small">Its connection details are managed automatically in:</span>
          <code className="settings-path" title={discoveryPath}>{discoveryPath}</code>
          <span className="muted small">Active library:</span>
          <code className="settings-path" title={settings.archiveRoot ?? ''}>
            {settings.archiveRoot ?? 'No library selected'}
          </code>
        </section>

        <section className="settings-section vertical agent-opmode-control">
          <div className="agent-opmode-heading">
            <div>
              <h3>Agent OpMode control</h3>
              <span className="muted small">
                Runtime-only operator permission. It always starts disabled when LogVue launches.
              </span>
            </div>
            <button
              type="button"
              className={opModeStatus?.operatorEnabled ? 'danger sm' : 'sm'}
              disabled={
                setOpModeControl.isPending ||
                (!opModeStatus?.operatorEnabled && settings.hubDataSource !== 'adb')
              }
              onClick={() =>
                setOpModeControl.mutate(!(opModeStatus?.operatorEnabled ?? false))
              }
            >
              {setOpModeControl.isPending
                ? 'Updating…'
                : opModeStatus?.operatorEnabled
                  ? 'Disable control'
                  : 'Enable control'}
            </button>
          </div>

          <div className={`agent-opmode-state state-${opModeStatus?.state ?? 'disabled'}`}>
            <span className="dot" />
            <strong>
              {!opModeStatus
                ? 'Checking lease worker…'
                : opModeStatus.state === 'active'
                  ? 'Robot lease active'
                  : opModeStatus.state === 'degraded'
                    ? 'Lease heartbeat degraded'
                    : opModeStatus.state === 'acquiring'
                      ? 'Waiting for robot lease…'
                      : 'Agent control disabled'}
            </strong>
            {opModeStatus?.lastHeartbeatAt && (
              <span className="muted small">
                · last heartbeat ACK {heartbeatAge(opModeStatus.lastHeartbeatAt)}
              </span>
            )}
          </div>

          {opModeStatus?.operatorEnabled && (
            <div className="agent-opmode-details small">
              <span>Dashboard: {booleanState(opModeStatus.dashboardEnabled)}</span>
              <span>Robot agent gate: {booleanState(opModeStatus.agentControlArmed)}</span>
              <span>Robot available: {booleanState(opModeStatus.robotAvailable)}</span>
              {opModeStatus.endpoint && <code>{opModeStatus.endpoint}</code>}
            </div>
          )}

          {settings.hubDataSource !== 'adb' && (
            <span className="warning small">Select Control Hub as the Hub Log Source before enabling.</span>
          )}
          {(setOpModeControl.error || opModeStatus?.lastError) && (
            <span className="warning small">
              {setOpModeControl.error instanceof Error
                ? setOpModeControl.error.message
                : opModeStatus?.lastError}
            </span>
          )}
          <p className="agent-opmode-warning">
            Enabling this lets an MCP agent initialize, start, and stop robot OpModes. On the Driver Station,
            run <code>Enable/Disable Agent OpMode Control</code> from the <code>Dashboard</code> group and press
            Start to arm the independent robot-side gate. Keep the robot secured and the field clear;
            disabling this switch releases the lease and the robot watchdog stops any agent-owned OpMode.
          </p>
        </section>

        <section className="settings-section vertical">
          <h3>2. Add the local MCP server</h3>
          <span className="muted small">
            Use these standard stdio server details in any MCP-compatible client running on the same operating
            system as LogVue.
          </span>
          <code className="mcp-command">{serverConfig}</code>
          <button
            type="button"
            className="ghost sm mcp-copy-button"
            onClick={() => void copyText('config', serverConfig)}
          >
            {copied === 'config' ? 'Copied' : 'Copy server configuration'}
          </button>
          {wslServerConfig && (
            <>
              <span className="muted small">For a client running inside WSL, use the WSL-visible path:</span>
              <code className="mcp-command">{wslServerConfig}</code>
              <button
                type="button"
                className="ghost sm mcp-copy-button"
                onClick={() => void copyText('wsl-config', wslServerConfig)}
              >
                {copied === 'wsl-config' ? 'Copied' : 'Copy WSL server configuration'}
              </button>
            </>
          )}
        </section>

        <section className="settings-section vertical">
          <h3>Client shortcuts</h3>
          <span className="muted small">
            These commands register the same server details in common clients
            {wslServerConfig ? ' running inside WSL.' : '.'}
          </span>
          <span className="muted small">Codex</span>
          <code className="mcp-command">{codexCommand}</code>
          <button type="button" className="ghost sm mcp-copy-button" onClick={() => void copyText('codex', codexCommand)}>
            {copied === 'codex' ? 'Copied' : 'Copy Codex command'}
          </button>
          <span className="muted small">Claude Code</span>
          <code className="mcp-command">{claudeCommand}</code>
          <button type="button" className="ghost sm mcp-copy-button" onClick={() => void copyText('claude', claudeCommand)}>
            {copied === 'claude' ? 'Copied' : 'Copy Claude Code command'}
          </button>
        </section>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function booleanState(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'enabled' : 'disabled'
}

function heartbeatAge(timestamp: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(timestamp))
  return `${Math.floor(ageMs / 1000)}s ago`
}

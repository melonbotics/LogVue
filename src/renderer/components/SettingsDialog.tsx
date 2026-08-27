import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types/session'
import { api } from '../api/client'
import {
  useClearHubLogFolder,
  useAppInfo,
  usePickArchiveRoot,
  usePickHubLogFolder,
  useRebuildIndex,
  useSetAdbAddress,
  useSetConfirmDeletePopulatedSessions,
  useSetFolderTimeOffsetMinutes,
  useSetHubDataSource
} from '../api/hooks'

interface Props {
  settings: AppSettings
  onClose: () => void
}

export default function SettingsDialog({ settings, onClose }: Props): JSX.Element {
  const { data: appInfo } = useAppInfo()
  const [adbAddress, setAdbAddressDraft] = useState(settings.adbAddress)
  const [folderTimeOffset, setFolderTimeOffsetDraft] = useState(
    String(settings.folderTimeOffsetMinutes)
  )
  const pickLibrary = usePickArchiveRoot()
  const rebuild = useRebuildIndex()
  const setAdbAddress = useSetAdbAddress()
  const setHubDataSource = useSetHubDataSource()
  const pickHubLogFolder = usePickHubLogFolder()
  const clearHubLogFolder = useClearHubLogFolder()
  const setFolderTimeOffset = useSetFolderTimeOffsetMinutes()
  const setDeleteConfirmation = useSetConfirmDeletePopulatedSessions()
  const busy =
    pickLibrary.isPending ||
    rebuild.isPending ||
    setHubDataSource.isPending ||
    pickHubLogFolder.isPending ||
    clearHubLogFolder.isPending ||
    setFolderTimeOffset.isPending ||
    setDeleteConfirmation.isPending ||
    setAdbAddress.isPending

  useEffect(() => setAdbAddressDraft(settings.adbAddress), [settings.adbAddress])
  useEffect(
    () => setFolderTimeOffsetDraft(String(settings.folderTimeOffsetMinutes)),
    [settings.folderTimeOffsetMinutes]
  )

  function commitAdbAddress(): void {
    const trimmed = adbAddress.trim()
    if (trimmed && trimmed !== settings.adbAddress) setAdbAddress.mutate(trimmed)
  }

  function commitFolderTimeOffset(): void {
    const minutes = Number(folderTimeOffset)
    if (Number.isFinite(minutes) && minutes !== settings.folderTimeOffsetMinutes) {
      setFolderTimeOffset.mutate(minutes)
    } else if (!Number.isFinite(minutes)) {
      setFolderTimeOffsetDraft(String(settings.folderTimeOffsetMinutes))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => e.preventDefault()}
      >
        <h2>Settings</h2>

        <section className="settings-section vertical">
          <div>
            <h3>Library</h3>
            <code className="settings-path" title={settings.archiveRoot ?? ''}>
              {settings.archiveRoot ?? 'No folder selected'}
            </code>
            <span className="muted small">
              Rescan after changing library folders outside LogVue.
            </span>
          </div>
          <div className="settings-section-actions">
            <button
              type="button"
              className="ghost sm"
              onClick={() => pickLibrary.mutate()}
              disabled={busy}
            >
              Change…
            </button>
            <button
              type="button"
              className="ghost sm"
              onClick={() => rebuild.mutate()}
              disabled={busy}
            >
              {rebuild.isPending ? 'Rescanning…' : 'Rescan library'}
            </button>
          </div>
        </section>

        <section className="settings-section vertical">
          <h3>Hub Log Source</h3>
          <div className="seg" role="tablist">
            <button
              type="button"
              className={`seg-btn ${settings.hubDataSource === 'adb' ? 'active' : ''}`}
              onClick={() => setHubDataSource.mutate('adb')}
              disabled={busy}
            >
              Control Hub
            </button>
            <button
              type="button"
              className={`seg-btn ${settings.hubDataSource === 'folder' ? 'active' : ''}`}
              onClick={() => setHubDataSource.mutate('folder')}
              disabled={busy}
            >
              Folder Import
            </button>
          </div>

          {settings.hubDataSource === 'adb' && (
            <label className="field">
              Wireless ADB address
              <input
                value={adbAddress}
                onChange={(e) => setAdbAddressDraft(e.target.value)}
                onBlur={commitAdbAddress}
                placeholder="192.168.43.1:5555"
                disabled={busy}
              />
              <span className="muted small">Used by the Connect action in the status pill.</span>
            </label>
          )}

          {settings.hubDataSource === 'folder' && (
            <>
              <div className="folder-source-selection">
                <span className="folder-source-label">Selected folder</span>
                <div className="folder-source-row">
                  <code
                    className={`folder-path-block${settings.hubLogFolder ? '' : ' empty'}`}
                    title={settings.hubLogFolder ?? ''}
                  >
                    {settings.hubLogFolder ?? 'No folder selected'}
                  </code>
                  <button
                    type="button"
                    className="ghost sm"
                    onClick={() => pickHubLogFolder.mutate()}
                    disabled={busy}
                  >
                    Choose…
                  </button>
                  {settings.hubLogFolder && (
                    <button
                      type="button"
                      className="ghost sm"
                      onClick={() => clearHubLogFolder.mutate()}
                      disabled={busy}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <label className="field">
                Manual folder time correction (minutes)
                <input
                  type="number"
                  step="1"
                  value={folderTimeOffset}
                  onChange={(e) => setFolderTimeOffsetDraft(e.target.value)}
                  onBlur={commitFolderTimeOffset}
                  disabled={busy}
                />
                <span className="muted small">
                  Added to folder log timestamps. Use a positive value to move them later or a
                  negative value to move them earlier.
                </span>
              </label>
            </>
          )}
        </section>

        <section className="settings-section vertical">
          <h3>Deletion</h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.confirmDeletePopulatedSessions}
              onChange={(e) => setDeleteConfirmation.mutate(e.target.checked)}
              disabled={busy}
            />
            Confirm before deleting sessions containing files or child folders
          </label>
          <span className="muted small">
            Empty sessions are deleted immediately. You can restore confirmations here after choosing
            “Don’t ask again”.
          </span>
        </section>

        <section className="settings-section vertical about-section">
          <h3>About LogVue</h3>
          <div className="about-copy">
            <strong>LogVue {appInfo ? `v${appInfo.appVersion}` : ''}</strong>
            <span className="muted small">© 2026 Jack Wilson · BSD 3-Clause License</span>
            <span className="muted small">
              Third-party software notices and license texts are included with this app.
            </span>
          </div>
          <button
            type="button"
            className="ghost sm about-notices-button"
            onClick={() => void api.openThirdPartyNotices()}
          >
            View third-party notices
          </button>
        </section>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </form>
    </div>
  )
}

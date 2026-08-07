import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useArchiveTree, useSettings } from './api/hooks'
import { useAppStore } from './stores/appStore'
import { findNode } from './lib/tree'
import Toolbar from './components/Toolbar'
import QuickFindBar from './components/QuickFindBar'
import SessionTree from './components/SessionTree'
import SessionDetails from './components/SessionDetails'
import LogDashboard from './components/LogDashboard'
import HubLogTable from './components/HubLogTable'
import EmptyState from './components/EmptyState'
import NewSessionDialog from './components/NewSessionDialog'
import SettingsDialog from './components/SettingsDialog'
import McpSetupDialog from './components/McpSetupDialog'
import ActivityToasts from './components/ActivityToasts'

// Toggle to make typing anywhere jump to the Library search box (disabled: felt intrusive).
const TYPE_TO_SEARCH = false

export default function App(): JSX.Element {
  const { data: settings, isLoading } = useSettings()
  const { data: tree } = useArchiveTree(!!settings?.archiveRoot)
  const selectedPath = useAppStore((s) => s.selectedPath)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const select = useAppStore((s) => s.select)
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const qc = useQueryClient()

  // When set, holds the parent folder we're creating a session under.
  const [newParent, setNewParent] = useState<{ path: string; label: string } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showMcpSetup, setShowMcpSetup] = useState(false)

  // Typing anywhere outside an input jumps to the Library view's search/dashboard.
  useEffect(() => {
    if (!TYPE_TO_SEARCH) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return

      e.preventDefault()
      if (view !== 'archive') setView('archive')
      if (selectedPath) select(null)
      setSearch(search + e.key)
      requestAnimationFrame(() => {
        const input = document.getElementById('library-search-input') as HTMLInputElement | null
        input?.focus()
        input?.setSelectionRange(input.value.length, input.value.length)
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, selectedPath, search, setView, select, setSearch])

  useEffect(() => {
    return window.api.onArchiveChanged(() => {
      qc.invalidateQueries({ queryKey: ['archive', 'tree'] })
      qc.invalidateQueries({ queryKey: ['archive', 'session'] })
      qc.invalidateQueries({ queryKey: ['archive', 'files'] })
      qc.invalidateQueries({ queryKey: ['index'] })
      qc.invalidateQueries({ queryKey: ['adb', 'hubLogs'] })
    })
  }, [qc])

  if (isLoading) return <div className="boot">Starting LogVue…</div>
  if (!settings?.archiveRoot) return <EmptyState />

  const selectedSessionPath =
    selectedPath && tree ? findNode(tree, selectedPath)?.path ?? selectedPath : selectedPath

  return (
    <div className="shell">
      <Toolbar
        settings={settings}
        onNewTopLevel={() => setNewParent({ path: settings.archiveRoot as string, label: 'Library' })}
        onSettings={() => setShowSettings(true)}
        onMcpSetup={() => setShowMcpSetup(true)}
      />

      {view === 'device' ? (
        <main className="pane detail-pane">
          <HubLogTable />
        </main>
      ) : (
        <>
          <QuickFindBar />
          <div className="panes">
            <aside className="pane tree-pane">
              <SessionTree />
            </aside>

            <main className="pane detail-pane">
              {selectedSessionPath ? (
                <SessionDetails
                  path={selectedSessionPath}
                  onNewChild={() => setNewParent({ path: selectedSessionPath, label: 'this session' })}
                />
              ) : (
                <LogDashboard />
              )}
            </main>
          </div>
        </>
      )}

      {newParent && (
        <NewSessionDialog
          parentPath={newParent.path}
          parentLabel={newParent.label}
          onClose={() => setNewParent(null)}
        />
      )}
      {showSettings && <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} />}
      {showMcpSetup && (
        <McpSetupDialog settings={settings} onClose={() => setShowMcpSetup(false)} />
      )}
      <ActivityToasts />
    </div>
  )
}

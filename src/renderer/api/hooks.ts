import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppSettings, CreateSessionInput, SessionMetadata } from '@shared/types/session'
import type {
  BatchImportRequest,
  HubLogRef,
  ImportRequest,
  NewSessionImportRequest
} from '@shared/types/import'
import type { SessionQuery } from '@shared/types/query'
import type { FtcScoutEventSearchRequest, FtcScoutSyncRequest } from '@shared/types/ftcscout'
import { api } from './client'

const keys = {
  appInfo: ['app', 'info'] as const,
  settings: ['settings'] as const,
  tree: ['archive', 'tree'] as const,
  session: (path: string) => ['archive', 'session', path] as const,
  files: (path: string) => ['archive', 'files', path] as const,
  notes: (path: string) => ['archive', 'notes', path] as const,
  adbStatus: ['adb', 'status'] as const,
  mcpStatus: ['mcp', 'status'] as const,
  agentOpModeStatus: ['mcp', 'agentOpModeStatus'] as const,
  hubTime: ['adb', 'hubTime'] as const,
  hubLogs: ['adb', 'hubLogs'] as const,
  query: (q: SessionQuery) => ['index', 'query', q] as const,
  logQuery: (q: SessionQuery) => ['index', 'queryLogs', q] as const,
  librarySize: ['index', 'librarySize'] as const,
  ftcScoutEvents: (q: FtcScoutEventSearchRequest) => ['ftcscout', 'events', q] as const
}

export function useAppInfo() {
  return useQuery({ queryKey: keys.appInfo, queryFn: api.getInfo, staleTime: Infinity })
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.settings.get })
}

export function useArchiveTree(enabled: boolean) {
  return useQuery({ queryKey: keys.tree, queryFn: api.archive.tree, enabled })
}

export function useSession(path: string | null) {
  return useQuery({
    queryKey: keys.session(path ?? ''),
    queryFn: () => api.archive.getSession(path as string),
    enabled: !!path
  })
}

/** The files physically inside a folder/session on disk (spec §16 — see logs without importing). */
export function useFolderFiles(path: string | null) {
  return useQuery({
    queryKey: keys.files(path ?? ''),
    queryFn: () => api.archive.listFiles(path as string),
    enabled: !!path
  })
}

export function useShowFile() {
  return useMutation({
    mutationFn: ({ path, filename }: { path: string; filename: string }) =>
      api.archive.showFile(path, filename)
  })
}

export function useShowFolder() {
  return useMutation({
    mutationFn: (path: string) => api.archive.showFolder(path)
  })
}

export function useOpenFile() {
  return useMutation({
    mutationFn: ({ path, filename }: { path: string; filename: string }) =>
      api.archive.openFile(path, filename)
  })
}

export function useNotes(path: string | null) {
  return useQuery({
    queryKey: keys.notes(path ?? ''),
    queryFn: () => api.archive.readNotes(path as string),
    enabled: !!path
  })
}

/**
 * Filter/search the session index (spec §12). `keepPreviousData` keeps the last
 * results on screen while a refined query is in flight, so the list doesn't flash
 * empty on each keystroke/toggle.
 */
export function useSessionQuery(query: SessionQuery, enabled: boolean) {
  return useQuery({
    queryKey: keys.query(query),
    queryFn: () => api.index.query(query),
    enabled,
    placeholderData: (prev) => prev
  })
}

/**
 * Log-level filter/search for the "All logs" dashboard. Same keepPreviousData
 * trick as {@link useSessionQuery} so rows don't flash away per keystroke.
 */
export function useLogQuery(query: SessionQuery, enabled = true) {
  return useQuery({
    queryKey: keys.logQuery(query),
    queryFn: () => api.index.queryLogs(query),
    enabled,
    placeholderData: (prev) => prev
  })
}

/** Total bytes of every indexed file — the library size pill. Fresh as of the last reindex. */
export function useLibrarySize() {
  return useQuery({ queryKey: keys.librarySize, queryFn: api.index.librarySize })
}

/** Open the native picker and persist the chosen archive root. */
export function usePickArchiveRoot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const path = await api.settings.pickRoot()
      if (!path) return null
      return api.settings.setRoot(path)
    },
    onSuccess: (settings) => {
      if (settings) {
        qc.setQueryData(keys.settings, settings)
        qc.invalidateQueries({ queryKey: keys.tree })
      }
    }
  })
}

/** Explicitly rebuild the disposable index from the archive on disk. */
export function useRebuildIndex() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.archive.rebuildIndex,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['archive'] })
      qc.invalidateQueries({ queryKey: ['index'] })
    }
  })
}

export function useSetTeamNumber() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (teamNumber: number | null) => api.settings.setTeamNumber(teamNumber),
    onSuccess: (settings) => qc.setQueryData(keys.settings, settings)
  })
}

function invalidateHubSource(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: keys.adbStatus })
  qc.invalidateQueries({ queryKey: keys.hubLogs })
  qc.invalidateQueries({ queryKey: keys.hubTime })
}

export function useSetHubDataSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (source: AppSettings['hubDataSource']) => api.settings.setHubDataSource(source),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings)
      invalidateHubSource(qc)
    }
  })
}

export function usePickHubLogFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const path = await api.settings.pickHubLogFolder()
      if (!path) return null
      return api.settings.setHubLogFolder(path)
    },
    onSuccess: (settings) => {
      if (settings) {
        qc.setQueryData(keys.settings, settings)
        invalidateHubSource(qc)
      }
    }
  })
}

export function useClearHubLogFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.settings.setHubLogFolder(null),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings)
      invalidateHubSource(qc)
    }
  })
}

export function useSetFolderTimeOffsetMinutes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (minutes: number) => api.settings.setFolderTimeOffsetMinutes(minutes),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings)
      invalidateHubSource(qc)
    }
  })
}

export function useSetAdbAddress() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (address: string) => api.settings.setAdbAddress(address),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings)
      qc.invalidateQueries({ queryKey: keys.adbStatus })
    }
  })
}

export function useSetConfirmDeletePopulatedSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (confirm: boolean) => api.settings.setConfirmDeletePopulatedSessions(confirm),
    onSuccess: (settings) => qc.setQueryData(keys.settings, settings)
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSessionInput) => api.archive.createSession(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.tree })
      qc.invalidateQueries({ queryKey: ['index'] })
    }
  })
}

export function useUpdateMeta(path: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<SessionMetadata>) => api.archive.updateMeta(path, patch),
    onSuccess: (session) => {
      qc.setQueryData(keys.session(path), session)
      qc.invalidateQueries({ queryKey: keys.tree })
      qc.invalidateQueries({ queryKey: ['index'] })
    }
  })
}

export function usePromoteFolder(path: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.archive.promoteFolder(path),
    onSuccess: (session) => {
      qc.setQueryData(keys.session(path), session)
      qc.invalidateQueries({ queryKey: keys.tree })
      qc.invalidateQueries({ queryKey: ['index'] })
    }
  })
}

/** Inspect recursive delete impact immediately before presenting confirmation. */
export function useDeleteSessionSummary() {
  return useMutation({
    mutationFn: (path: string) => api.archive.deleteSessionSummary(path)
  })
}

/** Delete a session, then remove stale detail data and refresh every affected view. */
export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => api.archive.deleteSession(path),
    onSuccess: (_summary, path) => {
      qc.removeQueries({ queryKey: keys.session(path) })
      qc.removeQueries({ queryKey: keys.files(path) })
      qc.removeQueries({ queryKey: keys.notes(path) })
      qc.invalidateQueries({ queryKey: keys.tree })
      qc.invalidateQueries({ queryKey: ['index'] })
      qc.invalidateQueries({ queryKey: keys.hubLogs })
    }
  })
}

/**
 * Notes writes take their target path per-call rather than closing over it, so a
 * deferred/autosave flush can still land on the session that was being edited
 * even after the selection has moved on.
 */
export function useWriteNotes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ path, md }: { path: string; md: string }) => api.archive.writeNotes(path, md),
    onSuccess: (_r, { path, md }) => qc.setQueryData(keys.notes(path), md)
  })
}

/**
 * ADB connection status. Polled on an interval so plug/unplug transitions surface
 * without a manual refresh (a pragmatic stand-in for the `adb:changed` push event;
 * see ARCHITECTURE §5 — the push emitter is a later refinement).
 */
export function useAdbStatus() {
  return useQuery({
    queryKey: keys.adbStatus,
    queryFn: api.adb.status,
    refetchInterval: 4000,
    refetchOnWindowFocus: true
  })
}

/** MCP is a stateless HTTP endpoint, so poll its availability and last request time. */
export function useMcpStatus() {
  return useQuery({
    queryKey: keys.mcpStatus,
    queryFn: api.mcp.status,
    refetchInterval: 5000,
    refetchOnWindowFocus: true
  })
}

/** Worker-thread lease health. Polling observes heartbeats but never calls the robot status/nonce route. */
export function useAgentOpModeStatus() {
  return useQuery({
    queryKey: keys.agentOpModeStatus,
    queryFn: api.mcp.agentOpModeStatus,
    refetchInterval: 1000,
    refetchOnWindowFocus: true
  })
}

export function useSetAgentOpModeControlEnabled() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => api.mcp.setAgentOpModeControlEnabled(enabled),
    onSuccess: (status) => qc.setQueryData(keys.agentOpModeStatus, status)
  })
}

export function useConnectAdb() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.adb.connect,
    onSuccess: (status) => qc.setQueryData(keys.adbStatus, status)
  })
}

export function useHubTime(enabled: boolean) {
  return useQuery({
    queryKey: keys.hubTime,
    queryFn: api.adb.getHubTime,
    enabled,
    refetchOnWindowFocus: true
  })
}

/** List of hub `.rlog` files with import status. Only runs while `enabled` (device view + connected). */
export function useHubLogs(enabled: boolean) {
  return useQuery({ queryKey: keys.hubLogs, queryFn: api.adb.listHubLogs, enabled })
}

/**
 * After an import the hub-log statuses and the touched session change, so refresh
 * the log list, the tree (file counts), and any open session view.
 */
function useImportRefresh() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: keys.hubLogs })
    qc.invalidateQueries({ queryKey: keys.tree })
    qc.invalidateQueries({ queryKey: ['archive', 'session'] })
    qc.invalidateQueries({ queryKey: ['archive', 'files'] })
    qc.invalidateQueries({ queryKey: ['index'] })
  }
}

/** Import a remote log into an existing session (spec §7.4). May resolve to a duplicate warning. */
export function useImportToSession() {
  const refresh = useImportRefresh()
  return useMutation({
    mutationFn: (req: ImportRequest) => api.import.toSession(req),
    onSuccess: (res) => {
      if (res.status === 'imported') refresh()
    }
  })
}

/**
 * Import several logs into one existing session. The loop lives in main so the batch
 * is a single activity toast; results come back one per log, in order.
 */
export function useImportBatchToSession() {
  const refresh = useImportRefresh()
  return useMutation({
    mutationFn: (req: BatchImportRequest) => api.import.batchToSession(req),
    onSuccess: (results) => {
      if (results.some((r) => r.status === 'imported')) refresh()
    }
  })
}

/** Create a session from selected logs and import them into it (spec §10). */
export function useImportToNewSession() {
  const refresh = useImportRefresh()
  return useMutation({
    mutationFn: (req: NewSessionImportRequest) => api.import.toNewSession(req),
    onSuccess: () => refresh()
  })
}

export function useIgnoreHubLog() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entry: HubLogRef) => api.adb.ignoreHubLog(entry),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.hubLogs })
  })
}

export function useUnignoreHubLog() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (remotePath: string) => api.adb.unignoreHubLog(remotePath),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.hubLogs })
  })
}

export function useFtcScoutSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: FtcScoutSyncRequest) => api.ftcscout.syncEvent(req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.tree })
      qc.invalidateQueries({ queryKey: ['archive', 'session'] })
      qc.invalidateQueries({ queryKey: ['index'] })
    }
  })
}

export function useFtcScoutEventSearch(query: FtcScoutEventSearchRequest, enabled: boolean) {
  return useQuery({
    queryKey: keys.ftcScoutEvents(query),
    queryFn: () => api.ftcscout.searchEvents(query),
    enabled,
    placeholderData: (prev) => prev
  })
}

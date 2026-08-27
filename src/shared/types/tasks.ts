/**
 * Background-task progress (the activity toast stack).
 *
 * Long-running work in main — importing hub logs, rebuilding the index, syncing
 * FTCScout — announces itself as a {@link Task} and pushes a fresh snapshot on the
 * `tasks:update` channel whenever anything changes. The renderer keys tasks by `id`
 * and re-renders; there are no deltas to reconcile.
 *
 * Only work the *user* asked for gets a task. The archive watcher's own rebuild is
 * silent — it fires after every import and would otherwise spam the stack.
 */

import type { ImportRequest } from './import'

export type TaskKind = 'import' | 'reindex' | 'ftcscout' | 'adb' | 'simulation'

export type TaskStatus = 'running' | 'success' | 'error'

export type TaskItemStatus = 'queued' | 'active' | 'done' | 'failed' | 'duplicate'

/** One unit of a task — a file being pulled, a match being scaffolded. */
export interface TaskItem {
  /** Stable within the task: a remote path, or an FTCScout match id. */
  id: string
  label: string
  status: TaskItemStatus
  /** Right-hand read-out: `1.8 MB`, `2.1 / 3.1 MB`, `device busy`, `queued`. */
  detail: string | null
  /**
   * A failed import, carried back so the toast's Retry button can re-run exactly
   * this file as a fresh forced import. Absent on anything that can't be retried.
   */
  retry?: ImportRequest
}

export interface Task {
  id: string
  kind: TaskKind
  status: TaskStatus
  title: string
  subtitle: string | null
  /**
   * False when we can't observe how far along the work is, and the bar shimmers
   * instead of filling. The index rebuild is synchronous inside main and reports
   * nothing until it returns, so it is always indeterminate.
   */
  determinate: boolean
  /** Settled items (done + failed + duplicate) out of `total`. */
  done: number
  total: number
  items: TaskItem[]
  bytesDone: number
  /** 0 when no item's size is known — suppresses the rate/ETA line. */
  bytesTotal: number
  /** Smoothed; null until two byte samples exist. */
  bytesPerSec: number | null
  etaSeconds: number | null
  /** Standing warning while the task runs, e.g. `DB LOCKED`. */
  badge: string | null
  /** Terminal only: the one-line outcome, e.g. `11 imported · 1 failed`. */
  summary: string | null
  error: string | null
  /** Session to open from the toast's "View session →" link. */
  targetPath: string | null
  startedAt: number
  endedAt: number | null
}

/** True when a finished task ended cleanly and can auto-dismiss. */
export function isCleanSuccess(task: Task): boolean {
  return task.status === 'success' && !task.items.some((i) => i.status === 'failed')
}

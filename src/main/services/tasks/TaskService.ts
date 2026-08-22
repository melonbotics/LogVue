import { formatBytes } from '@shared/format/bytes'
import type { Task, TaskItem, TaskItemStatus, TaskKind } from '@shared/types/tasks'
import { emitIpcEvent } from '../../ipc/events'

/**
 * The registry behind the activity toast stack. `start()` returns a handle the
 * caller drives; every mutation broadcasts a full {@link Task} snapshot on
 * `tasks:update` (mirrors `archive:changed` in Watcher.ts).
 *
 * Snapshots rather than deltas: a task is small, and a renderer that reloads
 * mid-import can't fall out of step. `tasks:list` replays what's live on mount.
 */

/** Progress spam is invisible below a frame; terminal updates always go through. */
const THROTTLE_MS = 120
/** How long a finished task stays replayable, for a renderer that reloads just after. */
const FINISHED_TTL_MS = 60_000
/** Weight of the newest sample in the smoothed transfer rate. */
const RATE_ALPHA = 0.35

const tasks = new Map<string, Task>()
let seq = 0

function broadcast(task: Task): void {
  emitIpcEvent('tasks:update', task)
}

/** Live tasks plus recently-finished ones — what a freshly-mounted renderer should show. */
export function listTasks(): Task[] {
  const now = Date.now()
  for (const [id, task] of tasks) {
    if (task.endedAt && now - task.endedAt > FINISHED_TTL_MS) tasks.delete(id)
  }
  return [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt)
}

export interface TaskInit {
  kind: TaskKind
  title: string
  subtitle?: string | null
  determinate?: boolean
  badge?: string | null
  targetPath?: string | null
  items?: Array<Pick<TaskItem, 'id' | 'label'> & { detail?: string | null }>
}

export class TaskHandle {
  private lastEmit = 0
  private lastBytes = 0
  private lastSampleAt = 0

  constructor(readonly task: Task) {}

  get id(): string {
    return this.task.id
  }

  /** Merge top-level fields (title, subtitle, badge, …) and push. */
  patch(patch: Partial<Task>): void {
    Object.assign(this.task, patch)
    this.emit(true)
  }

  /** Update one active item's read-out without flooding the renderer with process output. */
  itemDetail(id: string, detail: string | null): void {
    const item = this.task.items.find((i) => i.id === id)
    if (!item || item.status !== 'active') return
    item.detail = detail
    this.emit(false)
  }

  /**
   * Declare the work up front so the stack can show `0 / 12` and a queued file list
   * before the first byte moves. Sizes feed the aggregate byte total.
   */
  setItems(items: Array<Pick<TaskItem, 'id' | 'label'> & { bytes?: number | null }>): void {
    this.task.items = items.map((i) => ({
      id: i.id,
      label: i.label,
      status: 'queued',
      detail: 'queued'
    }))
    this.task.total = items.length
    this.task.bytesTotal = items.reduce((sum, i) => sum + (i.bytes ?? 0), 0)
    this.byteSizes = new Map(items.map((i) => [i.id, i.bytes ?? null]))
    this.emit(true)
  }

  private byteSizes = new Map<string, number | null>()
  /** Bytes observed so far for each still-active item; settled items count their full size. */
  private activeBytes = new Map<string, number>()
  private settledBytes = 0

  itemStatus(id: string, status: TaskItemStatus, detail: string | null, retry?: TaskItem['retry']): void {
    const item = this.task.items.find((i) => i.id === id)
    if (!item) return
    item.status = status
    item.detail = detail
    if (retry) item.retry = retry

    if (status !== 'queued' && status !== 'active') {
      // A settled item contributes its whole size and stops moving.
      this.settledBytes += this.byteSizes.get(id) ?? this.activeBytes.get(id) ?? 0
      this.activeBytes.delete(id)
    }
    this.task.done = this.task.items.filter(
      (i) => i.status === 'done' || i.status === 'failed' || i.status === 'duplicate'
    ).length
    this.recomputeBytes()
    this.emit(true)
  }

  /** Live byte count for the item currently transferring (polled off the destination file). */
  itemBytes(id: string, bytes: number): void {
    const item = this.task.items.find((i) => i.id === id)
    if (!item || item.status !== 'active') return
    const total = this.byteSizes.get(id)
    this.activeBytes.set(id, total ? Math.min(bytes, total) : bytes)
    item.detail = total ? `${formatBytes(bytes)} / ${formatBytes(total)}` : formatBytes(bytes)
    this.recomputeBytes()
    this.sampleRate()
    this.emit(false)
  }

  private recomputeBytes(): void {
    let active = 0
    for (const b of this.activeBytes.values()) active += b
    this.task.bytesDone = this.settledBytes + active
  }

  /** Exponentially-smoothed rate, and an ETA only while the total is known. */
  private sampleRate(): void {
    const now = Date.now()
    if (!this.lastSampleAt) {
      this.lastSampleAt = now
      this.lastBytes = this.task.bytesDone
      return
    }
    const dt = (now - this.lastSampleAt) / 1000
    if (dt < 0.2) return
    const rate = Math.max(0, (this.task.bytesDone - this.lastBytes) / dt)
    this.task.bytesPerSec =
      this.task.bytesPerSec === null ? rate : this.task.bytesPerSec * (1 - RATE_ALPHA) + rate * RATE_ALPHA
    this.lastSampleAt = now
    this.lastBytes = this.task.bytesDone

    const remaining = this.task.bytesTotal - this.task.bytesDone
    this.task.etaSeconds =
      this.task.bytesTotal > 0 && this.task.bytesPerSec && this.task.bytesPerSec > 1024
        ? Math.max(1, Math.round(remaining / this.task.bytesPerSec))
        : null
  }

  succeed(summary: string, targetPath?: string | null): void {
    this.task.status = 'success'
    this.task.summary = summary
    this.task.badge = null
    this.task.bytesPerSec = null
    this.task.etaSeconds = null
    if (targetPath !== undefined) this.task.targetPath = targetPath
    this.task.endedAt = Date.now()
    this.emit(true)
  }

  fail(err: unknown): void {
    this.task.status = 'error'
    this.task.error = err instanceof Error ? err.message : String(err)
    this.task.badge = null
    this.task.bytesPerSec = null
    this.task.etaSeconds = null
    this.task.endedAt = Date.now()
    this.emit(true)
  }

  private emit(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < THROTTLE_MS) return
    this.lastEmit = now
    broadcast(this.task)
  }
}


export function startTask(init: TaskInit): TaskHandle {
  const task: Task = {
    id: `${init.kind}-${++seq}-${Date.now()}`,
    kind: init.kind,
    status: 'running',
    title: init.title,
    subtitle: init.subtitle ?? null,
    determinate: init.determinate ?? true,
    done: 0,
    total: init.items?.length ?? 0,
    items: (init.items ?? []).map((i) => ({
      id: i.id,
      label: i.label,
      status: 'queued' as const,
      detail: i.detail ?? 'queued'
    })),
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSec: null,
    etaSeconds: null,
    badge: init.badge ?? null,
    summary: null,
    error: null,
    targetPath: init.targetPath ?? null,
    startedAt: Date.now(),
    endedAt: null
  }
  tasks.set(task.id, task)
  broadcast(task)
  return new TaskHandle(task)
}

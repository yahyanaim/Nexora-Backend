import type pg from "pg"
import { inTransaction } from "../db/session"
import { queueStats, type QueueStats } from "./queue"

/**
 * Worker heartbeats (JOB-09, audit M-3). Each worker writes its row of
 * ops.worker_heartbeats at least every minute with the queue metrics; the
 * operations page and the alert read workerHealth(). A worker that stopped
 * cleanly says so, so only a worker that died or hangs counts as missing.
 */

const JOBS = { role: "nx_jobs" } as const
/** A worker whose last beat is older than this, and that did not stop cleanly, is missing (JOB-09: 2 minutes). */
export const MISSING_AFTER_SECONDS = 120
/** Rows of workers gone for longer than this are removed. */
const FORGET_AFTER_DAYS = 7

/** Writes the worker's heartbeat with the queue metrics, and returns the metrics. */
export async function writeHeartbeat(pool: pg.Pool, workerId: string, startedAt: Date): Promise<QueueStats> {
  const stats = await queueStats(pool)
  await inTransaction(pool, JOBS, async (c) => {
    await c.query(
      `INSERT INTO ops.worker_heartbeats (worker_id, started_at, beat_at, stopped_at, due, oldest_due_seconds, running, dead, outbox_pending, outbox_lag_seconds)
       VALUES ($1, $2, now(), NULL, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (worker_id) DO UPDATE SET beat_at = now(), stopped_at = NULL, due = $3, oldest_due_seconds = $4, running = $5,
         dead = $6, outbox_pending = $7, outbox_lag_seconds = $8`,
      [workerId, startedAt, stats.due, stats.oldestDueSeconds, stats.running, stats.dead, stats.outboxPending, stats.outboxLagSeconds],
    )
    await c.query("DELETE FROM ops.worker_heartbeats WHERE beat_at < now() - make_interval(days => $1)", [FORGET_AFTER_DAYS])
  })
  return stats
}

/** Records a clean stop, so the worker is not reported missing. */
export async function markStopped(pool: pg.Pool, workerId: string): Promise<void> {
  await inTransaction(pool, JOBS, (c) => c.query("UPDATE ops.worker_heartbeats SET stopped_at = now() WHERE worker_id = $1", [workerId]))
}

export interface WorkerBeat {
  workerId: string
  startedAt: Date
  beatAt: Date
  stoppedAt: Date | null
  secondsSinceBeat: number
  metrics: QueueStats
}

export interface WorkerHealth {
  /** Workers that beat within the last 2 minutes. */
  alive: WorkerBeat[]
  /** Workers that neither beat within 2 minutes nor stopped cleanly: the alert (JOB-09). */
  missing: WorkerBeat[]
}

/** What the operations page shows and the alert checks. */
export async function workerHealth(pool: pg.Pool, missingAfterSeconds = MISSING_AFTER_SECONDS): Promise<WorkerHealth> {
  const { rows } = await inTransaction(pool, JOBS, (c) =>
    c.query(
      `SELECT *, extract(epoch FROM now() - beat_at)::int AS since FROM ops.worker_heartbeats WHERE stopped_at IS NULL ORDER BY worker_id`,
    ),
  )
  const beats: WorkerBeat[] = rows.map((r) => ({
    workerId: r.worker_id,
    startedAt: r.started_at,
    beatAt: r.beat_at,
    stoppedAt: r.stopped_at,
    secondsSinceBeat: r.since,
    metrics: { due: r.due, oldestDueSeconds: r.oldest_due_seconds, running: r.running, dead: r.dead, outboxPending: r.outbox_pending, outboxLagSeconds: r.outbox_lag_seconds },
  }))
  return { alive: beats.filter((b) => b.secondsSinceBeat <= missingAfterSeconds), missing: beats.filter((b) => b.secondsSinceBeat > missingAfterSeconds) }
}

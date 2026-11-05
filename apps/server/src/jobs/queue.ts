import type pg from "pg"
import { inTransaction } from "../db/session"
import { uuidv7 } from "../db/uuid"
import type { JobRequest } from "../db/unit-of-work"

/**
 * The job queue on PostgreSQL (§17.1, JOB-01): rows of ops.jobs claimed with
 * FOR UPDATE SKIP LOCKED under a lease. A finished job is done; a failed one
 * comes back after 1, 2, 4… minutes (at most 60) until its last attempt, then
 * it is dead and waits for an operator. A worker that dies leaves its lease to
 * expire; the reaper puts the job back. Every call runs as nx_jobs.
 */

export interface Job {
  id: string
  type: string
  payload: Record<string, unknown>
  workspaceId: string | null
  attempts: number
  maxAttempts: number
}

const JOBS = { role: "nx_jobs" } as const

function toJob(r: { id: string; type: string; payload: Record<string, unknown>; workspace_id: string | null; attempts: number; max_attempts: number }): Job {
  return { id: r.id, type: r.type, payload: r.payload, workspaceId: r.workspace_id, attempts: r.attempts, maxAttempts: r.max_attempts }
}

/** Minutes before attempt n + 1: 1, 2, 4… capped at 60. */
export function backoffMinutes(attempts: number) {
  return Math.min(60, 2 ** Math.max(0, attempts - 1))
}

/** Enqueues a job from the worker or the scheduler. Returns false when its dedupe key was already used. */
export async function enqueueJob(pool: pg.Pool, job: JobRequest & { workspaceId?: string | null }): Promise<boolean> {
  return inTransaction(pool, JOBS, async (c) => {
    const { rowCount } = await c.query(
      `INSERT INTO ops.jobs (id, type, payload, workspace_id, run_at, max_attempts, dedupe_key)
       VALUES ($1, $2, $3, $4, coalesce($5, now()), $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
      [uuidv7(), job.type, JSON.stringify(job.payload ?? {}), job.workspaceId ?? null, job.runAt ?? null, job.maxAttempts ?? 5, job.dedupeKey ?? null],
    )
    return rowCount === 1
  })
}

/** Puts back the jobs whose lease expired (a worker died), or kills them on their last attempt. */
export async function reapExpiredLeases(pool: pg.Pool): Promise<number> {
  return inTransaction(pool, JOBS, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE ops.jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
         run_at = now(), locked_by = NULL, locked_until = NULL, last_error = 'lease expired'
       WHERE status = 'running' AND locked_until < now()`,
    )
    return rowCount ?? 0
  })
}

/**
 * Claims due jobs for one worker. Two workers never get the same job (SKIP
 * LOCKED), and a workspace never runs two jobs of the same type at once, so a
 * large company cannot hold the queue (JOB-06).
 */
export async function claimJobs(pool: pg.Pool, workerId: string, opts: { limit?: number; leaseSeconds?: number; types?: string[] } = {}): Promise<Job[]> {
  const { limit = 1, leaseSeconds = 300, types } = opts
  return inTransaction(pool, JOBS, async (c) => {
    const { rows } = await c.query(
      `WITH ranked AS (
         -- the first due job of each type and workspace: one batch never takes two of them
         SELECT id, row_number() OVER (PARTITION BY type, workspace_id ORDER BY run_at, id) AS rn
         FROM ops.jobs
         WHERE status = 'queued' AND run_at <= now() AND ($3::text[] IS NULL OR type = ANY ($3))),
       candidate AS (
         SELECT j.id FROM ops.jobs j JOIN ranked r ON r.id = j.id
         WHERE j.status = 'queued'
           AND (j.workspace_id IS NULL OR (
             r.rn = 1
             AND NOT EXISTS (SELECT 1 FROM ops.jobs x WHERE x.status = 'running' AND x.type = j.type AND x.workspace_id = j.workspace_id)
             -- held until this claim commits: two claims at the same moment cannot both take this type and workspace
             AND pg_try_advisory_xact_lock(hashtextextended(j.type || ':' || j.workspace_id::text, 0))))
         ORDER BY j.run_at, j.id
         LIMIT $2
         FOR UPDATE OF j SKIP LOCKED)
       UPDATE ops.jobs j SET status = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $4), attempts = j.attempts + 1
       FROM candidate WHERE j.id = candidate.id
       RETURNING j.id, j.type, j.payload, j.workspace_id, j.attempts, j.max_attempts`,
      [workerId, limit, types ?? null, leaseSeconds],
    )
    return rows.map(toJob)
  })
}

/** Marks a job done. False when the worker had lost its lease (the job may already run elsewhere). */
export async function completeJob(pool: pg.Pool, workerId: string, jobId: string): Promise<boolean> {
  return inTransaction(pool, JOBS, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE ops.jobs SET status = 'done', finished_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [jobId, workerId],
    )
    return rowCount === 1
  })
}

/** Records a failure: the job comes back after its backoff, or is dead after its last attempt. */
export async function failJob(pool: pg.Pool, workerId: string, jobId: string, error: unknown): Promise<"retry" | "dead" | "lost"> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
  return inTransaction(pool, JOBS, async (c) => {
    const { rows } = await c.query(
      `UPDATE ops.jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
         run_at = now() + make_interval(mins => least(60, power(2, greatest(attempts - 1, 0))::int)),
         locked_by = NULL, locked_until = NULL, last_error = $3
       WHERE id = $1 AND locked_by = $2 AND status = 'running'
       RETURNING status`,
      [jobId, workerId, message],
    )
    return rows.length ? (rows[0].status === "dead" ? "dead" : "retry") : "lost"
  })
}

/** Gives a claimed job back without using an attempt: a worker shutting down (JOB-08). */
export async function releaseJob(pool: pg.Pool, workerId: string, jobId: string): Promise<boolean> {
  return inTransaction(pool, JOBS, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE ops.jobs SET status = 'queued', run_at = now(), attempts = greatest(attempts - 1, 0), locked_by = NULL, locked_until = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [jobId, workerId],
    )
    return rowCount === 1
  })
}

/** Retries a dead job after a fix (§17.1 visibility). */
export async function retryDeadJob(pool: pg.Pool, jobId: string): Promise<boolean> {
  return inTransaction(pool, JOBS, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE ops.jobs SET status = 'queued', run_at = now(), attempts = 0, finished_at = NULL WHERE id = $1 AND status = 'dead'`,
      [jobId],
    )
    return rowCount === 1
  })
}

export interface QueueStats {
  /** Jobs due now and not running. */
  due: number
  /** Seconds since the oldest due job became due (0 when none). */
  oldestDueSeconds: number
  running: number
  dead: number
  /** Outbox events waiting to be relayed, and the age of the oldest (outbox lag, QAL-08). */
  outboxPending: number
  outboxLagSeconds: number
}

/** What the operations page and the alerts read (JOB-07, QAL-08). */
export async function queueStats(pool: pg.Pool): Promise<QueueStats> {
  return inTransaction(pool, JOBS, async (c) => {
    const { rows } = await c.query(
      `SELECT
         count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS due,
         coalesce(extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now())), 0)::int AS oldest,
         count(*) FILTER (WHERE status = 'running')::int AS running,
         count(*) FILTER (WHERE status = 'dead')::int AS dead,
         (SELECT count(*)::int FROM ops.outbox WHERE status = 'pending') AS outbox_pending,
         (SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0)::int FROM ops.outbox WHERE status = 'pending') AS outbox_lag
       FROM ops.jobs`,
    )
    const r = rows[0]
    return { due: r.due, oldestDueSeconds: r.oldest, running: r.running, dead: r.dead, outboxPending: r.outbox_pending, outboxLagSeconds: r.outbox_lag }
  })
}

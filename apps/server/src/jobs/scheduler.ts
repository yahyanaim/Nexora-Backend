import type pg from "pg"
import { inTransaction } from "../db/session"
import { uuidv7 } from "../db/uuid"

/**
 * The scheduler (§17.1, JOB-04): enqueues the due runs of ops.schedules. One
 * scheduler works at a time (a transaction advisory lock), and each run has a
 * dedupe key made of the schedule and its planned time, so two workers started
 * together, or a restart, never enqueue a run twice. Runs missed while no worker
 * was up are enqueued once, then the schedule moves to its next future time.
 */
const SCHEDULER_LOCK = "nexora.scheduler"

export async function enqueueDueSchedules(pool: pg.Pool): Promise<number> {
  return inTransaction(pool, { role: "nx_jobs" }, async (c) => {
    const { rows: lock } = await c.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [SCHEDULER_LOCK])
    if (!lock[0].got) return 0
    const { rows: due } = await c.query<{ name: string; job_type: string; planned: string }>(
      `SELECT name, job_type, to_char(next_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS planned
       FROM ops.schedules WHERE enabled AND next_run_at <= now() ORDER BY name FOR UPDATE`,
    )
    let enqueued = 0
    for (const s of due) {
      const { rowCount } = await c.query(
        `INSERT INTO ops.jobs (id, type, payload, dedupe_key) VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
        [uuidv7(), s.job_type, JSON.stringify({ schedule: s.name, planned: s.planned }), `schedule:${s.name}:${s.planned}`],
      )
      enqueued += rowCount ?? 0
      await c.query(
        `UPDATE ops.schedules SET last_run_at = now(),
           next_run_at = next_run_at + make_interval(secs => interval_seconds * (floor(extract(epoch FROM now() - next_run_at) / interval_seconds) + 1))
         WHERE name = $1`,
        [s.name],
      )
    }
    return enqueued
  })
}

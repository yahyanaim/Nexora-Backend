import type pg from "pg"
import { inTransaction } from "../db/session"
import { uuidv7 } from "../db/uuid"
import type { JobRequest } from "../db/unit-of-work"
import { backoffMinutes } from "./queue"

/**
 * The outbox relay (§15.1, TRX-05, NTF-01). Each event written by a command is
 * turned into the jobs its route asks for (send an e-mail, render a PDF…), in
 * one transaction with the event marked published. Delivery is at least once:
 * a relay that dies mid-batch leaves its events pending, and the next run sends
 * them again; each job carries the dedupe key outbox:<event>:<job type>, so a
 * second delivery adds nothing (JOB-02).
 */

export interface OutboxRecord {
  id: string
  workspaceId: string | null
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
}

/** Event type → the jobs it starts. An event type without a route is simply marked published. */
export type OutboxRoutes = Record<string, (event: OutboxRecord) => JobRequest[]>

const MAX_EVENT_ATTEMPTS = 10

export interface RelayResult {
  published: number
  failed: number
  jobs: number
}

export async function relayOutbox(pool: pg.Pool, routes: OutboxRoutes, limit = 100): Promise<RelayResult> {
  return inTransaction(pool, { role: "nx_jobs" }, async (c) => {
    const { rows } = await c.query(
      `SELECT id, workspace_id, aggregate_type, aggregate_id, event_type, payload, attempts FROM ops.outbox
       WHERE status = 'pending' AND available_at <= now()
       ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    )
    const result: RelayResult = { published: 0, failed: 0, jobs: 0 }
    for (const r of rows) {
      const event: OutboxRecord = { id: r.id, workspaceId: r.workspace_id, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, eventType: r.event_type, payload: r.payload }
      await c.query("SAVEPOINT event")
      try {
        for (const job of routes[event.eventType]?.(event) ?? []) {
          const { rowCount } = await c.query(
            `INSERT INTO ops.jobs (id, type, payload, workspace_id, run_at, max_attempts, dedupe_key)
             VALUES ($1, $2, $3, $4, coalesce($5, now()), $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
            [uuidv7(), job.type, JSON.stringify(job.payload ?? {}), event.workspaceId, job.runAt ?? null, job.maxAttempts ?? 5, job.dedupeKey ?? `outbox:${event.id}:${job.type}`],
          )
          result.jobs += rowCount ?? 0
        }
        await c.query(`UPDATE ops.outbox SET status = 'published', published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [event.id])
        await c.query("RELEASE SAVEPOINT event")
        result.published++
      } catch (error) {
        // This event waits and comes back; the others of the batch go on.
        await c.query("ROLLBACK TO SAVEPOINT event")
        const attempts = Number(r.attempts) + 1
        await c.query(
          `UPDATE ops.outbox SET attempts = $2::int, last_error = $3,
             status = CASE WHEN $2::int >= $4::int THEN 'dead' ELSE 'pending' END,
             available_at = now() + make_interval(mins => $5::int)
           WHERE id = $1`,
          [event.id, attempts, (error instanceof Error ? error.message : String(error)).slice(0, 2000), MAX_EVENT_ATTEMPTS, backoffMinutes(attempts)],
        )
        result.failed++
      }
    }
    return result
  })
}

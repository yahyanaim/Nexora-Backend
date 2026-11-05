import type pg from "pg"
import { type DbContext, inTransaction } from "./session"
import { uuidv7 } from "./uuid"

/**
 * The unit of work of every command (§15.1, TRX-01, TRL-01): one transaction
 * that holds the change, its audit events, its outbox events and the jobs it
 * starts. If any of them cannot be written, nothing is. Nothing leaves the
 * database inside it (TRX-02): e-mails, files and providers are reached later,
 * from the outbox, by the worker.
 */

export interface AuditEvent {
  /** "invoice.issued": dotted, lower case. */
  action: string
  targetType: string
  targetId?: string
  targetLabel?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  reason?: string
}

/** Who acts and from where: set by the HTTP adapter or the worker, never from the request body (TRL-03). */
export interface ActorContext {
  /** "owner", "admin", "system:<job>"… */
  role: string
  ip?: string
  userAgent?: string
  requestId?: string
  sessionId?: string
}

export interface OutboxEvent {
  aggregateType: string
  aggregateId: string
  eventType: string
  payload?: Record<string, unknown>
}

export interface JobRequest {
  type: string
  payload?: Record<string, unknown>
  runAt?: Date
  maxAttempts?: number
  /** The same key enqueues one job only (JOB-02). */
  dedupeKey?: string
}

export interface Work {
  /** The transaction's connection, under the context's role and settings. */
  client: pg.PoolClient
  audit(event: AuditEvent): Promise<void>
  emit(event: OutboxEvent): Promise<void>
  enqueue(job: JobRequest): Promise<void>
}

export interface UnitOfWorkContext extends DbContext {
  actor: ActorContext
}

/** Errors PostgreSQL asks the client to retry: deadlock and serialization failure. */
const RETRYABLE = new Set(["40P01", "40001"])
const MAX_ATTEMPTS = 3 // TRX-08

/** Keys whose values never reach an audit trail (TRL-04). */
const SECRET_KEY = /pass(word)?|token|secret|otp|totp|mfa|api[-_]?key|iban|rib|card|cvv/i
const MASK = "[redacted]"

/** Copies before/after values with secrets masked, at any depth. */
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? MASK : maskSecrets(v)]))
  }
  return value
}

function json(value: Record<string, unknown> | undefined) {
  return value === undefined ? null : JSON.stringify(maskSecrets(value))
}

function bind(client: pg.PoolClient, ctx: UnitOfWorkContext): Work {
  const workspaceId = ctx.workspaceId ?? null
  return {
    client,
    async audit(event) {
      if (!ctx.principalId) throw new TypeError("An audited command needs a principal")
      const a = ctx.actor
      const common = [uuidv7(), ctx.principalId, a.role, event.action, event.targetType, event.targetId ?? null, event.targetLabel ?? null,
        json(event.before), json(event.after), event.reason ?? null, a.ip ?? null, a.userAgent ?? null, a.requestId ?? null, a.sessionId ?? null]
      if (ctx.role === "nx_platform") {
        await client.query(
          `INSERT INTO audit.console_events (id, actor_id, actor_role, action, target_type, target_id, target_label, before, after, reason, ip, user_agent, request_id, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, common)
      } else {
        if (!workspaceId) throw new TypeError("A company command is audited in its workspace")
        await client.query(
          `INSERT INTO audit.workspace_events (id, actor_id, actor_role, action, target_type, target_id, target_label, before, after, reason, ip, user_agent, request_id, session_id, workspace_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`, [...common, workspaceId])
      }
    },
    async emit(event) {
      await client.query(
        `INSERT INTO ops.outbox (id, workspace_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), workspaceId, event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload ?? {})],
      )
    },
    async enqueue(job) {
      // No conflict target: inferring one would need SELECT on the queue, which commands do not have.
      await client.query(
        `INSERT INTO ops.jobs (id, type, payload, workspace_id, run_at, max_attempts, dedupe_key)
         VALUES ($1, $2, $3, $4, coalesce($5, now()), $6, $7) ON CONFLICT DO NOTHING`,
        [uuidv7(), job.type, JSON.stringify(job.payload ?? {}), workspaceId, job.runAt ?? null, job.maxAttempts ?? 5, job.dedupeKey ?? null],
      )
    },
  }
}

/**
 * Runs a command in one transaction. A deadlock or serialization failure is
 * retried up to three times, which is safe because nothing outside the
 * database has happened yet (§15.1, TRX-08). Any other error rolls everything back.
 */
export async function runUnitOfWork<T>(pool: pg.Pool, ctx: UnitOfWorkContext, command: (work: Work) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await inTransaction(pool, ctx, (client) => command(bind(client, ctx)))
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE.has((error as { code?: string }).code ?? "")) throw error
    }
  }
}

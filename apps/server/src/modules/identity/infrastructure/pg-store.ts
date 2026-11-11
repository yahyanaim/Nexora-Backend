import { createHash } from "node:crypto"
import type pg from "pg"
import { inTransaction } from "../../../db/session"
import { uuidv7 } from "../../../db/uuid"
import type { IdentityStore, IdentityTransactions, RateLimiter, RefreshRecord, SessionRecord, UserRecord } from "../ports"

/**
 * The identity store on PostgreSQL. Every call runs as the member realm
 * (nx_app) without a workspace: accounts, sessions and tokens hold none.
 * Queries are parameterised only (SCR-02).
 */

const MEMBER = { role: "nx_app" } as const
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

type Row = Record<string, unknown>
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string))

function toUser(r: Row): UserRecord {
  return {
    id: r.id as string,
    email: r.email as string,
    name: r.name as string,
    locale: r.locale as string,
    status: r.status as UserRecord["status"],
    passwordHash: (r.password_hash as string | null) ?? null,
    lock: { failedAttempts: r.failed_attempts as number, lockedUntil: date(r.locked_until) },
  }
}

function toSession(r: Row): SessionRecord {
  return {
    id: r.id as string,
    principalId: r.principal_id as string,
    realm: r.realm as SessionRecord["realm"],
    createdAt: date(r.created_at)!,
    lastActivityAt: date(r.last_activity_at)!,
    idleExpiresAt: date(r.idle_expires_at)!,
    absoluteExpiresAt: date(r.absolute_expires_at)!,
    xsrfHash: r.xsrf_hash as string,
    activeWorkspaceId: (r.active_workspace_id as string | null) ?? null,
    revokedAt: date(r.revoked_at),
  }
}

const USER_COLUMNS = "id, email, name, locale, status, password_hash, failed_attempts, locked_until"

function store(c: pg.PoolClient): IdentityStore {
  const one = async (sql: string, params: unknown[]) => (await c.query<Row>(sql, params)).rows[0] ?? null
  return {
    async userByEmail(email) {
      const r = await one(`SELECT ${USER_COLUMNS} FROM identity.users WHERE email = $1 FOR UPDATE`, [email])
      return r ? toUser(r) : null
    },
    async userById(id) {
      const r = await one(`SELECT ${USER_COLUMNS} FROM identity.users WHERE id = $1`, [id])
      return r ? toUser(r) : null
    },
    async failuresOf(emailHash) {
      await c.query("INSERT INTO identity.sign_in_failures (email_hash) VALUES ($1) ON CONFLICT (email_hash) DO NOTHING", [emailHash])
      const r = await one("SELECT failed_attempts, last_failure_at, locked_until FROM identity.sign_in_failures WHERE email_hash = $1 FOR UPDATE", [emailHash])
      return { failedAttempts: (r?.failed_attempts as number) ?? 0, lockedUntil: date(r?.locked_until), lastFailureAt: date(r?.last_failure_at) }
    },
    async saveFailures(emailHash, state) {
      await c.query("UPDATE identity.sign_in_failures SET failed_attempts = $2, locked_until = $3, last_failure_at = $4 WHERE email_hash = $1", [emailHash, state.failedAttempts, state.lockedUntil, state.lastFailureAt ?? null])
      // Rows of e-mails nobody has tried for a day are of no use.
      await c.query("DELETE FROM identity.sign_in_failures WHERE ctid IN (SELECT ctid FROM identity.sign_in_failures WHERE coalesce(last_failure_at, '-infinity') < now() - interval '1 day' AND coalesce(locked_until, '-infinity') < now() LIMIT 100)")
    },
    async clearFailures(emailHash) {
      await c.query("DELETE FROM identity.sign_in_failures WHERE email_hash = $1", [emailHash])
    },
    async saveLock(userId, lock) {
      await c.query("UPDATE identity.users SET failed_attempts = $2, locked_until = $3, updated_at = now() WHERE id = $1", [userId, lock.failedAttempts, lock.lockedUntil])
    },
    async replacePasswordHash(userId, hash) {
      await c.query("UPDATE identity.users SET password_hash = $2, updated_at = now() WHERE id = $1", [userId, hash])
    },
    async createSession(s, client) {
      await c.query(
        `INSERT INTO identity.sessions (id, principal_id, realm, created_at, last_activity_at, idle_expires_at, absolute_expires_at, xsrf_hash, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [s.id, s.principalId, s.realm, s.createdAt, s.lastActivityAt, s.idleExpiresAt, s.absoluteExpiresAt, s.xsrfHash, client.ip, client.userAgent?.slice(0, 400) ?? null],
      )
    },
    async sessionById(id) {
      const r = await one(
        "SELECT id, principal_id, realm, created_at, last_activity_at, idle_expires_at, absolute_expires_at, xsrf_hash, revoked_at, active_workspace_id FROM identity.sessions WHERE id = $1",
        [id],
      )
      return r ? toSession(r) : null
    },
    async touchSession(id, lastActivityAt, idleExpiresAt) {
      await c.query("UPDATE identity.sessions SET last_activity_at = $2, idle_expires_at = $3 WHERE id = $1 AND revoked_at IS NULL", [id, lastActivityAt, idleExpiresAt])
    },
    async setActiveWorkspace(sessionId, workspaceId) {
      await c.query("UPDATE identity.sessions SET active_workspace_id = $2 WHERE id = $1", [sessionId, workspaceId])
    },
    async revokeSession(id, reason) {
      await c.query("UPDATE identity.sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL", [id, reason])
      await c.query("UPDATE identity.refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL", [id])
    },
    async addRefreshToken(t) {
      await c.query("INSERT INTO identity.refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)", [t.id, t.sessionId, t.tokenHash, t.expiresAt])
    },
    async refreshTokenByHash(tokenHash) {
      const r = await one("SELECT id, session_id, expires_at, revoked_at FROM identity.refresh_tokens WHERE token_hash = $1 FOR UPDATE", [tokenHash])
      return r ? ({ id: r.id as string, sessionId: r.session_id as string, expiresAt: date(r.expires_at)!, revokedAt: date(r.revoked_at) } satisfies RefreshRecord) : null
    },
    async markRefreshTokenReplaced(id, replacedBy) {
      await c.query("UPDATE identity.refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [id, replacedBy])
    },
    async audit(e) {
      // The trail never holds an address in clear: the e-mail is hashed (IAM-16).
      await c.query(
        `INSERT INTO audit.identity_events (id, principal_id, email_hash, realm, action, ip, user_agent, request_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuidv7(), e.principalId ?? null, e.email ? sha256(e.email) : null, e.realm, e.action, e.ip ?? null, e.userAgent?.slice(0, 400) ?? null, e.requestId?.slice(0, 100) ?? null, e.sessionId ?? null],
      )
    },
  }
}

export function pgIdentityTransactions(pool: pg.Pool): IdentityTransactions {
  return { run: (work) => inTransaction(pool, MEMBER, (c) => work(store(c))) }
}

/**
 * Fixed-window counters in ops.rate_limits (IAM-09: PostgreSQL when no Redis).
 * Bucket names keep their purpose and hash what they limit, so no e-mail or
 * address is stored in clear.
 */
export function pgRateLimiter(pool: pg.Pool): RateLimiter {
  const key = (bucket: string) => {
    const at = bucket.lastIndexOf(":")
    return `${bucket.slice(0, at)}:${sha256(bucket.slice(at + 1))}`
  }
  // The window of `now()` for a length in seconds ($2): fixed windows aligned on the epoch.
  return {
    async count(bucket, windowSeconds) {
      const { rows } = await inTransaction(pool, MEMBER, (c) =>
        c.query<{ hits: number; retry: number }>(
          `WITH w AS (SELECT to_timestamp(floor(extract(epoch FROM now()) / $2) * $2) AS start)
           SELECT coalesce((SELECT hits FROM ops.rate_limits r, w WHERE r.bucket = $1 AND r.window_start = w.start), 0)::int AS hits,
                  greatest(ceil(extract(epoch FROM w.start + make_interval(secs => $2) - now())), 1)::int AS retry
           FROM w`,
          [key(bucket), windowSeconds],
        ),
      )
      return { hits: rows[0]?.hits ?? 0, retryAfterSeconds: rows[0]?.retry ?? windowSeconds }
    },
    async hit(bucket, windowSeconds) {
      await inTransaction(pool, MEMBER, async (c) => {
        await c.query(
          `INSERT INTO ops.rate_limits (bucket, window_start, hits) VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
           ON CONFLICT (bucket, window_start) DO UPDATE SET hits = ops.rate_limits.hits + 1`,
          [key(bucket), windowSeconds],
        )
        // Old windows are of no use; whoever writes cleans a few.
        await c.query("DELETE FROM ops.rate_limits WHERE ctid IN (SELECT ctid FROM ops.rate_limits WHERE window_start < now() - interval '1 day' LIMIT 100)")
      })
    },
    async clear(bucket) {
      await inTransaction(pool, MEMBER, (c) => c.query("DELETE FROM ops.rate_limits WHERE bucket = $1", [key(bucket)]))
    },
  }
}

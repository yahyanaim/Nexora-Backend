import { createHash } from "node:crypto"
import type pg from "pg"
import { inTransaction } from "../../../db/session"
import { uuidv7 } from "../../../db/uuid"
import type { Realm } from "../domain/session-limits"
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
    secondFactorAt: date(r.second_factor_at),
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
        "SELECT id, principal_id, realm, created_at, last_activity_at, idle_expires_at, absolute_expires_at, xsrf_hash, revoked_at, active_workspace_id, second_factor_at FROM identity.sessions WHERE id = $1",
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

    async secondFactorOf(principalId) {
      const r = await one("SELECT secret_enc, enabled_at, last_step FROM identity.second_factors WHERE principal_id = $1 FOR UPDATE", [principalId])
      return r ? { secretEnc: r.secret_enc as string, enabledAt: date(r.enabled_at), lastStep: Number(r.last_step) } : null
    },
    async saveSecondFactorSetup(principalId, secretEnc) {
      await c.query(
        `INSERT INTO identity.second_factors (principal_id, secret_enc) VALUES ($1, $2)
         ON CONFLICT (principal_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, last_step = 0, created_at = now() WHERE identity.second_factors.enabled_at IS NULL`,
        [principalId, secretEnc],
      )
    },
    async enableSecondFactor(principalId, at, step) {
      await c.query("UPDATE identity.second_factors SET enabled_at = $2, last_step = $3 WHERE principal_id = $1", [principalId, at, step])
    },
    async acceptStep(principalId, step) {
      await c.query("UPDATE identity.second_factors SET last_step = greatest(last_step, $2) WHERE principal_id = $1", [principalId, step])
    },
    async deleteSecondFactor(principalId) {
      await c.query("DELETE FROM identity.recovery_codes WHERE principal_id = $1", [principalId])
      await c.query("DELETE FROM identity.second_factors WHERE principal_id = $1", [principalId])
    },
    async replaceRecoveryCodes(principalId, hashes) {
      await c.query("DELETE FROM identity.recovery_codes WHERE principal_id = $1", [principalId])
      for (const hash of hashes) await c.query("INSERT INTO identity.recovery_codes (id, principal_id, code_hash) VALUES ($1, $2, $3)", [uuidv7(), principalId, hash])
    },
    async useRecoveryCode(principalId, hash, at) {
      const r = await c.query("UPDATE identity.recovery_codes SET used_at = $3 WHERE principal_id = $1 AND code_hash = $2 AND used_at IS NULL", [principalId, hash, at])
      return r.rowCount === 1
    },
    async remainingRecoveryCodes(principalId) {
      const r = await one("SELECT count(*)::int AS n FROM identity.recovery_codes WHERE principal_id = $1 AND used_at IS NULL", [principalId])
      return (r?.n as number) ?? 0
    },
    async createChallenge(ch, client) {
      await c.query(
        "INSERT INTO identity.sign_in_challenges (id, token_hash, user_id, realm, created_at, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [ch.id, ch.tokenHash, ch.userId, ch.realm, new Date(ch.expiresAt.getTime() - 5 * 60_000), ch.expiresAt, client.ip, client.userAgent?.slice(0, 400) ?? null],
      )
    },
    async challengeByHash(tokenHash) {
      const r = await one("SELECT id, user_id, realm, attempts, expires_at, used_at FROM identity.sign_in_challenges WHERE token_hash = $1 FOR UPDATE", [tokenHash])
      return r
        ? { id: r.id as string, userId: r.user_id as string, realm: r.realm as Realm, attempts: r.attempts as number, expiresAt: date(r.expires_at)!, usedAt: date(r.used_at) }
        : null
    },
    async countChallengeAttempt(id) {
      await c.query("UPDATE identity.sign_in_challenges SET attempts = least(attempts + 1, 5) WHERE id = $1", [id])
    },
    async useChallenge(id, at) {
      await c.query("UPDATE identity.sign_in_challenges SET used_at = $2 WHERE id = $1", [id, at])
    },
    async markSecondFactor(sessionId, at) {
      await c.query("UPDATE identity.sessions SET second_factor_at = $2 WHERE id = $1 AND revoked_at IS NULL", [sessionId, at])
    },
    async openSessions(principalId, now) {
      const { rows } = await c.query<Row>(
        `SELECT id, created_at, last_activity_at, host(ip) AS ip, user_agent FROM identity.sessions
         WHERE principal_id = $1 AND revoked_at IS NULL AND absolute_expires_at > $2 ORDER BY last_activity_at DESC`,
        [principalId, now],
      )
      return rows.map((r) => ({ id: r.id as string, createdAt: date(r.created_at)!, lastActivityAt: date(r.last_activity_at)!, ip: (r.ip as string | null) ?? null, userAgent: (r.user_agent as string | null) ?? null }))
    },
    async revokeSessionsOf(principalId, reason, exceptId) {
      const { rows } = await c.query<Row>(
        "UPDATE identity.sessions SET revoked_at = now(), revoked_reason = $2 WHERE principal_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $3 RETURNING id",
        [principalId, reason, exceptId],
      )
      if (rows.length) await c.query("UPDATE identity.refresh_tokens SET revoked_at = now() WHERE session_id = ANY ($1::uuid[]) AND revoked_at IS NULL", [rows.map((r) => r.id)])
      return rows.length
    },
    async passcodeOf(userId) {
      const r = await one("SELECT passcode_hash, failed_attempts FROM identity.passcodes WHERE user_id = $1 FOR UPDATE", [userId])
      return r ? { hash: r.passcode_hash as string, failedAttempts: r.failed_attempts as number } : null
    },
    async savePasscode(userId, hash) {
      await c.query(
        "INSERT INTO identity.passcodes (user_id, passcode_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET passcode_hash = EXCLUDED.passcode_hash, set_at = now(), failed_attempts = 0",
        [userId, hash],
      )
    },
    async deletePasscode(userId) {
      await c.query("DELETE FROM identity.passcodes WHERE user_id = $1", [userId])
    },
    async setPasscodeFailures(userId, failedAttempts) {
      await c.query("UPDATE identity.passcodes SET failed_attempts = $2 WHERE user_id = $1", [userId, failedAttempts])
    },
    async sessionByRefreshHash(tokenHash) {
      const r = await one(
        `SELECT s.id, s.principal_id, s.realm, s.created_at, s.last_activity_at, s.idle_expires_at, s.absolute_expires_at, s.xsrf_hash, s.revoked_at, s.active_workspace_id, s.second_factor_at
         FROM identity.refresh_tokens t JOIN identity.sessions s ON s.id = t.session_id WHERE t.token_hash = $1 AND t.revoked_at IS NULL FOR UPDATE OF s`,
        [tokenHash],
      )
      return r ? toSession(r) : null
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

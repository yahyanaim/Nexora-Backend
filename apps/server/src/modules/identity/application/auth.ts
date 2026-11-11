import { uuidv7 } from "../../../db/uuid"
import { afterFailedAttempt, afterSuccess, isLocked } from "../domain/lockout"
import { ACCESS_TOKEN_MINUTES, type Realm, SESSION_LIMITS } from "../domain/session-limits"
import type { AccessTokens, Clock, IdentityTransactions, RateLimiter, SecretTokens, SessionRecord, UserRecord } from "../ports"
import type { PasswordService } from "./passwords"

/**
 * Sign-in, refresh, sign-out and the session check of every request (cahier §8;
 * IAM-01, IAM-04, IAM-07, IAM-08, IAM-16). Member realm first; the portal and
 * the console reuse it with their own limits when they come.
 *
 * - A wrong password and an unknown e-mail get the same answer in the same time.
 * - Failures and the 15-minute lock are kept per e-mail, whether the account
 *   exists or not, so a lock never tells that an account exists; failures are
 *   also counted per client address.
 * - The refresh token rotates on every use; a used token presented again ends the session.
 * - Every request reloads the session and the account: a disabled account or a
 *   revoked session stops at the next request.
 */

export const SIGN_IN_WINDOW_SECONDS = 15 * 60
/** Failures per e-mail before it is locked for 15 minutes (IAM-04): MAX_FAILED_ATTEMPTS of the domain. */
export { MAX_FAILED_ATTEMPTS as SIGN_IN_FAILURES_PER_EMAIL } from "../domain/lockout"
/** Failures per client address in the window (cahier §18.4, starting value). */
export const SIGN_IN_FAILURES_PER_ADDRESS = 10
/** Activity is written at most once a minute, so reads do not each cost a write. */
const TOUCH_EVERY_MS = 60_000

export interface ClientInfo {
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export interface PublicUser {
  id: string
  email: string
  name: string
  locale: string
}

/** What the HTTP layer turns into cookies. Tokens leave the server only here. */
export interface IssuedSession {
  sessionId: string
  principalId: string
  realm: Realm
  accessToken: string
  accessExpiresAt: Date
  refreshToken: string
  /** The session's absolute end: the refresh cookie lives no longer. */
  refreshExpiresAt: Date
  /** Present at sign-in only: the double-submit value of the XSRF-TOKEN cookie. */
  xsrfToken?: string
  user: PublicUser
}

export type SignInResult = { ok: true; session: IssuedSession } | { ok: false; reason: "invalid" } | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }

/** The verified identity of a request (TEN-03): frozen, built only here. */
export interface SessionContext {
  readonly sessionId: string
  readonly principalId: string
  readonly realm: Realm
  readonly xsrfHash: string
  /** Chosen with PUT /app/v1/auth/workspace; checked against the memberships when used. */
  readonly activeWorkspaceId: string | null
  readonly user: Readonly<PublicUser>
}

export interface AuthDeps {
  tx: IdentityTransactions
  passwords: PasswordService
  limiter: RateLimiter
  tokens: SecretTokens
  access: AccessTokens
  clock: Clock
}

export interface AuthService {
  signIn(input: { email: string; password: string; realm: "member" }, client: ClientInfo): Promise<SignInResult>
  refresh(refreshToken: string, client: ClientInfo): Promise<IssuedSession | null>
  signOut(sessionId: string, client: ClientInfo): Promise<void>
  authenticate(accessToken: string, realm: Realm): Promise<SessionContext | null>
  /** Records the workspace the session works in; the caller has checked the membership. */
  setActiveWorkspace(sessionId: string, workspaceId: string | null): Promise<void>
}

const publicUser = (u: UserRecord): PublicUser => ({ id: u.id, email: u.email, name: u.name, locale: u.locale })
const normalizeEmail = (email: string) => email.normalize("NFKC").trim().toLowerCase()

export function authService(deps: AuthDeps): AuthService {
  const { tx, passwords, limiter, tokens, access, clock } = deps
  const addressBucket = (ip: string | null) => `sign_in:address:${tokens.hash(ip ?? "unknown")}`

  function issue(session: Pick<SessionRecord, "id" | "principalId" | "realm" | "absoluteExpiresAt">, user: UserRecord, refreshToken: string, now: Date, xsrfToken?: string): IssuedSession {
    const accessExpiresAt = new Date(Math.min(now.getTime() + ACCESS_TOKEN_MINUTES * 60_000, session.absoluteExpiresAt.getTime()))
    return {
      sessionId: session.id,
      principalId: session.principalId,
      realm: session.realm,
      accessToken: access.issue({ sid: session.id, realm: session.realm, expiresAt: accessExpiresAt }),
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt: session.absoluteExpiresAt,
      ...(xsrfToken ? { xsrfToken } : {}),
      user: publicUser(user),
    }
  }

  return {
    async signIn(input, client) {
      const email = normalizeEmail(input.email)
      const emailHash = tokens.hash(email)
      const now = clock.now()
      const perAddress = await limiter.count(addressBucket(client.ip), SIGN_IN_WINDOW_SECONDS)
      if (perAddress.hits >= SIGN_IN_FAILURES_PER_ADDRESS) {
        await tx.run((s) => s.audit({ action: "sign_in.refused_rate_limit", realm: input.realm, email, ...client }))
        return { ok: false, reason: "rate_limited", retryAfterSeconds: perAddress.retryAfterSeconds }
      }

      const result = await tx.run(async (s): Promise<SignInResult> => {
        // The same lock state for every e-mail, known or not (IAM-04).
        const failures = await s.failuresOf(emailHash)
        if (isLocked(failures, now)) {
          await s.audit({ action: "sign_in.refused_locked", realm: input.realm, email, ...client })
          return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil((failures.lockedUntil!.getTime() - now.getTime()) / 1000)) }
        }
        const user = await s.userByEmail(email)
        // Always one full verification, also for an unknown, invited or disabled account.
        const check = await passwords.check(user?.status === "active" ? user.passwordHash : null, input.password)
        if (!user || user.status !== "active" || !check.ok) {
          const next = afterFailedAttempt(failures, now)
          await s.saveFailures(emailHash, next)
          if (user) await s.saveLock(user.id, next)
          await s.audit({ action: "sign_in.failed", realm: input.realm, principalId: user?.id ?? null, email: user ? null : email, ...client })
          return { ok: false, reason: "invalid" }
        }

        await s.clearFailures(emailHash)
        await s.saveLock(user.id, afterSuccess())
        if (check.rehash) await s.replacePasswordHash(user.id, check.rehash)
        const limits = SESSION_LIMITS[input.realm]
        const session = {
          id: uuidv7(),
          principalId: user.id,
          realm: input.realm,
          createdAt: now,
          lastActivityAt: now,
          idleExpiresAt: new Date(now.getTime() + limits.idleMinutes * 60_000),
          absoluteExpiresAt: new Date(now.getTime() + limits.absoluteHours * 3_600_000),
        }
        const xsrfToken = tokens.generate()
        await s.createSession({ ...session, xsrfHash: tokens.hash(xsrfToken) }, client)
        const refreshToken = tokens.generate()
        await s.addRefreshToken({ id: uuidv7(), sessionId: session.id, tokenHash: tokens.hash(refreshToken), expiresAt: session.absoluteExpiresAt })
        await s.audit({ action: "sign_in.succeeded", realm: input.realm, principalId: user.id, sessionId: session.id, ...client })
        return { ok: true, session: issue(session, user, refreshToken, now, xsrfToken) }
      })

      if (!result.ok && result.reason === "invalid") await limiter.hit(addressBucket(client.ip), SIGN_IN_WINDOW_SECONDS)
      return result
    },

    async refresh(refreshToken, client) {
      const now = clock.now()
      return tx.run(async (s) => {
        const token = await s.refreshTokenByHash(tokens.hash(refreshToken))
        if (!token) return null
        const session = await s.sessionById(token.sessionId)
        if (!session) return null
        if (token.revokedAt) {
          // A replaced token came back: someone else holds a copy. End the session (IAM-07).
          if (!session.revokedAt) {
            await s.revokeSession(session.id, "refresh_reuse")
            await s.audit({ action: "session.refresh_reused", realm: session.realm, principalId: session.principalId, sessionId: session.id, ...client })
          }
          return null
        }
        if (session.revokedAt || token.expiresAt <= now || session.absoluteExpiresAt <= now || session.idleExpiresAt <= now) return null
        const user = await s.userById(session.principalId)
        if (!user || user.status !== "active") return null

        const next = tokens.generate()
        const nextId = uuidv7()
        await s.addRefreshToken({ id: nextId, sessionId: session.id, tokenHash: tokens.hash(next), expiresAt: session.absoluteExpiresAt })
        await s.markRefreshTokenReplaced(token.id, nextId)
        const limits = SESSION_LIMITS[session.realm]
        await s.touchSession(session.id, now, new Date(Math.min(now.getTime() + limits.idleMinutes * 60_000, session.absoluteExpiresAt.getTime())))
        return issue(session, user, next, now)
      })
    },

    async signOut(sessionId, client) {
      await tx.run(async (s) => {
        const session = await s.sessionById(sessionId)
        if (!session || session.revokedAt) return
        await s.revokeSession(sessionId, "sign_out")
        await s.audit({ action: "session.signed_out", realm: session.realm, principalId: session.principalId, sessionId, ...client })
      })
    },

    async authenticate(accessToken, realm) {
      const now = clock.now()
      const claims = access.read(accessToken, now)
      if (!claims || claims.realm !== realm) return null
      return tx.run(async (s) => {
        const session = await s.sessionById(claims.sid)
        if (!session || session.realm !== realm || session.revokedAt) return null
        if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return null
        const user = await s.userById(session.principalId)
        if (!user || user.status !== "active") return null // IAM-08: a disabled account stops at its next request
        if (now.getTime() - session.lastActivityAt.getTime() >= TOUCH_EVERY_MS) {
          const limits = SESSION_LIMITS[realm]
          await s.touchSession(session.id, now, new Date(Math.min(now.getTime() + limits.idleMinutes * 60_000, session.absoluteExpiresAt.getTime())))
        }
        return Object.freeze({ sessionId: session.id, principalId: session.principalId, realm, xsrfHash: session.xsrfHash, activeWorkspaceId: session.activeWorkspaceId ?? null, user: Object.freeze(publicUser(user)) })
      })
    },

    async setActiveWorkspace(sessionId, workspaceId) {
      await tx.run((s) => s.setActiveWorkspace(sessionId, workspaceId))
    },
  }
}

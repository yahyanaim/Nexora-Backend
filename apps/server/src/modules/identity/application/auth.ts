import { uuidv7 } from "../../../db/uuid"
import { afterFailedAttempt, afterSuccess, isLocked } from "../domain/lockout"
import { CHALLENGE_ATTEMPTS, CHALLENGE_MINUTES, isRecoveryCodeShape, normalizeRecoveryCode, PASSCODE_ATTEMPTS } from "../domain/second-factor"
import { ACCESS_TOKEN_MINUTES, type Realm, SESSION_LIMITS } from "../domain/session-limits"
import type { AccessTokens, Clock, IdentityStore, IdentityTransactions, PasswordHasher, RateLimiter, SecretBox, SecretTokens, SessionRecord, TotpEngine, UserRecord } from "../ports"
import type { PasswordService } from "./passwords"

/**
 * Sign-in, refresh, sign-out and the session check of every request (cahier §8;
 * IAM-01, IAM-04, IAM-05, IAM-07, IAM-08, IAM-16, IAM-18). Member realm first;
 * the portal and the console reuse it with their own limits when they come.
 *
 * - A wrong password and an unknown e-mail get the same answer in the same time.
 * - Failures and the 15-minute lock are kept per e-mail, whether the account
 *   exists or not, so a lock never tells that an account exists; failures are
 *   also counted per client address.
 * - With a second factor, the right password opens a 5-minute challenge, not
 *   a session; the code (or a recovery code) then opens the session.
 * - The refresh token rotates on every use; a used token presented again ends the session.
 * - After the idle limit, a session with a passcode is locked, not ended: the
 *   passcode unlocks it until the absolute limit; the fifth wrong one ends it.
 * - Every request reloads the session and the account: a disabled account or a
 *   revoked session stops at the next request.
 */

export const SIGN_IN_WINDOW_SECONDS = 15 * 60
/** Failures per e-mail before it is locked for 15 minutes (IAM-04): MAX_FAILED_ATTEMPTS of the domain. */
export { MAX_FAILED_ATTEMPTS as SIGN_IN_FAILURES_PER_EMAIL } from "../domain/lockout"
/** Failures per client address in the window (cahier §18.4, starting value). */
export const SIGN_IN_FAILURES_PER_ADDRESS = 10
/** Wrong second-factor codes per person in the window (contract §12: like sign-in). */
export const SECOND_FACTOR_FAILURES_PER_PERSON = 10
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

export type SignInResult =
  | { ok: true; session: IssuedSession }
  | { ok: true; challengeId: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }

export type ChallengeResult = { ok: true; session: IssuedSession } | { ok: false; reason: "invalid" } | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }

export type RefreshResult = { ok: true; session: IssuedSession } | { ok: false; reason: "ended" | "locked" }

export type UnlockResult = { valid: true; session: IssuedSession } | { valid: false; ended: boolean }

/** The verified identity of a request (TEN-03): frozen, built only here. */
export interface SessionContext {
  readonly sessionId: string
  readonly principalId: string
  readonly realm: Realm
  readonly xsrfHash: string
  /** Chosen with PUT /app/v1/auth/workspace; checked against the memberships when used. */
  readonly activeWorkspaceId: string | null
  /** True when the person has an enabled second factor (IAM-05). */
  readonly twoFactorEnabled: boolean
  /** When the second factor was last given in this session (IAM-06). */
  readonly secondFactorAt: Date | null
  readonly user: Readonly<PublicUser>
}

export interface SessionView {
  id: string
  current: boolean
  createdAt: string
  lastActivityAt: string
  ip: string | null
  userAgent: string | null
}

export interface AuthDeps {
  tx: IdentityTransactions
  passwords: PasswordService
  hasher: PasswordHasher
  limiter: RateLimiter
  tokens: SecretTokens
  access: AccessTokens
  totp: TotpEngine
  box: SecretBox
  clock: Clock
}

export interface AuthService {
  signIn(input: { email: string; password: string; realm: "member" }, client: ClientInfo): Promise<SignInResult>
  /** The second step of a sign-in with a second factor. */
  verifyChallenge(challengeId: string, code: string, client: ClientInfo): Promise<ChallengeResult>
  refresh(refreshToken: string, client: ClientInfo): Promise<RefreshResult>
  /** Unlocks a session after the idle limit with the passcode (IAM-18). */
  unlock(refreshToken: string, passcode: string, client: ClientInfo): Promise<UnlockResult>
  signOut(sessionId: string, client: ClientInfo): Promise<void>
  authenticate(accessToken: string, realm: Realm): Promise<SessionContext | null>
  /** Records the workspace the session works in; the caller has checked the membership. */
  setActiveWorkspace(sessionId: string, workspaceId: string | null): Promise<void>
  listSessions(session: SessionContext): Promise<SessionView[]>
  /** Ends one of the person's other sessions; false when it is not theirs, not open, or the current one. */
  endSession(session: SessionContext, id: string, client: ClientInfo): Promise<boolean>
  /** Ends every other session of the person; answers how many. */
  endOtherSessions(session: SessionContext, client: ClientInfo): Promise<number>
  /** Ends every session of a person, for an administrator (§8.2 rule 5). */
  endAllSessionsOf(userId: string, byPrincipalId: string, client: ClientInfo): Promise<number>
}

const publicUser = (u: UserRecord): PublicUser => ({ id: u.id, email: u.email, name: u.name, locale: u.locale })
const normalizeEmail = (email: string) => email.normalize("NFKC").trim().toLowerCase()

export function authService(deps: AuthDeps): AuthService {
  const { tx, passwords, hasher, limiter, tokens, access, totp, box, clock } = deps
  const addressBucket = (ip: string | null) => `sign_in:address:${tokens.hash(ip ?? "unknown")}`
  const personBucket = (principalId: string) => `second_factor:person:${principalId}`

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

  /** A new session, refresh token and XSRF value for a person who passed every check. */
  async function openSession(s: IdentityStore, user: UserRecord, realm: Realm, now: Date, client: ClientInfo, secondFactorAt: Date | null) {
    const limits = SESSION_LIMITS[realm]
    const session = {
      id: uuidv7(),
      principalId: user.id,
      realm,
      createdAt: now,
      lastActivityAt: now,
      idleExpiresAt: new Date(now.getTime() + limits.idleMinutes * 60_000),
      absoluteExpiresAt: new Date(now.getTime() + limits.absoluteHours * 3_600_000),
    }
    const xsrfToken = tokens.generate()
    await s.createSession({ ...session, xsrfHash: tokens.hash(xsrfToken) }, client)
    if (secondFactorAt) await s.markSecondFactor(session.id, secondFactorAt)
    const refreshToken = tokens.generate()
    await s.addRefreshToken({ id: uuidv7(), sessionId: session.id, tokenHash: tokens.hash(refreshToken), expiresAt: session.absoluteExpiresAt })
    await s.audit({ action: "sign_in.succeeded", realm, principalId: user.id, sessionId: session.id, ...client })
    return issue(session, user, refreshToken, now, xsrfToken)
  }

  /** Rotates the refresh token of a session and slides its idle limit. */
  async function rotate(s: IdentityStore, session: SessionRecord, oldTokenId: string, user: UserRecord, now: Date) {
    const next = tokens.generate()
    const nextId = uuidv7()
    await s.addRefreshToken({ id: nextId, sessionId: session.id, tokenHash: tokens.hash(next), expiresAt: session.absoluteExpiresAt })
    await s.markRefreshTokenReplaced(oldTokenId, nextId)
    const limits = SESSION_LIMITS[session.realm]
    await s.touchSession(session.id, now, new Date(Math.min(now.getTime() + limits.idleMinutes * 60_000, session.absoluteExpiresAt.getTime())))
    return issue(session, user, next, now)
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
        const factor = await s.secondFactorOf(user.id)
        if (factor?.enabledAt) {
          const challengeId = tokens.generate()
          await s.createChallenge({ id: uuidv7(), tokenHash: tokens.hash(challengeId), userId: user.id, realm: input.realm, expiresAt: new Date(now.getTime() + CHALLENGE_MINUTES * 60_000) }, client)
          await s.audit({ action: "sign_in.second_factor_asked", realm: input.realm, principalId: user.id, ...client })
          return { ok: true, challengeId }
        }
        return { ok: true, session: await openSession(s, user, input.realm, now, client, null) }
      })

      if (!result.ok && result.reason === "invalid") await limiter.hit(addressBucket(client.ip), SIGN_IN_WINDOW_SECONDS)
      return result
    },

    async verifyChallenge(challengeId, code, client) {
      const now = clock.now()
      const outcome = await tx.run(async (s): Promise<ChallengeResult & { principalId?: string }> => {
        const challenge = await s.challengeByHash(tokens.hash(challengeId))
        if (!challenge || challenge.usedAt || challenge.expiresAt <= now || challenge.attempts >= CHALLENGE_ATTEMPTS) return { ok: false, reason: "invalid" }
        const perPerson = await limiter.count(personBucket(challenge.userId), SIGN_IN_WINDOW_SECONDS)
        if (perPerson.hits >= SECOND_FACTOR_FAILURES_PER_PERSON) return { ok: false, reason: "rate_limited", retryAfterSeconds: perPerson.retryAfterSeconds }
        const user = await s.userById(challenge.userId)
        const factor = await s.secondFactorOf(challenge.userId)
        if (!user || user.status !== "active" || !factor?.enabledAt) return { ok: false, reason: "invalid" }

        const step = totp.check(box.open(factor.secretEnc), code, now, factor.lastStep)
        const recovery = step === null && isRecoveryCodeShape(code) ? await s.useRecoveryCode(user.id, tokens.hash(normalizeRecoveryCode(code)), now) : false
        if (step === null && !recovery) {
          await s.countChallengeAttempt(challenge.id)
          await s.audit({ action: "two_factor.failed", realm: challenge.realm, principalId: user.id, ...client })
          return { ok: false, reason: "invalid", principalId: user.id }
        }
        if (step !== null) await s.acceptStep(user.id, step)
        else await s.audit({ action: "two_factor.recovery_used", realm: challenge.realm, principalId: user.id, ...client })
        await s.useChallenge(challenge.id, now)
        return { ok: true, session: await openSession(s, user, challenge.realm, now, client, now) }
      })
      if (!outcome.ok && outcome.reason === "invalid" && outcome.principalId) await limiter.hit(personBucket(outcome.principalId), SIGN_IN_WINDOW_SECONDS)
      if (outcome.ok) return { ok: true, session: outcome.session }
      return outcome.reason === "rate_limited" ? { ok: false, reason: "rate_limited", retryAfterSeconds: outcome.retryAfterSeconds } : { ok: false, reason: "invalid" }
    },

    async refresh(refreshToken, client) {
      const now = clock.now()
      return tx.run(async (s): Promise<RefreshResult> => {
        const token = await s.refreshTokenByHash(tokens.hash(refreshToken))
        if (!token) return { ok: false, reason: "ended" }
        const session = await s.sessionById(token.sessionId)
        if (!session) return { ok: false, reason: "ended" }
        if (token.revokedAt) {
          // A replaced token came back: someone else holds a copy. End the session (IAM-07).
          if (!session.revokedAt) {
            await s.revokeSession(session.id, "refresh_reuse")
            await s.audit({ action: "session.refresh_reused", realm: session.realm, principalId: session.principalId, sessionId: session.id, ...client })
          }
          return { ok: false, reason: "ended" }
        }
        if (session.revokedAt || token.expiresAt <= now || session.absoluteExpiresAt <= now) return { ok: false, reason: "ended" }
        const user = await s.userById(session.principalId)
        if (!user || user.status !== "active") return { ok: false, reason: "ended" }
        // After the idle limit, a passcode locks the session instead of ending it (IAM-18).
        if (session.idleExpiresAt <= now) return { ok: false, reason: (await s.passcodeOf(user.id)) ? "locked" : "ended" }
        return { ok: true, session: await rotate(s, session, token.id, user, now) }
      })
    },

    async unlock(refreshToken, passcode, client) {
      const now = clock.now()
      return tx.run(async (s): Promise<UnlockResult> => {
        const token = await s.refreshTokenByHash(tokens.hash(refreshToken))
        if (!token || token.revokedAt) return { valid: false, ended: true }
        const session = await s.sessionById(token.sessionId)
        if (!session || session.revokedAt || session.absoluteExpiresAt <= now || token.expiresAt <= now) return { valid: false, ended: true }
        const user = await s.userById(session.principalId)
        const stored = user?.status === "active" ? await s.passcodeOf(user.id) : null
        if (!user || !stored) return { valid: false, ended: true }
        if (!(await hasher.verify(stored.hash, passcode))) {
          const failures = stored.failedAttempts + 1
          if (failures >= PASSCODE_ATTEMPTS) {
            await s.setPasscodeFailures(user.id, 0)
            await s.revokeSession(session.id, "passcode_failed")
            await s.audit({ action: "passcode.locked_out", realm: session.realm, principalId: user.id, sessionId: session.id, ...client })
            return { valid: false, ended: true }
          }
          await s.setPasscodeFailures(user.id, failures)
          await s.audit({ action: "passcode.failed", realm: session.realm, principalId: user.id, sessionId: session.id, ...client })
          return { valid: false, ended: false }
        }
        await s.setPasscodeFailures(user.id, 0)
        await s.audit({ action: "session.unlocked", realm: session.realm, principalId: user.id, sessionId: session.id, ...client })
        return { valid: true, session: await rotate(s, session, token.id, user, now) }
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
        const factor = await s.secondFactorOf(user.id)
        return Object.freeze({
          sessionId: session.id,
          principalId: session.principalId,
          realm,
          xsrfHash: session.xsrfHash,
          activeWorkspaceId: session.activeWorkspaceId ?? null,
          twoFactorEnabled: !!factor?.enabledAt,
          secondFactorAt: session.secondFactorAt ?? null,
          user: Object.freeze(publicUser(user)),
        })
      })
    },

    async setActiveWorkspace(sessionId, workspaceId) {
      await tx.run((s) => s.setActiveWorkspace(sessionId, workspaceId))
    },

    async listSessions(session) {
      const now = clock.now()
      const list = await tx.run((s) => s.openSessions(session.principalId, now))
      return list.map((x) => ({
        id: x.id,
        current: x.id === session.sessionId,
        createdAt: x.createdAt.toISOString(),
        lastActivityAt: x.lastActivityAt.toISOString(),
        ip: x.ip,
        userAgent: x.userAgent,
      }))
    },

    async endSession(session, id, client) {
      if (id === session.sessionId) return false
      return tx.run(async (s) => {
        const target = await s.sessionById(id)
        if (!target || target.principalId !== session.principalId || target.revokedAt) return false
        await s.revokeSession(id, "user")
        await s.audit({ action: "session.revoked", realm: target.realm, principalId: session.principalId, sessionId: id, ...client })
        return true
      })
    },

    async endOtherSessions(session, client) {
      return tx.run(async (s) => {
        const n = await s.revokeSessionsOf(session.principalId, "user", session.sessionId)
        if (n) await s.audit({ action: "session.revoked_others", realm: session.realm, principalId: session.principalId, sessionId: session.sessionId, ...client })
        return n
      })
    },

    async endAllSessionsOf(userId, byPrincipalId, client) {
      return tx.run(async (s) => {
        const n = await s.revokeSessionsOf(userId, "admin", null)
        await s.audit({ action: "session.revoked_by_admin", realm: "member", principalId: userId, ...client })
        await s.audit({ action: "session.revoked_member", realm: "member", principalId: byPrincipalId, ...client })
        return n
      })
    },
  }
}

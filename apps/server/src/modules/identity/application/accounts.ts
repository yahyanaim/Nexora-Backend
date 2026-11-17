import { uuidv7 } from "../../../db/uuid"
import { afterSuccess } from "../domain/lockout"
import { tokenExpiresAt } from "../domain/sign-in-tokens"
import type { Clock, IdentityTransactions, RateLimiter, SecretBox, SecretTokens } from "../ports"
import { type ClientInfo, SIGN_IN_FAILURES_PER_ADDRESS, SIGN_IN_WINDOW_SECONDS } from "./auth"
import type { PasswordService } from "./passwords"

/**
 * Invitations and password reset (cahier §8.1; IAM-03, IAM-10, IAM-15, IAM-16).
 *
 * - A link is random (256 bits), stored as SHA-256, and used once: the
 *   database marks it used in the same statement that reads it, so two
 *   requests together get it once.
 * - The e-mail is written to the outbox in the same transaction as its link;
 *   the link travels sealed (AES-256-GCM), so the outbox never holds it in
 *   clear. The worker sends it from B1e.
 * - Asking for a reset answers the same whether the e-mail exists or not.
 * - A new password ends every session of the account and clears its lock.
 */

export type AccountRefusal = "invite_used" | "invite_expired" | "reset_invalid" | "password_too_short" | "password_too_long" | "password_breached" | "rate_limited"

export class AccountError extends Error {
  constructor(
    readonly code: AccountRefusal,
    readonly values: Record<string, number> = {},
  ) {
    super(code)
    this.name = "AccountError"
  }
}

export interface AccountsService {
  /** The account an invitation goes to: an existing member account, or a new one without a password. */
  accountForInvitation(input: { email: string; name: string }): Promise<{ userId: string; created: boolean }>
  /** Issues the 7-day link and writes the e-mail to the outbox. */
  sendInvitation(input: { userId: string; email: string; workspaceId: string; membershipId: string; invitedBy: string }, client: ClientInfo): Promise<void>
  /** Reads an invitation link without using it. */
  checkInvitation(token: string): Promise<{ email: string; workspaceId: string; membershipId: string; userId: string; needsPassword: boolean }>
  /**
   * Uses an invitation link once. A person without a password chooses one
   * (checked before the link is used); the account becomes active.
   */
  acceptInvitation(token: string, password: string | undefined, client: ClientInfo): Promise<{ userId: string; workspaceId: string; membershipId: string }>
  /** Always the same answer; a link is sent only to an active account. */
  requestPasswordReset(email: string, client: ClientInfo): Promise<void>
  checkPasswordReset(token: string): Promise<void>
  resetPassword(token: string, password: string, client: ClientInfo): Promise<void>
}

const normalizeEmail = (email: string) => email.normalize("NFKC").trim().toLowerCase()

export function accountsService(deps: { tx: IdentityTransactions; passwords: PasswordService; limiter: RateLimiter; tokens: SecretTokens; mailBox: SecretBox; clock: Clock }): AccountsService {
  const { tx, passwords, limiter, tokens, mailBox, clock } = deps
  const resetBucket = (key: string) => `password_reset:${key}`

  async function choose(password: string) {
    const chosen = await passwords.choose(password)
    if (chosen.ok) return chosen.hash
    const code = chosen.problem === "too_short" ? "password_too_short" : chosen.problem === "too_long" ? "password_too_long" : "password_breached"
    throw new AccountError(code, chosen.values)
  }

  async function invitation(token: string) {
    const record = await tx.run((s) => s.tokenByHash(tokens.hash(token), "invite"))
    if (!record || !record.principalId) throw new AccountError("invite_expired")
    if (record.usedAt) throw new AccountError("invite_used")
    if (record.expiresAt <= clock.now()) throw new AccountError("invite_expired")
    return record
  }

  const service: AccountsService = {
    async accountForInvitation(input) {
      const email = normalizeEmail(input.email)
      return tx.run(async (s) => {
        const existing = await s.userByEmail(email)
        if (existing) return { userId: existing.id, created: false }
        const id = uuidv7()
        await s.createInvitedUser({ id, email, name: input.name.trim() })
        return { userId: id, created: true }
      })
    },

    async sendInvitation(input, client) {
      const token = tokens.generate()
      const now = clock.now()
      await tx.run(async (s) => {
        await s.issueToken({
          id: uuidv7(),
          purpose: "invite",
          email: normalizeEmail(input.email),
          principalId: input.userId,
          tokenHash: tokens.hash(token),
          createdAt: now,
          expiresAt: tokenExpiresAt("invite", now),
          context: { workspaceId: input.workspaceId, membershipId: input.membershipId, invitedBy: input.invitedBy },
        })
        await s.enqueueMail({
          eventType: "identity.invitation_sent",
          aggregateId: input.userId,
          payload: { to: normalizeEmail(input.email), workspaceId: input.workspaceId, membershipId: input.membershipId, link: mailBox.seal(token) },
        })
        await s.audit({ action: "invitation.sent", realm: "member", principalId: input.userId, ...client })
      })
    },

    async checkInvitation(token) {
      const record = await invitation(token)
      const user = await tx.run((s) => s.userById(record.principalId!))
      if (!user || user.status === "disabled") throw new AccountError("invite_expired")
      return {
        email: user.email,
        workspaceId: String(record.context.workspaceId),
        membershipId: String(record.context.membershipId),
        userId: user.id,
        needsPassword: !user.passwordHash,
      }
    },

    async acceptInvitation(token, password, client) {
      const preview = await this_checkInvitation(token)
      // The password is chosen before the link is used: a refused password leaves the link usable.
      const hash = preview.needsPassword ? await choose(password ?? "") : null
      const now = clock.now()
      return tx.run(async (s) => {
        const used = await s.consumeToken(tokens.hash(token), "invite", now)
        if (!used) throw new AccountError("invite_used")
        await s.activateUser(preview.userId, hash)
        await s.audit({ action: "invitation.accepted", realm: "member", principalId: preview.userId, ...client })
        return { userId: preview.userId, workspaceId: preview.workspaceId, membershipId: preview.membershipId }
      })
    },

    async requestPasswordReset(rawEmail, client) {
      const email = normalizeEmail(rawEmail)
      const perAddress = await limiter.count(resetBucket(`address:${tokens.hash(client.ip ?? "unknown")}`), SIGN_IN_WINDOW_SECONDS)
      const perEmail = await limiter.count(resetBucket(`email:${tokens.hash(email)}`), SIGN_IN_WINDOW_SECONDS)
      if (perAddress.hits >= SIGN_IN_FAILURES_PER_ADDRESS || perEmail.hits >= 5) throw new AccountError("rate_limited")
      await limiter.hit(resetBucket(`address:${tokens.hash(client.ip ?? "unknown")}`), SIGN_IN_WINDOW_SECONDS)
      await limiter.hit(resetBucket(`email:${tokens.hash(email)}`), SIGN_IN_WINDOW_SECONDS)
      const token = tokens.generate()
      const now = clock.now()
      await tx.run(async (s) => {
        const user = await s.userByEmail(email)
        if (!user || user.status !== "active") {
          await s.audit({ action: "password.reset_asked_unknown", realm: "member", email, ...client })
          return
        }
        await s.issueToken({ id: uuidv7(), purpose: "reset", email, principalId: user.id, tokenHash: tokens.hash(token), createdAt: now, expiresAt: tokenExpiresAt("reset", now), context: {} })
        await s.enqueueMail({ eventType: "identity.password_reset_requested", aggregateId: user.id, payload: { to: email, link: mailBox.seal(token) } })
        await s.audit({ action: "password.reset_asked", realm: "member", principalId: user.id, ...client })
      })
    },

    async checkPasswordReset(token) {
      const record = await tx.run((s) => s.tokenByHash(tokens.hash(token), "reset"))
      if (!record || record.usedAt || record.expiresAt <= clock.now()) throw new AccountError("reset_invalid")
    },

    async resetPassword(token, password, client) {
      await this_checkPasswordReset(token)
      const hash = await choose(password)
      const now = clock.now()
      await tx.run(async (s) => {
        const used = await s.consumeToken(tokens.hash(token), "reset", now)
        if (!used?.principalId) throw new AccountError("reset_invalid")
        const user = await s.userById(used.principalId)
        if (!user || user.status !== "active") throw new AccountError("reset_invalid")
        await s.replacePasswordHash(user.id, hash)
        await s.saveLock(user.id, afterSuccess())
        await s.expireTokensOf(user.id, "reset", now)
        // IAM-15: every other browser is signed out; the person signs in again with the new password.
        await s.revokeSessionsOf(user.id, "password_changed", null)
        await s.audit({ action: "password.reset", realm: "member", principalId: user.id, ...client })
      })
    },
  }

  return service

  // The methods above call each other through these, without `this`.
  function this_checkInvitation(token: string) {
    return service.checkInvitation(token)
  }
  function this_checkPasswordReset(token: string) {
    return service.checkPasswordReset(token)
  }
}

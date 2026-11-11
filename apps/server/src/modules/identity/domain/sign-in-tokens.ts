/**
 * Purposes and lifetimes of single-use tokens (IAM-10, cahier Table 18). The
 * tokens themselves are random, at least 256 bits, and stored hashed; they are
 * made and hashed in infrastructure. Pure.
 */

export const TOKEN_PURPOSES = ["verify", "reset", "email_change", "second_factor_reset", "invite", "portal_link", "staff_invite"] as const
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number]

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const TOKEN_LIFETIME_MS: Readonly<Record<TokenPurpose, number>> = Object.freeze({
  portal_link: 15 * MINUTE,
  verify: 24 * HOUR,
  reset: 24 * HOUR,
  email_change: 24 * HOUR,
  second_factor_reset: 24 * HOUR,
  invite: 7 * 24 * HOUR,
  staff_invite: 72 * HOUR,
})

export function tokenExpiresAt(purpose: TokenPurpose, issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + TOKEN_LIFETIME_MS[purpose])
}

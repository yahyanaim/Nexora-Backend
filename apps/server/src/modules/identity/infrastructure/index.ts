import type pg from "pg"
import { authService, type AuthService } from "../application/auth"
import { passwordService, type PasswordService } from "../application/passwords"
import { hmacAccessTokens } from "./access-tokens"
import { argon2Hasher } from "./argon2-hasher"
import { leakedPasswords } from "./breached-list"
import { pgIdentityTransactions, pgRateLimiter } from "./pg-store"
import { secretTokens } from "./secret-tokens"

/**
 * Builds the identity services on PostgreSQL. Only the composition roots
 * (main.ts) and tests call it; the HTTP layer receives the services ready.
 */
export function createIdentity(deps: { pool: pg.Pool; sessionSecret: string; now?: () => Date }): { auth: AuthService; passwords: PasswordService } {
  const passwords = passwordService({ hasher: argon2Hasher, leaked: leakedPasswords })
  const auth = authService({
    tx: pgIdentityTransactions(deps.pool),
    passwords,
    limiter: pgRateLimiter(deps.pool),
    tokens: secretTokens,
    access: hmacAccessTokens(deps.sessionSecret),
    clock: { now: deps.now ?? (() => new Date()) },
  })
  return { auth, passwords }
}

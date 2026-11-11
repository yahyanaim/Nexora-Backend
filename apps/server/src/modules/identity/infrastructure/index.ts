import type pg from "pg"
import { authService, type AuthService } from "../application/auth"
import { passwordService, type PasswordService } from "../application/passwords"
import { secondFactorService, type SecondFactorService } from "../application/second-factor"
import { hmacAccessTokens } from "./access-tokens"
import { argon2Hasher } from "./argon2-hasher"
import { leakedPasswords } from "./breached-list"
import { pgIdentityTransactions, pgRateLimiter } from "./pg-store"
import { aesGcmBox } from "./secret-box"
import { secretTokens } from "./secret-tokens"
import { totp } from "./totp"

/**
 * Builds the identity services on PostgreSQL. Only the composition roots
 * (main.ts) and tests call it; the HTTP layer receives the services ready.
 */
export function createIdentity(deps: { pool: pg.Pool; sessionSecret: string; encryptionKey: string; now?: () => Date }): {
  auth: AuthService
  passwords: PasswordService
  secondFactor: SecondFactorService
} {
  const passwords = passwordService({ hasher: argon2Hasher, leaked: leakedPasswords })
  const shared = {
    tx: pgIdentityTransactions(deps.pool),
    hasher: argon2Hasher,
    limiter: pgRateLimiter(deps.pool),
    tokens: secretTokens,
    totp,
    box: aesGcmBox(deps.encryptionKey, "second-factor"),
    clock: { now: deps.now ?? (() => new Date()) },
  }
  const auth = authService({ ...shared, passwords, access: hmacAccessTokens(deps.sessionSecret) })
  return { auth, passwords, secondFactor: secondFactorService(shared) }
}

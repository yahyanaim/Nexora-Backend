import type { LockState } from "../domain/lockout"
import type { Realm } from "../domain/session-limits"

/**
 * What the identity application needs from the outside world. The
 * infrastructure folder implements each port; tests may pass fakes.
 */

/** Argon2id hashing of passwords (IAM-02). */
export interface PasswordHasher {
  hash(password: string): Promise<string>
  /** False for a wrong password and for a hash it cannot read; never throws on input. */
  verify(hash: string, password: string): Promise<boolean>
  /** True when the stored hash should be replaced at the next successful sign-in (other algorithm or weaker settings). */
  needsRehash(hash: string): boolean
}

/** The list of leaked passwords, compared in normalised form (see normalizeForLeakCheck). */
export interface LeakedPasswordList {
  has(normalized: string): boolean
}

/** Single-use and session secrets (IAM-10). */
export interface SecretTokens {
  /** A new random secret of at least 256 bits, URL-safe. */
  generate(): string
  /** The form stored in the database: SHA-256, hex. */
  hash(token: string): string
}

// ---- Sessions (B1b step 2) ----


export interface UserRecord {
  id: string
  email: string
  name: string
  locale: string
  status: "invited" | "active" | "disabled"
  passwordHash: string | null
  lock: LockState
}

export interface SessionRecord {
  id: string
  principalId: string
  realm: Realm
  createdAt: Date
  lastActivityAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
  xsrfHash: string
  revokedAt: Date | null
  /** The workspace the session works in when a path names none (§5.5 step 4). */
  activeWorkspaceId?: string | null
  /** When the second factor was last given in this session (sign-in or step-up). */
  secondFactorAt?: Date | null
}

export interface RefreshRecord {
  id: string
  sessionId: string
  expiresAt: Date
  /** Set when the token was used (and replaced) or its session ended. */
  revokedAt: Date | null
}

export type RevokeReason = "sign_out" | "expired" | "refresh_reuse" | "password_changed" | "admin" | "user" | "account_disabled" | "passcode_failed"

// ---- Second factor, sessions list, passcode (B1b step 4) ----

export interface SecondFactorRecord {
  /** Encrypted with the SecretBox; opened only to check a code. */
  secretEnc: string
  enabledAt: Date | null
  lastStep: number
}

export interface ChallengeRecord {
  id: string
  userId: string
  realm: Realm
  attempts: number
  expiresAt: Date
  usedAt: Date | null
}

export interface SessionListItem {
  id: string
  createdAt: Date
  lastActivityAt: Date
  ip: string | null
  userAgent: string | null
}

export interface PasscodeRecord {
  hash: string
  failedAttempts: number
}

/** RFC 6238 codes. `check` returns the step a code belongs to, after `lastStep` only, or null. */
export interface TotpEngine {
  newSecret(): string
  otpauthUrl(secret: string, account: string, issuer?: string): string
  check(secret: string, code: string, now: Date, lastStep: number): number | null
}

/** Encryption of stored secrets (SCR-07). */
export interface SecretBox {
  seal(plain: string): string
  open(sealed: string): string
}

/** An event of the identity trail (IAM-16): no workspace is known yet. The store hashes the e-mail. */
export interface IdentityEvent {
  action: string
  realm: Realm
  principalId?: string | null
  email?: string | null
  sessionId?: string | null
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

/** Reads and writes of one transaction of the identity module. */
export interface IdentityStore {
  userByEmail(email: string): Promise<UserRecord | null>
  userById(id: string): Promise<UserRecord | null>
  /** The failure and lock state of an e-mail (hashed), locked until the transaction ends; a new e-mail starts empty. */
  failuresOf(emailHash: string): Promise<LockState>
  saveFailures(emailHash: string, state: LockState): Promise<void>
  clearFailures(emailHash: string): Promise<void>
  /** Mirrors the lock on the account, for the people who manage it. */
  saveLock(userId: string, lock: LockState): Promise<void>
  replacePasswordHash(userId: string, hash: string): Promise<void>
  createSession(session: Omit<SessionRecord, "revokedAt">, client: { ip: string | null; userAgent: string | null }): Promise<void>
  sessionById(id: string): Promise<SessionRecord | null>
  touchSession(id: string, lastActivityAt: Date, idleExpiresAt: Date): Promise<void>
  /** Ends a session and every refresh token it still holds. */
  revokeSession(id: string, reason: RevokeReason): Promise<void>
  setActiveWorkspace(sessionId: string, workspaceId: string | null): Promise<void>
  addRefreshToken(token: { id: string; sessionId: string; tokenHash: string; expiresAt: Date }): Promise<void>
  /** Locks the row until the transaction ends, so two refreshes with one token cannot both succeed. */
  refreshTokenByHash(tokenHash: string): Promise<RefreshRecord | null>
  markRefreshTokenReplaced(id: string, replacedBy: string): Promise<void>
  audit(event: IdentityEvent): Promise<void>

  /** Locked until the transaction ends. */
  secondFactorOf(principalId: string): Promise<SecondFactorRecord | null>
  /** Replaces a set-up waiting for its first code; never an enabled factor (the caller checks). */
  saveSecondFactorSetup(principalId: string, secretEnc: string): Promise<void>
  enableSecondFactor(principalId: string, at: Date, step: number): Promise<void>
  acceptStep(principalId: string, step: number): Promise<void>
  deleteSecondFactor(principalId: string): Promise<void>
  replaceRecoveryCodes(principalId: string, hashes: string[]): Promise<void>
  /** Marks the code used and answers true when it was unused. */
  useRecoveryCode(principalId: string, hash: string, at: Date): Promise<boolean>
  remainingRecoveryCodes(principalId: string): Promise<number>
  createChallenge(challenge: { id: string; tokenHash: string; userId: string; realm: Realm; expiresAt: Date }, client: { ip: string | null; userAgent: string | null }): Promise<void>
  /** Locked until the transaction ends. */
  challengeByHash(tokenHash: string): Promise<ChallengeRecord | null>
  countChallengeAttempt(id: string): Promise<void>
  useChallenge(id: string, at: Date): Promise<void>
  markSecondFactor(sessionId: string, at: Date): Promise<void>
  openSessions(principalId: string, now: Date): Promise<SessionListItem[]>
  /** Ends every open session of the principal except `exceptId`; answers how many. */
  revokeSessionsOf(principalId: string, reason: RevokeReason, exceptId: string | null): Promise<number>
  /** Locked until the transaction ends. */
  passcodeOf(userId: string): Promise<PasscodeRecord | null>
  savePasscode(userId: string, hash: string): Promise<void>
  deletePasscode(userId: string): Promise<void>
  setPasscodeFailures(userId: string, failedAttempts: number): Promise<void>
  /** The session a refresh token belongs to, without using the token. */
  sessionByRefreshHash(tokenHash: string): Promise<SessionRecord | null>
}

/** Runs work in one database transaction of the member realm. */
export interface IdentityTransactions {
  run<T>(work: (store: IdentityStore) => Promise<T>): Promise<T>
}

/** Counters of failed attempts per bucket (IAM-04, IAM-09). Keys are hashed by the implementation. */
export interface RateLimiter {
  /** Hits counted in the current window of the bucket. */
  count(bucket: string, windowSeconds: number): Promise<{ hits: number; retryAfterSeconds: number }>
  hit(bucket: string, windowSeconds: number): Promise<void>
  clear(bucket: string): Promise<void>
}

/** The short-lived access token of a session (§8.2 rule 1): the session id and realm, signed, nothing else. */
export interface AccessTokens {
  issue(claims: { sid: string; realm: Realm; expiresAt: Date }): string
  /** The claims of a token signed by this server and not yet expired, otherwise null. */
  read(token: string, now: Date): { sid: string; realm: Realm; expiresAt: Date } | null
}

export interface Clock {
  now(): Date
}

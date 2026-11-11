/**
 * The public interface of the identity module (ARC-06): other modules and the
 * HTTP layer import only from here.
 */
export { passwordService, type ChooseResult, type PasswordService } from "./passwords"
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, type PasswordProblem } from "../domain/password-policy"
export { REALMS, SESSION_LIMITS, ACCESS_TOKEN_MINUTES, sessionEndsAt, isSessionExpired, memberLimits, type Realm } from "../domain/session-limits"
export { MAX_FAILED_ATTEMPTS, LOCK_MINUTES, isLocked, afterFailedAttempt, afterSuccess, type LockState } from "../domain/lockout"
export { TOKEN_PURPOSES, TOKEN_LIFETIME_MS, tokenExpiresAt, type TokenPurpose } from "../domain/sign-in-tokens"
export type { LeakedPasswordList, PasswordHasher, SecretTokens } from "../ports"

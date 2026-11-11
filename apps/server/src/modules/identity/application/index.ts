/**
 * The public interface of the identity module (ARC-06): other modules and the
 * HTTP layer import only from here.
 */
export { passwordService, type ChooseResult, type PasswordService } from "./passwords"
export { authService, type AuthService, type ClientInfo, type IssuedSession, type PublicUser, type SessionContext, type SignInResult, SIGN_IN_FAILURES_PER_ADDRESS, SIGN_IN_FAILURES_PER_EMAIL, SIGN_IN_WINDOW_SECONDS } from "./auth"
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, type PasswordProblem } from "../domain/password-policy"
export { REALMS, SESSION_LIMITS, ACCESS_TOKEN_MINUTES, sessionEndsAt, isSessionExpired, memberLimits, type Realm } from "../domain/session-limits"
export { MAX_FAILED_ATTEMPTS, LOCK_MINUTES, isLocked, afterFailedAttempt, afterSuccess, type LockState } from "../domain/lockout"
export { TOKEN_PURPOSES, TOKEN_LIFETIME_MS, tokenExpiresAt, type TokenPurpose } from "../domain/sign-in-tokens"
export type { AccessTokens, Clock, IdentityStore, IdentityTransactions, LeakedPasswordList, PasswordHasher, RateLimiter, SecretTokens } from "../ports"

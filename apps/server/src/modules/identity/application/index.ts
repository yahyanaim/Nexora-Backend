/**
 * The public interface of the identity module (ARC-06): other modules and the
 * HTTP layer import only from here.
 */
export { passwordService, type ChooseResult, type PasswordService } from "./passwords"
export {
  authService,
  type AuthService,
  type ChallengeResult,
  type ClientInfo,
  type IssuedSession,
  type PublicUser,
  type RefreshResult,
  type SessionContext,
  type SessionView,
  type SignInResult,
  type UnlockResult,
  SECOND_FACTOR_FAILURES_PER_PERSON,
  SIGN_IN_FAILURES_PER_ADDRESS,
  SIGN_IN_FAILURES_PER_EMAIL,
  SIGN_IN_WINDOW_SECONDS,
} from "./auth"
export { secondFactorService, SecondFactorError, type SecondFactorRefusal, type SecondFactorService } from "./second-factor"
export { CHALLENGE_ATTEMPTS, CHALLENGE_MINUTES, isStepUpFresh, PASSCODE_ATTEMPTS, RECOVERY_CODE_COUNT, STEP_UP_MINUTES } from "../domain/second-factor"
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, type PasswordProblem } from "../domain/password-policy"
export { REALMS, SESSION_LIMITS, ACCESS_TOKEN_MINUTES, sessionEndsAt, isSessionExpired, memberLimits, type Realm } from "../domain/session-limits"
export { MAX_FAILED_ATTEMPTS, LOCK_MINUTES, isLocked, afterFailedAttempt, afterSuccess, type LockState } from "../domain/lockout"
export { TOKEN_PURPOSES, TOKEN_LIFETIME_MS, tokenExpiresAt, type TokenPurpose } from "../domain/sign-in-tokens"
export type { AccessTokens, Clock, IdentityStore, IdentityTransactions, LeakedPasswordList, PasswordHasher, RateLimiter, SecretBox, SecretTokens, TotpEngine } from "../ports"

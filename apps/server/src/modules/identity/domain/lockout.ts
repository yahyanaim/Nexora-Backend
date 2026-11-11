/**
 * Sign-in lockout (IAM-04): after 5 failed attempts the account is locked for
 * 15 minutes. A success, or a failure after the lock has run out, starts the
 * count again. Pure: the time is passed in.
 */

export const MAX_FAILED_ATTEMPTS = 5
export const LOCK_MINUTES = 15

export interface LockState {
  failedAttempts: number
  lockedUntil: Date | null
}

export function isLocked(state: LockState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()
}

/** The state after one more failed attempt. */
export function afterFailedAttempt(state: LockState, now: Date): LockState {
  const expired = state.lockedUntil !== null && state.lockedUntil.getTime() <= now.getTime()
  const failedAttempts = (expired ? 0 : state.failedAttempts) + 1
  return failedAttempts >= MAX_FAILED_ATTEMPTS
    ? { failedAttempts, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) }
    : { failedAttempts, lockedUntil: expired ? null : state.lockedUntil }
}

/** The state after a successful sign-in. */
export function afterSuccess(): LockState {
  return { failedAttempts: 0, lockedUntil: null }
}

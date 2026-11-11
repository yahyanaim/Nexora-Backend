/**
 * Sign-in lockout (IAM-04): after 5 failed attempts the e-mail is locked for
 * 15 minutes. A success, a failure after the lock has run out, or a failure
 * more than 15 minutes after the previous one starts the count again. The same
 * state is kept for every e-mail tried, existing or not, so a lock never tells
 * that an account exists. Pure: the time is passed in.
 */

export const MAX_FAILED_ATTEMPTS = 5
export const LOCK_MINUTES = 15

export interface LockState {
  failedAttempts: number
  lockedUntil: Date | null
  lastFailureAt?: Date | null
}

export function isLocked(state: LockState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()
}

/** The state after one more failed attempt. */
export function afterFailedAttempt(state: LockState, now: Date): LockState {
  const expired = state.lockedUntil !== null && state.lockedUntil.getTime() <= now.getTime()
  const stale = !!state.lastFailureAt && now.getTime() - state.lastFailureAt.getTime() > LOCK_MINUTES * 60_000
  const fresh = expired || stale
  const failedAttempts = (fresh ? 0 : state.failedAttempts) + 1
  return failedAttempts >= MAX_FAILED_ATTEMPTS
    ? { failedAttempts, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000), lastFailureAt: now }
    : { failedAttempts, lockedUntil: fresh ? null : state.lockedUntil, lastFailureAt: now }
}

/** The state after a successful sign-in. */
export function afterSuccess(): LockState {
  return { failedAttempts: 0, lockedUntil: null, lastFailureAt: null }
}

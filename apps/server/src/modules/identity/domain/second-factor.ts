/**
 * Second factor, step-up and lock-screen rules (cahier §8; IAM-05, IAM-06,
 * IAM-18). Pure: the time is passed in.
 */

/** A sign-in challenge lasts 5 minutes and accepts 5 codes. */
export const CHALLENGE_MINUTES = 5
export const CHALLENGE_ATTEMPTS = 5

/** Ten recovery codes, shown once. */
export const RECOVERY_CODE_COUNT = 10

/** A sensitive action needs a second factor given less than 5 minutes ago (IAM-06). */
export const STEP_UP_MINUTES = 5

export function isStepUpFresh(secondFactorAt: Date | null | undefined, now: Date): boolean {
  if (!secondFactorAt) return false
  const age = now.getTime() - secondFactorAt.getTime()
  return age >= 0 && age < STEP_UP_MINUTES * 60_000
}

/** Recovery codes are typed by people: lower case, without spaces or dashes. */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[\s-]/g, "")

/** A recovery code looks like `xxxxx-xxxxx` (base32, 50 bits). */
export const isRecoveryCodeShape = (code: string) => /^[a-z2-7]{10}$/.test(normalizeRecoveryCode(code))

/** IAM-18: 4 to 8 digits. */
export const isPasscodeShape = (passcode: string) => /^\d{4,8}$/.test(passcode)

/** The fifth wrong passcode ends the session (IAM-18). */
export const PASSCODE_ATTEMPTS = 5

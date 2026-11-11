/**
 * The password rule (IAM-03, decision B3/D5): at least 12 characters, any
 * characters allowed, no composition rule and no forced change; refused when
 * it appears in a list of leaked passwords. Pure: the list is passed in.
 */

export const PASSWORD_MIN_LENGTH = 12
/** Above this the hash costs time for nothing; refused as a bad request. */
export const PASSWORD_MAX_LENGTH = 256

export type PasswordProblem = "too_short" | "too_long" | "breached"

/** Characters as a person counts them: code points, so "é" or "😀" count once. */
export function passwordLength(password: string): number {
  return Array.from(password).length
}

/** The form the leak list is compared in: Unicode-normalised, lower case, outer spaces removed. */
export function normalizeForLeakCheck(password: string): string {
  return password.normalize("NFKC").trim().toLowerCase()
}

/** Null when the password may be used, otherwise the reason it may not. */
export function passwordProblem(password: string, isLeaked: (normalized: string) => boolean): PasswordProblem | null {
  const length = passwordLength(password)
  if (length < PASSWORD_MIN_LENGTH) return "too_short"
  if (length > PASSWORD_MAX_LENGTH) return "too_long"
  if (isLeaked(normalizeForLeakCheck(password))) return "breached"
  return null
}

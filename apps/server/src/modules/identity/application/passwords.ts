import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLength, passwordProblem, type PasswordProblem } from "../domain/password-policy"
import type { LeakedPasswordList, PasswordHasher } from "../ports"

/**
 * Choosing and checking passwords (IAM-02, IAM-03). Sign-up, invitation
 * acceptance and reset call `choose`; sign-in calls `check`. Both take their
 * ports, so the application never depends on a hashing library or a file.
 */

export type ChooseResult = { ok: true; hash: string } | { ok: false; problem: PasswordProblem; values: Record<string, number> }

export interface PasswordService {
  /** Applies the rule, then hashes. The values fill the translated error (e.g. `{ min: 12 }`). */
  choose(password: string): Promise<ChooseResult>
  /** Verifies a sign-in; `rehash` is set when the stored hash should be replaced now that the password is known. */
  check(storedHash: string | null, password: string): Promise<{ ok: boolean; rehash?: string }>
}

export function passwordService(deps: { hasher: PasswordHasher; leaked: LeakedPasswordList }): PasswordService {
  const { hasher, leaked } = deps
  /** A valid hash of a random password: verifying against it costs as much as a real one (no timing hint that an account is missing). */
  let decoyHash: Promise<string> | null = null
  return {
    async choose(password): Promise<ChooseResult> {
      const problem = passwordProblem(password, (p) => leaked.has(p))
      if (problem === "too_short") return { ok: false, problem, values: { min: PASSWORD_MIN_LENGTH } }
      if (problem === "too_long") return { ok: false, problem, values: { max: PASSWORD_MAX_LENGTH } }
      if (problem) return { ok: false, problem, values: {} }
      return { ok: true, hash: await hasher.hash(password) }
    },
    async check(storedHash, password) {
      // No account can have a longer password, so the answer reveals nothing; huge inputs are never hashed.
      if (passwordLength(password) > PASSWORD_MAX_LENGTH) return { ok: false }
      if (!storedHash) {
        decoyHash ??= hasher.hash(`decoy:${Math.random()}:${Date.now()}`)
        await hasher.verify(await decoyHash, password)
        return { ok: false }
      }
      const ok = await hasher.verify(storedHash, password)
      if (ok && hasher.needsRehash(storedHash)) return { ok, rehash: await hasher.hash(password) }
      return { ok }
    },
  }
}

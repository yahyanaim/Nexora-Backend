import { hash, verify } from "@node-rs/argon2"
import type { PasswordHasher } from "../ports"

/**
 * Argon2id with the cahier's minimum (IAM-02: memory at least 19 MiB, 2
 * iterations), the OWASP baseline. The settings are stored in the hash, so
 * raising them later makes needsRehash true for older hashes.
 */
// algorithm 2 is Argon2id in the library's (const) enum, which isolated modules cannot read by name.
export const ARGON2_SETTINGS = Object.freeze({ algorithm: 2 as const, memoryCost: 19_456, timeCost: 2, parallelism: 1 })

const CURRENT = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/

export const argon2Hasher: PasswordHasher = {
  hash: (password) => hash(password, ARGON2_SETTINGS),
  async verify(stored, password) {
    if (!stored.startsWith("$argon2")) return false
    try {
      return await verify(stored, password)
    } catch {
      return false // a damaged hash fails the sign-in; it never crashes the request
    }
  },
  needsRehash(stored) {
    const m = CURRENT.exec(stored)
    if (!m) return true
    return Number(m[1]) < ARGON2_SETTINGS.memoryCost || Number(m[2]) < ARGON2_SETTINGS.timeCost
  },
}

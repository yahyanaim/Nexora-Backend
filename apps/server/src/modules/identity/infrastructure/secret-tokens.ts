import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { SecretTokens } from "../ports"

/** 32 random bytes (256 bits, IAM-10), base64url: 43 characters. Stored only as SHA-256. */
export const secretTokens: SecretTokens = {
  generate: () => randomBytes(32).toString("base64url"),
  hash: (token) => createHash("sha256").update(token, "utf8").digest("hex"),
}

/** Compares two hex hashes in constant time (e.g. the CSRF token against the session's). */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex")
  const y = Buffer.from(b, "hex")
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

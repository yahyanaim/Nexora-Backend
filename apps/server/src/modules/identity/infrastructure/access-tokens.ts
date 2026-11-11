import { createHmac, timingSafeEqual } from "node:crypto"
import { REALMS, type Realm } from "../domain/session-limits"
import type { AccessTokens } from "../ports"

/**
 * Access tokens (§8.2 rule 1): `v1.<payload>.<signature>`, the payload being
 * base64url JSON `{ sid, realm, exp }` and the signature an HMAC-SHA256 with the
 * server's SESSION_SECRET. The token says only which session; everything else is
 * read from the database on each request, so revoking a session needs no list
 * of revoked tokens.
 */
export function hmacAccessTokens(secret: string): AccessTokens {
  if (secret.length < 32) throw new Error("the access-token secret must have at least 32 characters")
  const sign = (payload: string) => createHmac("sha256", secret).update(`v1.${payload}`).digest("base64url")
  return {
    issue({ sid, realm, expiresAt }) {
      const payload = Buffer.from(JSON.stringify({ sid, realm, exp: Math.floor(expiresAt.getTime() / 1000) })).toString("base64url")
      return `v1.${payload}.${sign(payload)}`
    },
    read(token, now) {
      const parts = token.split(".")
      if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null
      const expected = Buffer.from(sign(parts[1]))
      const given = Buffer.from(parts[2])
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
      let claims: unknown
      try {
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
      } catch {
        return null
      }
      const c = claims as { sid?: unknown; realm?: unknown; exp?: unknown }
      if (typeof c.sid !== "string" || typeof c.exp !== "number" || !REALMS.includes(c.realm as Realm)) return null
      if (!/^[0-9a-f-]{36}$/.test(c.sid)) return null
      const expiresAt = new Date(c.exp * 1000)
      if (expiresAt.getTime() <= now.getTime()) return null
      return { sid: c.sid, realm: c.realm as Realm, expiresAt }
    },
  }
}

import { describe, expect, it } from "vitest"
import { hmacAccessTokens } from "./access-tokens"

describe("access tokens (§8.2 rule 1)", () => {
  const tokens = hmacAccessTokens("s".repeat(40))
  const now = new Date("2026-11-11T10:00:00Z")
  const sid = "0190f3a2-7c1e-7a00-8000-000000000001"
  const later = (min: number) => new Date(now.getTime() + min * 60_000)

  it("carries the session id and realm, signed, until it expires", () => {
    const t = tokens.issue({ sid, realm: "member", expiresAt: later(15) })
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(tokens.read(t, now)).toEqual({ sid, realm: "member", expiresAt: later(15) })
    expect(tokens.read(t, later(15))).toBeNull()
  })

  it("refuses a token signed with another secret, changed, or malformed", () => {
    const t = tokens.issue({ sid, realm: "member", expiresAt: later(15) })
    expect(hmacAccessTokens("o".repeat(40)).read(t, now)).toBeNull()
    const [v, payload, sig] = t.split(".")
    const other = Buffer.from(JSON.stringify({ sid, realm: "staff", exp: Math.floor(later(15).getTime() / 1000) })).toString("base64url")
    expect(tokens.read(`${v}.${other}.${sig}`, now)).toBeNull() // a realm changed without the key
    expect(tokens.read(`${v}.${payload}`, now)).toBeNull()
    expect(tokens.read("v2." + payload + "." + sig, now)).toBeNull()
    expect(tokens.read("", now)).toBeNull()
    expect(() => hmacAccessTokens("short")).toThrow(/32 characters/)
  })
})

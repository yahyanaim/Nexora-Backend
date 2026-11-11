import { describe, expect, it } from "vitest"
import { normalizeForLeakCheck } from "../domain/password-policy"
import { argon2Hasher } from "./argon2-hasher"
import { leakedPasswords, loadLeakedList } from "./breached-list"
import { sameHash, secretTokens } from "./secret-tokens"

describe("Argon2id hasher (IAM-02)", () => {
  it("hashes with Argon2id at 19 MiB and 2 iterations, and verifies", async () => {
    const h = await argon2Hasher.hash("lune de miel au maroc")
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(await argon2Hasher.verify(h, "lune de miel au maroc")).toBe(true)
    expect(await argon2Hasher.verify(h, "lune de miel au Maroc")).toBe(false)
    expect(argon2Hasher.needsRehash(h)).toBe(false)
  })

  it("gives each hash its own salt", async () => {
    expect(await argon2Hasher.hash("same password twice")).not.toBe(await argon2Hasher.hash("same password twice"))
  })

  it("refuses, without throwing, a damaged hash or another algorithm, and asks to replace weaker hashes", async () => {
    expect(await argon2Hasher.verify("$argon2id$v=19$m=19456,t=2,p=1$broken", "x")).toBe(false)
    expect(await argon2Hasher.verify("$2b$10$abcdefghijklmnopqrstuuvwxyz0123456789ABCDEFGHIJKLMNO", "x")).toBe(false)
    expect(argon2Hasher.needsRehash("$2b$10$abcdefghijklmnopqrstuu")).toBe(true)
    expect(argon2Hasher.needsRehash("$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA")).toBe(true)
    expect(argon2Hasher.needsRehash("$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA")).toBe(false)
  })
})

describe("leaked-password list (IAM-03)", () => {
  it("holds the 46,146 leaked passwords of 12 characters or more, Password1234 among them", () => {
    const list = loadLeakedList()
    expect(list.has(normalizeForLeakCheck("Password1234"))).toBe(true)
    expect(list.has("qwertyuiop123")).toBe(true)
    expect(list.has("lune de miel au maroc")).toBe(false)
    expect(leakedPasswords.has("password1234")).toBe(true)
  })
})

describe("secret tokens (IAM-10)", () => {
  it("makes 256-bit URL-safe tokens, never twice the same", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => secretTokens.generate()))
    expect(tokens.size).toBe(200)
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from([...tokens][0]!, "base64url")).toHaveLength(32)
  })

  it("stores a SHA-256 hash and compares hashes in constant time", () => {
    const t = secretTokens.generate()
    const h = secretTokens.hash(t)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(secretTokens.hash(t))
    expect(sameHash(h, secretTokens.hash(t))).toBe(true)
    expect(sameHash(h, secretTokens.hash(`${t}x`))).toBe(false)
    expect(sameHash(h, "")).toBe(false)
    expect(sameHash("", "")).toBe(false)
  })
})

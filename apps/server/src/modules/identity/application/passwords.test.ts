import { describe, expect, it, vi } from "vitest"
import type { PasswordHasher } from "../ports"
import { passwordService } from "./passwords"

/** A fake hasher that records calls, so the tests stay fast and show what the service does. */
function fakeHasher(overrides: Partial<PasswordHasher> = {}): PasswordHasher & { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> } {
  return {
    hash: vi.fn(async (p: string) => `$argon2id$fake$${p}`),
    verify: vi.fn(async (h: string, p: string) => h === `$argon2id$fake$${p}`),
    needsRehash: vi.fn(() => false),
    ...overrides,
  } as never
}
const leaked = { has: (p: string) => p === "password1234" }

describe("password service (IAM-02, IAM-03)", () => {
  it("refuses a short or leaked password with the values of its message, and hashes nothing", async () => {
    const hasher = fakeHasher()
    const svc = passwordService({ hasher, leaked })
    expect(await svc.choose("short")).toEqual({ ok: false, problem: "too_short", values: { min: 12 } })
    expect(await svc.choose("Password1234")).toEqual({ ok: false, problem: "breached", values: {} })
    expect(await svc.choose("y".repeat(300))).toEqual({ ok: false, problem: "too_long", values: { max: 256 } })
    expect(hasher.hash).not.toHaveBeenCalled()
  })

  it("hashes an accepted password", async () => {
    const svc = passwordService({ hasher: fakeHasher(), leaked })
    expect(await svc.choose("lune de miel au maroc")).toEqual({ ok: true, hash: "$argon2id$fake$lune de miel au maroc" })
  })

  it("verifies a sign-in, and returns a new hash when the old one is weaker", async () => {
    const svc = passwordService({ hasher: fakeHasher({ needsRehash: () => true }), leaked })
    expect(await svc.check("$argon2id$fake$right one here", "right one here")).toEqual({ ok: true, rehash: "$argon2id$fake$right one here" })
    expect(await svc.check("$argon2id$fake$right one here", "wrong")).toEqual({ ok: false })
  })

  it("refuses an over-long password at sign-in without hashing it", async () => {
    const hasher = fakeHasher()
    expect(await passwordService({ hasher, leaked }).check("$argon2id$fake$x", "z".repeat(10_000))).toEqual({ ok: false })
    expect(hasher.verify).not.toHaveBeenCalled()
  })

  it("still runs a full verification for an account without a password, so timing does not tell it apart", async () => {
    const hasher = fakeHasher()
    const svc = passwordService({ hasher, leaked })
    expect(await svc.check(null, "anything at all")).toEqual({ ok: false })
    expect(await svc.check(null, "again")).toEqual({ ok: false })
    expect(hasher.verify).toHaveBeenCalledTimes(2)
    expect(hasher.hash).toHaveBeenCalledTimes(1) // the decoy hash is made once per service
  })
})

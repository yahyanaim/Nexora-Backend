import { describe, expect, it } from "vitest"
import { isPasscodeShape, isRecoveryCodeShape, isStepUpFresh, normalizeRecoveryCode } from "../domain/second-factor"
import { aesGcmBox } from "./secret-box"
import { base32Decode, base32Encode, hotp, totp } from "./totp"

describe("TOTP (RFC 6238, IAM-05)", () => {
  const rfcSecret = Buffer.from("12345678901234567890", "ascii")

  it("matches the RFC 6238 test vectors (SHA-1, 8 digits)", () => {
    const at = (seconds: number) => hotp(rfcSecret, Math.floor(seconds / 30), 8)
    expect(at(59)).toBe("94287082")
    expect(at(1111111109)).toBe("07081804")
    expect(at(1111111111)).toBe("14050471")
    expect(at(1234567890)).toBe("89005924")
    expect(at(2000000000)).toBe("69279037")
  })

  it("round-trips base32 and makes 160-bit secrets", () => {
    expect(base32Encode(rfcSecret)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")).toEqual(rfcSecret)
    const secret = totp.newSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(totp.newSecret()).not.toBe(secret)
  })

  it("accepts the code of this step and its neighbours once, never a step already used", () => {
    const secret = totp.newSecret()
    const now = new Date("2026-11-11T10:00:10Z")
    const step = Math.floor(now.getTime() / 30_000)
    const code = (s: number) => hotp(base32Decode(secret), s)
    expect(totp.check(secret, code(step), now, 0)).toBe(step)
    expect(totp.check(secret, code(step - 1), now, 0)).toBe(step - 1)
    expect(totp.check(secret, code(step + 1), now, 0)).toBe(step + 1)
    expect(totp.check(secret, code(step - 2), now, 0)).toBeNull()
    expect(totp.check(secret, code(step), now, step)).toBeNull() // replay
    expect(totp.check(secret, "12345", now, 0)).toBeNull()
    expect(totp.check(secret, "abcdef", now, 0)).toBeNull()
  })

  it("writes an otpauth address the authenticator apps read", () => {
    expect(totp.otpauthUrl("ABC", "lina@atlas.ma")).toBe("otpauth://totp/Nexora%3Alina%40atlas.ma?secret=ABC&issuer=Nexora&algorithm=SHA1&digits=6&period=30")
  })
})

describe("secret box (SCR-07)", () => {
  it("seals with a fresh nonce, opens with the same key and purpose only, and detects tampering", () => {
    const box = aesGcmBox("k".repeat(40), "second-factor")
    const a = box.seal("JBSWY3DPEHPK3PXP")
    const b = box.seal("JBSWY3DPEHPK3PXP")
    expect(a).not.toBe(b)
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(a).not.toContain("JBSWY3DPEHPK3PXP")
    expect(box.open(a)).toBe("JBSWY3DPEHPK3PXP")
    expect(() => aesGcmBox("k".repeat(40), "other").open(a)).toThrow()
    expect(() => aesGcmBox("j".repeat(40), "second-factor").open(a)).toThrow()
    const parts = a.split(".")
    parts[2] = Buffer.from("tampered!").toString("base64url")
    expect(() => box.open(parts.join("."))).toThrow()
  })
})

describe("second-factor rules (IAM-06, IAM-18)", () => {
  it("counts a factor as fresh for 5 minutes only", () => {
    const now = new Date("2026-11-11T10:00:00Z")
    expect(isStepUpFresh(new Date(now.getTime() - 4 * 60_000), now)).toBe(true)
    expect(isStepUpFresh(new Date(now.getTime() - 5 * 60_000), now)).toBe(false)
    expect(isStepUpFresh(null, now)).toBe(false)
    expect(isStepUpFresh(new Date(now.getTime() + 60_000), now)).toBe(false)
  })

  it("takes 4 to 8 digits as a passcode and recovery codes as typed", () => {
    for (const p of ["1234", "12345678"]) expect(isPasscodeShape(p)).toBe(true)
    for (const p of ["123", "123456789", "12a4", ""]) expect(isPasscodeShape(p)).toBe(false)
    expect(normalizeRecoveryCode(" ABCDE-fgh2k ")).toBe("abcdefgh2k")
    expect(isRecoveryCodeShape("abcde-fgh2k")).toBe(true)
    expect(isRecoveryCodeShape("123456")).toBe(false)
  })
})

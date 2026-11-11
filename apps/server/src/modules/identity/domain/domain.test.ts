import { describe, expect, it } from "vitest"
import { afterFailedAttempt, afterSuccess, isLocked, LOCK_MINUTES, type LockState, MAX_FAILED_ATTEMPTS } from "./lockout"
import { normalizeForLeakCheck, passwordLength, passwordProblem } from "./password-policy"
import { isSessionExpired, memberLimits, SESSION_LIMITS, sessionEndsAt } from "./session-limits"
import { TOKEN_LIFETIME_MS, tokenExpiresAt } from "./sign-in-tokens"

const never = () => false

describe("password rule (IAM-03)", () => {
  it("refuses 11 characters and accepts a 12-character passphrase, with no composition rule", () => {
    expect(passwordProblem("abcdefghijk", never)).toBe("too_short")
    expect(passwordProblem("lune de miel", never)).toBeNull()
    expect(passwordProblem("aaaaaaaaaaaa", never)).toBeNull() // no "must contain a digit" rule
  })

  it("counts characters as a person does, so accents and emoji count once", () => {
    expect(passwordLength("é".normalize("NFD"))).toBe(2) // a decomposed é is two code points, like a keyboard would type it
    expect(passwordLength("😀😀😀😀😀😀😀😀😀😀😀")).toBe(11)
    expect(passwordProblem("😀😀😀😀😀😀😀😀😀😀😀", never)).toBe("too_short")
    expect(passwordProblem("مرحبا بكم في نكسورا", never)).toBeNull()
  })

  it("refuses an over-long password", () => {
    expect(passwordProblem("x".repeat(257), never)).toBe("too_long")
    expect(passwordProblem("x".repeat(256), never)).toBeNull()
  })

  it("checks the leak list in normalised form", () => {
    const leaked = new Set(["password1234"])
    expect(passwordProblem("Password1234", (p) => leaked.has(p))).toBe("breached")
    expect(passwordProblem("  PASSWORD1234 ", (p) => leaked.has(p))).toBe("breached")
    expect(normalizeForLeakCheck("Ｐａｓｓ")).toBe("pass") // full-width letters fold to ASCII (NFKC)
  })
})

describe("lockout (IAM-04)", () => {
  const now = new Date("2026-11-11T10:00:00Z")
  const later = (min: number) => new Date(now.getTime() + min * 60_000)

  it("locks for 15 minutes on the fifth failure, not before", () => {
    let s = afterSuccess()
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      s = afterFailedAttempt(s, now)
      expect(isLocked(s, now)).toBe(false)
    }
    s = afterFailedAttempt(s, now)
    expect(s.failedAttempts).toBe(5)
    expect(isLocked(s, now)).toBe(true)
    expect(isLocked(s, later(LOCK_MINUTES - 1))).toBe(true)
    expect(isLocked(s, later(LOCK_MINUTES))).toBe(false)
  })

  it("starts counting again after the lock has run out, and after a success", () => {
    let s: LockState = { failedAttempts: 5, lockedUntil: later(15) }
    s = afterFailedAttempt(s, later(16))
    expect(s).toEqual({ failedAttempts: 1, lockedUntil: null, lastFailureAt: later(16) })
    expect(afterSuccess()).toEqual({ failedAttempts: 0, lockedUntil: null, lastFailureAt: null })
  })

  it("forgets failures more than 15 minutes old, so four mistakes last week and one today do not lock", () => {
    const old: LockState = { failedAttempts: 4, lockedUntil: null, lastFailureAt: later(-60 * 24 * 7) }
    expect(afterFailedAttempt(old, now)).toEqual({ failedAttempts: 1, lockedUntil: null, lastFailureAt: now })
    const recent: LockState = { failedAttempts: 4, lockedUntil: null, lastFailureAt: later(-10) }
    expect(isLocked(afterFailedAttempt(recent, now), now)).toBe(true)
  })
})

describe("session limits (Table 6, IAM-07)", () => {
  const created = new Date("2026-11-11T08:00:00Z")
  const at = (h: number, m = 0) => new Date(created.getTime() + h * 3_600_000 + m * 60_000)

  it("ends a member session after 30 idle minutes, a staff session after 15, a portal one after 2 hours", () => {
    expect(isSessionExpired("member", { createdAt: created, lastActivityAt: created }, at(0, 29))).toBe(false)
    expect(isSessionExpired("member", { createdAt: created, lastActivityAt: created }, at(0, 31))).toBe(true)
    expect(isSessionExpired("staff", { createdAt: created, lastActivityAt: created }, at(0, 16))).toBe(true)
    expect(isSessionExpired("portal", { createdAt: created, lastActivityAt: created }, at(1, 59))).toBe(false)
  })

  it("ends every session at its absolute limit, however active", () => {
    expect(sessionEndsAt("member", { createdAt: created, lastActivityAt: at(11, 50) })).toEqual(at(12))
    expect(sessionEndsAt("staff", { createdAt: created, lastActivityAt: at(7, 59) })).toEqual(at(8))
    expect(SESSION_LIMITS.portal.absoluteHours).toBe(168)
  })

  it("lets a workspace shorten the member limits, never lengthen them", () => {
    expect(memberLimits({ idleMinutes: 10 })).toEqual({ idleMinutes: 10, absoluteHours: 12 })
    expect(memberLimits({ idleMinutes: 90, absoluteHours: 48 })).toEqual({ idleMinutes: 30, absoluteHours: 12 })
    expect(memberLimits({ idleMinutes: 0, absoluteHours: 2.5 })).toEqual({ idleMinutes: 30, absoluteHours: 12 })
    expect(() => {
      ;(SESSION_LIMITS as { member: unknown }).member = { idleMinutes: 999, absoluteHours: 999 }
    }).toThrow()
  })
})

describe("single-use token lifetimes (IAM-10)", () => {
  it("gives each purpose its lifetime", () => {
    const t = new Date("2026-11-11T00:00:00Z")
    expect(tokenExpiresAt("portal_link", t).getTime() - t.getTime()).toBe(15 * 60_000)
    expect(tokenExpiresAt("reset", t).getTime() - t.getTime()).toBe(24 * 3_600_000)
    expect(tokenExpiresAt("invite", t).getTime() - t.getTime()).toBe(7 * 24 * 3_600_000)
    expect(TOKEN_LIFETIME_MS.staff_invite).toBe(72 * 3_600_000)
  })
})

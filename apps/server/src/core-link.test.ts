import { describe, expect, it } from "vitest"
import { roundMoney, toCents } from "@nexora/core/lib/workforce/money"
import { ERROR_KEYS } from "@nexora/core/lib/errors/error-catalog"

describe("the server uses the shared rules (ARC-03)", () => {
  it("rounds money with the web application's half-up rule", () => {
    expect(roundMoney(2.675)).toBe(2.68)
    expect(toCents(19.99)).toBe(1999)
  })

  it("knows the server error keys of Annex F", () => {
    const keys = new Set(Object.values(ERROR_KEYS))
    for (const key of ["err_stepUpRequired", "err_workspaceReadOnly", "err_idempotencyMismatch", "err_internal", "err_conflict", "err_csrf"]) {
      expect(keys.has(key)).toBe(true)
    }
  })
})

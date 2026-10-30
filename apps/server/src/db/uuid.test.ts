import { describe, expect, it } from "vitest"
import { uuidv7 } from "./uuid"

describe("uuidv7 (DAT-03)", () => {
  it("is a version 7 UUID with the RFC variant", () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it("increases for ids made one after the other, even in the same millisecond", () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7(1_793_000_000_000))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("carries the time in its first 48 bits", () => {
    const id = uuidv7(1_793_311_473_779)
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBeGreaterThanOrEqual(1_793_311_473_779)
  })
})

// Hand-written test of the package's own id helper.
import { describe, expect, it } from "vitest"
import { createId } from "./id"

describe("createId", () => {
  it("prefixes a full UUID without dashes, and never repeats", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createId("cli")))
    expect(ids.size).toBe(1000)
    for (const id of ids) expect(id).toMatch(/^cli_[0-9a-f]{32}$/)
  })
})

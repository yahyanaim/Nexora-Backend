import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ERROR_KEYS } from "@nexora/core/lib/errors/error-catalog"

/** Every error code the server sends is a key of the web application's catalogue (ARC-08). */
describe("error codes (ARC-08)", () => {
  it("finds every err_ code of the server's source in the catalogue", () => {
    const catalogue = new Set(Object.values(ERROR_KEYS))
    const files = fs.readdirSync(path.join(__dirname), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    const codes = new Set(files.flatMap((f) => [...fs.readFileSync(path.join(__dirname, f), "utf8").matchAll(/["'](err_[A-Za-z0-9]+)["']/g)].map((m) => m[1]!)))
    expect(codes.size).toBeGreaterThan(0)
    expect([...codes].filter((c) => !catalogue.has(c))).toEqual([])
  })
})

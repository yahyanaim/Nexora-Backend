import pino from "pino"
import { describe, expect, it } from "vitest"
import { loggerOptions } from "./logging"

describe("log redaction (security plan G-6)", () => {
  it("removes cookies, credentials and the personal data of a database error", () => {
    const lines: string[] = []
    const logger = pino(loggerOptions("info", "test"), { write: (l: string) => void lines.push(l) })
    const dbError = Object.assign(new Error("duplicate key value violates unique constraint"), { detail: "Key (email)=(lina@atlas.ma) already exists.", code: "23505" })
    logger.error({ err: dbError, req: { headers: { cookie: "nx_m=v1.secret", authorization: "Bearer abc", "x-xsrf-token": "tok" } }, password: "hunter2hunter2" }, "failed")
    const out = lines.join("")
    for (const secret of ["lina@atlas.ma", "v1.secret", "Bearer abc", '"tok"', "hunter2hunter2"]) expect(out).not.toContain(secret)
    expect(out).toContain("23505") // the error code stays, so the failure can still be diagnosed
  })
})

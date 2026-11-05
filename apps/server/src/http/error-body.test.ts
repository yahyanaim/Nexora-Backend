import express from "express"
import pino from "pino"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../config/config"
import { createApp } from "./app"
import { errorBodySchema, errorHandler } from "./error-body"
import { AppError } from "./errors"

const silent = pino({ level: "silent" })

/**
 * Contract test of the error body (ARC-13, decision E1). The web application
 * tests its translation with the same example body (translate-error.test.ts
 * in Nexora-Saas), so a change on either side breaks a test.
 */
describe("error body contract (ARC-08, ARC-13)", () => {
  const app = createApp({ config: loadConfig({ NODE_ENV: "test" }), logger: silent })

  it("matches the contract on every error path of the application, with the request id of the header", async () => {
    const responses = [
      await request(app).get("/nowhere"),
      await request(app).post("/nowhere").set("content-type", "application/json").send("{oops"),
      await request(app).post("/nowhere").set("content-type", "application/json").send(JSON.stringify({ big: "x".repeat(1_100_000) })),
    ]
    expect(responses.map((r) => r.status)).toEqual([404, 400, 413])
    for (const r of responses) {
      expect(errorBodySchema.safeParse(r.body).success).toBe(true)
      expect(r.body.requestId).toBe(r.headers["x-request-id"])
    }
  })

  it("carries the values of an AppError and hides any other error behind err_internal", async () => {
    const probe = express()
    probe.use((req, _res, next) => { req.id = "req-probe"; next() })
    probe.get("/too-big", () => { throw new AppError(413, "err_fileTooLarge", { maxMb: 10 }) })
    probe.get("/field", () => { throw new AppError(422, "err_customFieldRequired", { name: "Budget", field: "budget" }) })
    probe.get("/crash", () => { throw new Error("SELECT secret FROM somewhere failed") })
    probe.use(errorHandler(silent))
    expect((await request(probe).get("/too-big")).body).toEqual({ code: "err_fileTooLarge", values: { maxMb: 10 }, requestId: "req-probe" })
    expect((await request(probe).get("/field")).body).toEqual({ code: "err_customFieldRequired", values: { name: "Budget", field: "budget" }, requestId: "req-probe" })
    const crash = await request(probe).get("/crash")
    expect(crash.status).toBe(500)
    expect(crash.body).toEqual({ code: "err_internal", values: {}, requestId: "req-probe" })
    expect(JSON.stringify(crash.body)).not.toMatch(/SELECT|secret/)
  })

  it("refuses bodies that drift from the contract", () => {
    expect(errorBodySchema.safeParse({ code: "err_notFound", values: {}, requestId: "r" }).success).toBe(true)
    expect(errorBodySchema.safeParse({ code: "err_notFound", values: {}, requestId: "r", message: "Not found" }).success).toBe(true)
    expect(errorBodySchema.safeParse({ code: "err_notFound", details: {}, requestId: "r" }).success).toBe(false) // old shape
    expect(errorBodySchema.safeParse({ code: "Not found", values: {}, requestId: "r" }).success).toBe(false) // a sentence
    expect(errorBodySchema.safeParse({ code: "err_x", values: { nested: { a: 1 } }, requestId: "r" }).success).toBe(false)
  })
})

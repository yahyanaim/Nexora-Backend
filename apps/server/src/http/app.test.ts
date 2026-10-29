import pino from "pino"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../config/config"
import { createApp } from "./app"

const logger = pino({ level: "silent" })
const app = (readiness?: Array<() => Promise<void>>) => createApp({ config: loadConfig({ NODE_ENV: "test" }), logger, readiness })

describe("HTTP application", () => {
  it("answers liveness and readiness", async () => {
    await request(app()).get("/health/live").expect(200, { status: "ok" })
    await request(app()).get("/health/ready").expect(200, { status: "ok" })
  })

  it("is not ready when a check fails (QAL-05)", async () => {
    const res = await request(app([async () => Promise.reject(new Error("database down"))])).get("/health/ready")
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: "unavailable" })
    expect(JSON.stringify(res.body)).not.toContain("database")
  })

  it("gives every response a request id and keeps a well-formed incoming one", async () => {
    const fresh = await request(app()).get("/health/live")
    expect(fresh.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/)
    const kept = await request(app()).get("/health/live").set("x-request-id", "abc-12345678")
    expect(kept.headers["x-request-id"]).toBe("abc-12345678")
    const replaced = await request(app()).get("/health/live").set("x-request-id", "<script>")
    expect(replaced.headers["x-request-id"]).not.toBe("<script>")
  })

  it("sends security headers and hides the framework", async () => {
    const res = await request(app()).get("/health/live")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["x-frame-options"]).toBe("DENY")
    expect(res.headers["strict-transport-security"]).toContain("max-age=")
    expect(res.headers["x-powered-by"]).toBeUndefined()
  })

  it("returns errors as codes with the request id, never a stack (SCR-04)", async () => {
    const missing = await request(app()).get("/nope")
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ code: "err_notFound", values: {}, requestId: missing.headers["x-request-id"] })

    const bad = await request(app()).post("/nope").set("content-type", "application/json").send("{bad")
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe("err_badRequest")

    const big = await request(app()).post("/nope").set("content-type", "application/json").send(JSON.stringify({ x: "a".repeat(1_100_000) }))
    expect(big.status).toBe(413)
    expect(big.text).not.toMatch(/at |Error/)
  })
})

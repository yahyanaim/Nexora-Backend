import { describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "./config"

const strong = "k3J9vQ2mX7pL1zR8tW4yB6nC0dF5hG2s"
const db = "postgresql://nx_web@db.internal:5432/nexora"

describe("configuration (ARC-04)", () => {
  it("starts in development with defaults and no secret", () => {
    const config = loadConfig({})
    expect(config.NODE_ENV).toBe("development")
    expect(config.PORT).toBe(4000)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it("refuses to start production without a session secret", () => {
    expect(() => loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma" })).toThrow(/SESSION_SECRET is required/)
  })

  it("refuses a short or example secret in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: "short" })).toThrow(/at least 32/)
    expect(() => loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: `changeme${strong}` })).toThrow(/example value/)
  })

  it("refuses a plain-http origin in production and lists every problem at once", () => {
    try {
      loadConfig({ NODE_ENV: "production", APP_ORIGIN: "http://app.nexora.ma", PORT: "0" })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      expect((e as ConfigError).problems.length).toBeGreaterThanOrEqual(2)
    }
  })

  it("accepts a correct production configuration", () => {
    const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: strong, PORT: "8080", DATABASE_URL: db })
    expect(config.PORT).toBe(8080)
    expect(config.DATABASE_POOL_MAX).toBe(10)
  })

  it("needs a database in production and checks the URL shape", () => {
    expect(() => loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: strong })).toThrow(/DATABASE_URL is required/)
    expect(() => loadConfig({ DATABASE_URL: "mysql://x" })).toThrow(/postgres:\/\//)
    expect(() => loadConfig({ DATABASE_POOL_MAX: "50" })).toThrow()
  })
})

import { describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "./config"

const strong = "k3J9vQ2mX7pL1zR8tW4yB6nC0dF5hG2s"

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
    const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: strong, PORT: "8080" })
    expect(config.PORT).toBe(8080)
  })
})

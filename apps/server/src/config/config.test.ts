import { describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "./config"

const strong = "k3J9vQ2mX7pL1zR8tW4yB6nC0dF5hG2s"
const key = "Z8pQ4vN1sT7wK2mB9xR5cJ3hL6yF0dG4"
const db = "postgresql://nx_web@db.internal:5432/nexora?sslmode=verify-full"

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
    const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: strong, ENCRYPTION_KEY: key, PORT: "8080", DATABASE_URL: db })
    expect(config.PORT).toBe(8080)
    expect(config.DATABASE_POOL_MAX).toBe(10)
  })

  it("needs a database in production and checks the URL shape", () => {
    expect(() => loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: strong })).toThrow(/DATABASE_URL is required/)
    expect(() => loadConfig({ DATABASE_URL: "mysql://x" })).toThrow(/postgres:\/\//)
    expect(() => loadConfig({ DATABASE_POOL_MAX: "50" })).toThrow()
  })

  it("requires a verified TLS connection to the database in production (SCR-01, security plan G-5)", () => {
    const prod = { NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: strong, ENCRYPTION_KEY: key }
    expect(() => loadConfig({ ...prod, DATABASE_URL: "postgresql://nx_web@db.internal:5432/nexora" })).toThrow(/sslmode=verify-full/)
    expect(() => loadConfig({ ...prod, DATABASE_URL: "postgresql://nx_web@db.internal:5432/nexora?sslmode=require" })).toThrow(/sslmode=verify-full/)
    expect(loadConfig({ ...prod, DATABASE_URL: "postgresql://nx_web@db/nexora?application_name=x&sslmode=verify-full" }).DATABASE_URL).toContain("verify-full")
    expect(loadConfig({ DATABASE_URL: "postgresql://localhost/nexora" }).DATABASE_URL).toBeDefined() // development may use a local socket
  })

  it("needs its own encryption key for stored secrets in production (SCR-07)", () => {
    const prod = { NODE_ENV: "production", APP_ORIGIN: "https://app.nexora.ma", SESSION_SECRET: strong, DATABASE_URL: db }
    expect(() => loadConfig(prod)).toThrow(/ENCRYPTION_KEY is required/)
    expect(() => loadConfig({ ...prod, ENCRYPTION_KEY: strong })).toThrow(/must differ from SESSION_SECRET/)
    expect(loadConfig({ ...prod, ENCRYPTION_KEY: key }).ENCRYPTION_KEY).toBe(key)
  })

  it("reads the proxy hops and the cookie path from the environment (security plan G-7)", () => {
    expect(loadConfig({}).TRUST_PROXY_HOPS).toBe(1)
    expect(loadConfig({}).COOKIE_PATH_PREFIX).toBe("/api")
    expect(loadConfig({ TRUST_PROXY_HOPS: "2", COOKIE_PATH_PREFIX: "" })).toMatchObject({ TRUST_PROXY_HOPS: 2, COOKIE_PATH_PREFIX: "" })
    expect(() => loadConfig({ TRUST_PROXY_HOPS: "9" })).toThrow()
    expect(() => loadConfig({ COOKIE_PATH_PREFIX: "api/" })).toThrow(/COOKIE_PATH_PREFIX/)
  })
})

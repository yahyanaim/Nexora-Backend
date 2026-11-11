import pino from "pino"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../config/config"
import { ADMIN_URL, createTestDb, type TestDb } from "../db/testing/test-db"
import { uuidv7 } from "../db/uuid"
import { createIdentity } from "../modules/identity/infrastructure/index"
import { argon2Hasher } from "../modules/identity/infrastructure/argon2-hasher"
import { createApp } from "./app"
import { errorBodySchema } from "./error-body"

/**
 * Member sign-in, refresh, sign-out and the session check end to end on real
 * PostgreSQL (B1b step 2; IAM-01, IAM-04, IAM-07, IAM-08, IAM-16, SCR-16).
 */
describe.skipIf(!ADMIN_URL)("member sign-in and sessions (B1b step 2)", () => {
  const ORIGIN = "https://app.nexora.ma"
  const PASSWORD = "lune de miel au maroc"
  let db: TestDb
  let app: ReturnType<typeof createApp>
  let hash: string
  const lines: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    db = await createTestDb()
    hash = await argon2Hasher.hash(PASSWORD)
    const config = loadConfig({ APP_ORIGIN: ORIGIN, COOKIE_PATH_PREFIX: "/api" })
    const logger = pino({ level: "info" }, { write: (l: string) => void lines.push(JSON.parse(l)) })
    app = createApp({ config, logger, auth: createIdentity({ pool: db.web, sessionSecret: "x".repeat(40) }).auth })
  }, 60_000)
  afterAll(async () => db?.drop())
  beforeEach(async () => {
    await db.admin.query("DELETE FROM ops.rate_limits; DELETE FROM identity.sign_in_failures")
    lines.length = 0
  })

  async function member(opts: { status?: string; hash?: string } = {}) {
    const id = uuidv7()
    const email = `m-${id.slice(-12)}@atlas.ma`
    await db.admin.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', $2, 'Lina')", [id, `user:${id}`])
    await db.admin.query("INSERT INTO identity.users (id, email, name, status, password_hash) VALUES ($1, $2, 'Lina Alaoui', $3, $4)", [id, email, opts.status ?? "active", opts.hash ?? hash])
    return { id, email }
  }
  const login = (email: string, password = PASSWORD, origin: string | null = ORIGIN) => {
    const r = request(app).post("/app/v1/auth/login").send({ email, password })
    return origin ? r.set("Origin", origin) : r
  }
  /** The cookies a response sets, by name, with their attributes. */
  function cookies(res: request.Response) {
    const out: Record<string, { value: string; attrs: string }> = {}
    for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
      const [pair, ...attrs] = c.split(";")
      const eq = pair!.indexOf("=")
      out[pair!.slice(0, eq)] = { value: decodeURIComponent(pair!.slice(eq + 1)), attrs: attrs.join(";").trim() }
    }
    return out
  }
  const cookieHeader = (c: Record<string, { value: string }>, ...names: string[]) => names.map((n) => `${n}=${encodeURIComponent(c[n]!.value)}`).join("; ")
  async function signedIn() {
    const m = await member()
    const res = await login(m.email)
    expect(res.status).toBe(200)
    return { ...m, c: cookies(res) }
  }

  it("signs a member in: realm cookies with the right scope, the user, a session and an audit event", async () => {
    const m = await member()
    const res = await login(m.email.toUpperCase())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ user: { id: m.id, email: m.email, name: "Lina Alaoui", locale: "fr" } })
    const c = cookies(res)
    expect(c.nx_m!.attrs).toMatch(/Path=\/api\/app;.*HttpOnly.*SameSite=Lax/)
    expect(c.nx_m_r!.attrs).toMatch(/Path=\/api\/app\/v1\/auth;.*HttpOnly/)
    expect(c["XSRF-TOKEN"]!.attrs).toMatch(/Path=\//)
    expect(c["XSRF-TOKEN"]!.attrs).not.toMatch(/HttpOnly/)
    expect(c["XSRF-TOKEN"]!.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const { rows } = await db.admin.query("SELECT realm, revoked_at FROM identity.sessions WHERE principal_id = $1", [m.id])
    expect(rows).toEqual([{ realm: "member", revoked_at: null }])
    const events = await db.admin.query("SELECT action FROM audit.identity_events WHERE principal_id = $1", [m.id])
    expect(events.rows.map((r) => r.action)).toEqual(["sign_in.succeeded"])
  })

  it("answers a wrong password and an unknown e-mail the same way (IAM-04)", async () => {
    const m = await member()
    const wrong = await login(m.email, "not the password at all")
    const unknown = await login("nobody-here@atlas.ma")
    const malformed = await request(app).post("/app/v1/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: PASSWORD, role: "owner" })
    for (const r of [wrong, unknown, malformed]) {
      expect(r.status).toBe(401)
      expect(errorBodySchema.parse(r.body).code).toBe("err_invalidCredentials")
      expect(r.headers["set-cookie"]).toBeUndefined()
    }
    const { rows } = await db.admin.query("SELECT action, principal_id IS NULL AS anonymous, email_hash IS NOT NULL AS hashed FROM audit.identity_events WHERE action = 'sign_in.failed' ORDER BY at")
    expect(rows).toEqual(expect.arrayContaining([{ action: "sign_in.failed", anonymous: false, hashed: false }, { action: "sign_in.failed", anonymous: true, hashed: true }]))
  })

  it("refuses an invited or disabled account like a wrong password", async () => {
    for (const status of ["invited", "disabled"]) {
      const m = await member({ status })
      expect((await login(m.email)).body.code).toBe("err_invalidCredentials")
    }
  })

  it("locks after 5 failures, even with the right password next, and does the same for an unknown e-mail (IAM-04)", async () => {
    const m = await member()
    for (let i = 0; i < 5; i++) expect((await login(m.email, `wrong ${i} password`)).status).toBe(401)
    const locked = await login(m.email)
    expect(locked.status).toBe(429)
    expect(locked.body.code).toBe("err_tooManyRequests")
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0)
    const { rows } = await db.admin.query("SELECT failed_attempts, locked_until > now() AS locked FROM identity.users WHERE id = $1", [m.id])
    expect(rows[0]).toEqual({ failed_attempts: 5, locked: true })

    for (let i = 0; i < 5; i++) await login("ghost@atlas.ma", `wrong ${i} password`)
    expect((await login("ghost@atlas.ma")).status).toBe(429)
  })

  it("keeps answering a locked existing account and a locked unknown e-mail alike, whatever the counters' windows (IAM-04)", async () => {
    const m = await member()
    for (let i = 0; i < 5; i++) {
      await login(m.email, `wrong ${i} password`)
      await login("ghost-2@atlas.ma", `wrong ${i} password`)
    }
    await db.admin.query("DELETE FROM ops.rate_limits") // a window of the address counter ends
    const [known, unknown] = [await login(m.email), await login("ghost-2@atlas.ma")]
    expect([known.status, unknown.status]).toEqual([429, 429])
    expect(Math.abs(Number(known.headers["retry-after"]) - Number(unknown.headers["retry-after"]))).toBeLessThanOrEqual(2)

    await db.admin.query("UPDATE identity.sign_in_failures SET locked_until = now() - interval '1 second'") // the 15 minutes pass
    expect((await login(m.email)).status).toBe(200)
    expect((await login("ghost-2@atlas.ma")).status).toBe(401)
    const { rows } = await db.admin.query("SELECT email_hash FROM identity.sign_in_failures")
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.email_hash))).toBe(true) // no e-mail in clear
  })

  it("limits failures from one address across e-mails", async () => {
    for (let i = 0; i < 10; i++) await login(`spray-${i}@atlas.ma`, "wrong password!!")
    const m = await member()
    expect((await login(m.email)).status).toBe(429)
  })

  it("refuses a sign-in posted from another origin, or without one (SCR-16)", async () => {
    const m = await member()
    expect((await login(m.email, PASSWORD, "https://evil.example")).body.code).toBe("err_csrf")
    expect((await login(m.email, PASSWORD, null)).status).toBe(403)
  })

  it("answers me from the session, and 401 without one or with a forged token", async () => {
    const s = await signedIn()
    const me = await request(app).get("/app/v1/auth/me").set("Cookie", cookieHeader(s.c, "nx_m"))
    expect(me.status).toBe(200)
    expect(me.body.user.id).toBe(s.id)
    expect((await request(app).get("/app/v1/auth/me")).body.code).toBe("err_sessionEnded")
    const forged = s.c.nx_m!.value.replace(/\.[^.]+$/, ".AAAA")
    expect((await request(app).get("/app/v1/auth/me").set("Cookie", `nx_m=${forged}`)).status).toBe(401)
  })

  it("stops a disabled account and an expired session at the next request (IAM-07, IAM-08)", async () => {
    const a = await signedIn()
    await db.admin.query("UPDATE identity.users SET status = 'disabled' WHERE id = $1", [a.id])
    expect((await request(app).get("/app/v1/auth/me").set("Cookie", cookieHeader(a.c, "nx_m"))).status).toBe(401)

    const b = await signedIn()
    await db.admin.query("UPDATE identity.sessions SET idle_expires_at = now() - interval '1 second' WHERE principal_id = $1", [b.id])
    expect((await request(app).get("/app/v1/auth/me").set("Cookie", cookieHeader(b.c, "nx_m"))).status).toBe(401)
  })

  it("signs out only with the XSRF header, then the session is gone (SCR-16)", async () => {
    const s = await signedIn()
    const out = () => request(app).post("/app/v1/auth/logout").set("Origin", ORIGIN).set("Cookie", cookieHeader(s.c, "nx_m"))
    expect((await out()).body.code).toBe("err_csrf")
    expect((await out().set("X-XSRF-TOKEN", "a".repeat(43))).status).toBe(403)
    const ok = await out().set("X-XSRF-TOKEN", s.c["XSRF-TOKEN"]!.value)
    expect(ok.status).toBe(204)
    expect(cookies(ok).nx_m!.attrs).toMatch(/Expires=Thu, 01 Jan 1970/)
    expect((await request(app).get("/app/v1/auth/me").set("Cookie", cookieHeader(s.c, "nx_m"))).status).toBe(401)
  })

  it("rotates the refresh token, and ends the session when a used one comes back (IAM-07)", async () => {
    const s = await signedIn()
    const refresh = (c: Record<string, { value: string }>) => request(app).post("/app/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieHeader(c, "nx_m_r"))
    const first = await refresh(s.c)
    expect(first.status).toBe(200)
    const next = cookies(first)
    expect(next.nx_m_r!.value).not.toBe(s.c.nx_m_r!.value)
    expect(next["XSRF-TOKEN"]).toBeUndefined() // the double-submit value stays the one of sign-in
    expect((await request(app).get("/app/v1/auth/me").set("Cookie", cookieHeader(next, "nx_m"))).status).toBe(200)

    const replay = await refresh(s.c) // the old token, as a thief would
    expect(replay.status).toBe(401)
    expect((await request(app).get("/app/v1/auth/me").set("Cookie", cookieHeader(next, "nx_m"))).status).toBe(401)
    expect((await refresh(next)).status).toBe(401) // the newest token died with the session
    const { rows } = await db.admin.query("SELECT revoked_reason FROM identity.sessions WHERE principal_id = $1", [s.id])
    expect(rows).toEqual([{ revoked_reason: "refresh_reuse" }])
    const events = await db.admin.query("SELECT action FROM audit.identity_events WHERE principal_id = $1 ORDER BY at, action", [s.id])
    expect(events.rows.map((r) => r.action)).toContain("session.refresh_reused")
  })

  it("lets only one of two refreshes made at the same moment with the same token succeed", async () => {
    const s = await signedIn()
    const refresh = () => request(app).post("/app/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieHeader(s.c, "nx_m_r"))
    const statuses = (await Promise.all([refresh(), refresh()])).map((r) => r.status).sort()
    expect(statuses).toEqual([200, 401])
  })

  it("records the sign-out in the identity trail", async () => {
    const s = await signedIn()
    await request(app).post("/app/v1/auth/logout").set("Origin", ORIGIN).set("Cookie", cookieHeader(s.c, "nx_m")).set("X-XSRF-TOKEN", s.c["XSRF-TOKEN"]!.value)
    const { rows } = await db.admin.query("SELECT action FROM audit.identity_events WHERE principal_id = $1 ORDER BY at", [s.id])
    expect(rows.map((r) => r.action)).toEqual(["sign_in.succeeded", "session.signed_out"])
  })

  it("re-hashes a weaker stored hash at the next sign-in (IAM-02)", async () => {
    const weak = await import("@node-rs/argon2").then((a) => a.hash(PASSWORD, { algorithm: 2, memoryCost: 8192, timeCost: 1 }))
    const m = await member({ hash: weak })
    expect((await login(m.email)).status).toBe(200)
    const { rows } = await db.admin.query("SELECT password_hash FROM identity.users WHERE id = $1", [m.id])
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  })

  it("logs one line per request with the principal, and never a cookie, token or password (QAL-07, G-6)", async () => {
    const s = await signedIn()
    await request(app).get("/app/v1/auth/me?probe=1").set("Cookie", cookieHeader(s.c, "nx_m"))
    const line = lines.find((l) => l.msg === "request" && l.path === "/app/v1/auth/me")
    expect(line).toMatchObject({ method: "GET", status: 200, principalId: s.id, realm: "member" })
    const all = JSON.stringify(lines)
    expect(all).not.toContain(s.c.nx_m!.value)
    expect(all).not.toContain(PASSWORD)
    expect(all).not.toContain("probe=1")
  })
})

import pino from "pino"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../config/config"
import { ADMIN_URL, createTestDb, type TestDb } from "../db/testing/test-db"
import { uuidv7 } from "../db/uuid"
import { createIdentity } from "../modules/identity/infrastructure/index"
import { argon2Hasher } from "../modules/identity/infrastructure/argon2-hasher"
import { base32Decode, hotp } from "../modules/identity/infrastructure/totp"
import type { WorkspaceService } from "../modules/workspace/application/index"
import { createWorkspaces } from "../modules/workspace/infrastructure/index"
import { createApp } from "./app"
import { errorBodySchema } from "./error-body"

/**
 * Second factor, step-up, sessions list and lock-screen passcode end to end on
 * real PostgreSQL (B1b step 4; IAM-05, IAM-06, IAM-16, IAM-18, §8.2 rule 5).
 */
describe.skipIf(!ADMIN_URL)("second factor, step-up, sessions and passcode (B1b step 4)", () => {
  const ORIGIN = "https://app.nexora.ma"
  const PASSWORD = "lune de miel au maroc"
  let db: TestDb
  let app: ReturnType<typeof createApp>
  let workspaces: WorkspaceService
  let hash: string

  beforeAll(async () => {
    db = await createTestDb()
    hash = await argon2Hasher.hash(PASSWORD)
    const config = loadConfig({ APP_ORIGIN: ORIGIN, COOKIE_PATH_PREFIX: "/api" })
    const identity = createIdentity({ pool: db.web, sessionSecret: "x".repeat(40), encryptionKey: "k".repeat(40) })
    workspaces = createWorkspaces({ pool: db.web })
    app = createApp({ config, logger: pino({ level: "silent" }), auth: identity.auth, secondFactor: identity.secondFactor, workspaces })
  }, 60_000)
  afterAll(async () => db?.drop())
  beforeEach(async () => {
    await db.admin.query("DELETE FROM ops.rate_limits; DELETE FROM identity.sign_in_failures")
  })

  async function user(name = "Lina Alaoui") {
    const id = uuidv7()
    const email = `u-${id.slice(-12)}@atlas.ma`
    await db.admin.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', $2, $3)", [id, `user:${id}`, name])
    await db.admin.query("INSERT INTO identity.users (id, email, name, status, password_hash) VALUES ($1, $2, $3, 'active', $4)", [id, email, name, hash])
    return { id, email }
  }

  type Jar = Record<string, string>
  function readJar(res: request.Response, into: Jar = {}) {
    for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
      const [pair] = c.split(";")
      const eq = pair!.indexOf("=")
      const value = decodeURIComponent(pair!.slice(eq + 1))
      if (value) into[pair!.slice(0, eq)] = value
      else delete into[pair!.slice(0, eq)]
    }
    return into
  }
  const code = (res: request.Response) => errorBodySchema.parse(res.body).code

  /** A browser: its cookies, and requests that send them with Origin and the XSRF header. */
  function browser(jar: Jar = {}) {
    const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ")
    const send = async (method: "get" | "post" | "put" | "patch" | "delete", path: string, body?: object) => {
      const r = request(app)[method](path).set("Cookie", cookie()).set("Origin", ORIGIN)
      if (jar["XSRF-TOKEN"]) r.set("X-XSRF-TOKEN", jar["XSRF-TOKEN"])
      const res = await r.send(body)
      readJar(res, jar)
      return res
    }
    return { jar, send, get: (path: string) => send("get", path) }
  }

  async function signIn(email: string, totp?: () => string) {
    const b = browser()
    const res = await b.send("post", "/app/v1/auth/login", { email, password: PASSWORD })
    if (res.body.twoFactorRequired) {
      expect(b.jar.nx_m).toBeUndefined() // no session before the code
      const done = await b.send("post", "/app/v1/auth/2fa/verify", { challengeId: res.body.challengeId, code: totp!() })
      expect(done.status).toBe(200)
    } else expect(res.status).toBe(200)
    return b
  }

  /** Sets up and enables the factor for a signed-in browser; answers its code maker and recovery codes. */
  async function enrol(b: ReturnType<typeof browser>, principalId: string) {
    const setup = await b.send("post", "/app/v1/auth/2fa/setup")
    expect(setup.status).toBe(200)
    const secret = new URL(setup.body.otpauthUrl).searchParams.get("secret")!
    let offset = 0
    // Each code works once; tests that sign in again move on to the next step (still within the drift window).
    const totp = () => hotp(base32Decode(secret), Math.floor(Date.now() / 30_000) + offset)
    const enabled = await b.send("post", "/app/v1/auth/2fa/enable", { code: totp(), password: PASSWORD })
    expect(enabled.status).toBe(200)
    expect(enabled.body.recoveryCodes).toHaveLength(10)
    const fresh = async () => {
      await db.admin.query("UPDATE identity.second_factors SET last_step = 0 WHERE principal_id = $1", [principalId])
      offset = 0
      return totp()
    }
    return { totp, fresh, recoveryCodes: enabled.body.recoveryCodes as string[], next: () => ++offset }
  }

  it("sets up the second factor: the secret is shown once and stored encrypted; ten recovery codes (IAM-05, SCR-07)", async () => {
    const u = await user()
    const b = await signIn(u.email)
    const setup = await b.send("post", "/app/v1/auth/2fa/setup")
    const secret = new URL(setup.body.otpauthUrl).searchParams.get("secret")!
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    const stored = await db.admin.query("SELECT secret_enc, enabled_at FROM identity.second_factors WHERE principal_id = $1", [u.id])
    expect(stored.rows[0].secret_enc).not.toContain(secret)
    expect(stored.rows[0].enabled_at).toBeNull()
    const now = () => hotp(base32Decode(secret), Math.floor(Date.now() / 30_000))
    // A stolen session alone cannot tie the account to another app: the password is asked too.
    const noPassword = await b.send("post", "/app/v1/auth/2fa/enable", { code: now(), password: "not my password" })
    expect([noPassword.status, code(noPassword)]).toEqual([400, "err_invalidCredentials"])
    expect((await b.send("post", "/app/v1/auth/2fa/enable", { code: now() })).status).toBe(400)
    const wrong = await b.send("post", "/app/v1/auth/2fa/enable", { code: "000000", password: PASSWORD })
    expect([wrong.status, code(wrong)]).toEqual([400, "err_twoFactorInvalid"])
    const ok = await b.send("post", "/app/v1/auth/2fa/enable", { code: now(), password: PASSWORD })
    expect(ok.status).toBe(200)
    expect(new Set(ok.body.recoveryCodes).size).toBe(10)
    for (const c of ok.body.recoveryCodes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/)
    const hashes = await db.admin.query("SELECT code_hash FROM identity.recovery_codes WHERE principal_id = $1", [u.id])
    expect(hashes.rows).toHaveLength(10)
    expect(hashes.rows.map((r) => r.code_hash)).not.toContain(ok.body.recoveryCodes[0])
    expect((await b.get("/app/v1/auth/2fa")).body).toEqual({ enabled: true, recoveryCodesLeft: 10, passcodeSet: false, required: false })
    expect((await b.send("post", "/app/v1/auth/2fa/setup")).status).toBe(409)
    const trail = await db.admin.query("SELECT action FROM audit.identity_events WHERE principal_id = $1 AND action LIKE 'two_factor.%' ORDER BY at", [u.id])
    expect(trail.rows.map((r) => r.action)).toEqual(["two_factor.setup_started", "two_factor.enable_refused", "two_factor.failed", "two_factor.enabled"])
  })

  it("signs in in two steps: no session before the code, 5 codes per challenge, each code and recovery code once", async () => {
    const u = await user()
    const f = await enrol(await signIn(u.email), u.id)

    const b = browser()
    const first = await b.send("post", "/app/v1/auth/login", { email: u.email, password: PASSWORD })
    expect(first.body).toEqual({ twoFactorRequired: true, challengeId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
    expect(b.jar.nx_m).toBeUndefined()
    for (let i = 0; i < 5; i++) {
      const r = await b.send("post", "/app/v1/auth/2fa/verify", { challengeId: first.body.challengeId, code: "000000" })
      expect([r.status, code(r)]).toEqual([401, "err_twoFactorInvalid"])
    }
    // The challenge is spent: even the right code no longer opens it.
    expect((await b.send("post", "/app/v1/auth/2fa/verify", { challengeId: first.body.challengeId, code: await f.fresh() })).status).toBe(401)

    const again = await b.send("post", "/app/v1/auth/login", { email: u.email, password: PASSWORD })
    const c = await f.fresh()
    const ok = await b.send("post", "/app/v1/auth/2fa/verify", { challengeId: again.body.challengeId, code: c })
    expect(ok.status).toBe(200)
    expect(b.jar.nx_m).toBeDefined()
    expect((await b.get("/app/v1/auth/me")).body.twoFactorEnabled).toBe(true)
    // The same code on a new challenge: refused (replay).
    const third = await browser().send("post", "/app/v1/auth/login", { email: u.email, password: PASSWORD })
    expect((await browser().send("post", "/app/v1/auth/2fa/verify", { challengeId: third.body.challengeId, code: c })).status).toBe(401)
    // A recovery code works once, typed in any case.
    const r1 = await browser().send("post", "/app/v1/auth/login", { email: u.email, password: PASSWORD })
    expect((await browser().send("post", "/app/v1/auth/2fa/verify", { challengeId: r1.body.challengeId, code: f.recoveryCodes[0]!.toUpperCase() })).status).toBe(200)
    const r2 = await browser().send("post", "/app/v1/auth/login", { email: u.email, password: PASSWORD })
    expect((await browser().send("post", "/app/v1/auth/2fa/verify", { challengeId: r2.body.challengeId, code: f.recoveryCodes[0] })).status).toBe(401)
    const left = await db.admin.query("SELECT count(*)::int AS n FROM identity.recovery_codes WHERE principal_id = $1 AND used_at IS NULL", [u.id])
    expect(left.rows[0].n).toBe(9)
  })

  it("asks owners, administrators and accountants to enrol before any company page, and keeps it on for them (IAM-05)", async () => {
    const owner = await user("Owner")
    const id = await workspaces.provision({ name: "Atlas", slug: `atlas-${uuidv7().slice(-12)}`, country: "MA", currency: "MAD", timeZone: "Africa/Casablanca", locale: "fr", ownerUserId: owner.id }, owner.id)
    const accountant = await user("Accountant")
    const employee = await user("Employee")
    const c = await db.admin.connect()
    try {
      await c.query("BEGIN")
      await c.query("SELECT set_config('app.principal_id', $1, true)", [owner.id])
      for (const [p, key] of [[accountant, "accountant"], [employee, "employee"]] as const) {
        await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) SELECT $1, $2, $3, id, 'active', now() FROM tenant.roles WHERE workspace_id = $2 AND key = $4", [uuidv7(), id, p.id, key])
      }
      await c.query("COMMIT")
    } finally {
      c.release()
    }
    const base = `/app/v1/workspaces/${id}`
    const a = await signIn(accountant.email)
    const refused = await a.get(`${base}/context`)
    expect([refused.status, code(refused)]).toEqual([403, "err_twoFactorRequired"])
    expect((await a.get("/app/v1/auth/2fa")).body.required).toBe(true)
    const af = await enrol(a, accountant.id)
    expect((await a.get(`${base}/context`)).status).toBe(200)
    const off = await a.send("post", "/app/v1/auth/2fa/disable", { password: PASSWORD, code: await af.fresh() })
    expect([off.status, code(off)]).toEqual([403, "err_twoFactorRequired"])

    // An employee may work without it, and turn it off with the password and a code.
    const e = await signIn(employee.email)
    expect((await e.get(`${base}/context`)).status).toBe(200)
    const ef = await enrol(e, employee.id)
    const badPassword = await e.send("post", "/app/v1/auth/2fa/disable", { password: "not my password", code: await ef.fresh() })
    expect([badPassword.status, code(badPassword)]).toEqual([400, "err_invalidCredentials"])
    expect((await e.send("post", "/app/v1/auth/2fa/disable", { password: PASSWORD, code: await ef.fresh() })).status).toBe(204)
    expect((await e.get("/app/v1/auth/2fa")).body.enabled).toBe(false)
    expect((await db.admin.query("SELECT 1 FROM identity.recovery_codes WHERE principal_id = $1", [employee.id])).rowCount).toBe(0)
  })

  it("asks a fresh second factor before moving ownership, and changes nothing without it (IAM-06)", async () => {
    const owner = await user("Owner")
    const admin = await user("Admin")
    const id = await workspaces.provision({ name: "Atlas", slug: `atlas-${uuidv7().slice(-12)}`, country: "MA", currency: "MAD", timeZone: "Africa/Casablanca", locale: "fr", ownerUserId: owner.id }, owner.id)
    const mid = uuidv7()
    const c = await db.admin.connect()
    try {
      await c.query("BEGIN")
      await c.query("SELECT set_config('app.principal_id', $1, true)", [owner.id])
      await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) SELECT $1, $2, $3, id, 'active', now() FROM tenant.roles WHERE workspace_id = $2 AND key = 'admin'", [mid, id, admin.id])
      await c.query("COMMIT")
    } finally {
      c.release()
    }
    const o = await signIn(owner.email)
    const f = await enrol(o, owner.id)
    // Enrolling counts as fresh; ten minutes later it no longer does.
    await db.admin.query("UPDATE identity.sessions SET second_factor_at = now() - interval '10 minutes' WHERE principal_id = $1", [owner.id])
    const path = `/app/v1/workspaces/${id}/members/${mid}`
    const stale = await o.send("patch", path, { isOwner: true })
    expect([stale.status, code(stale)]).toEqual([403, "err_stepUpRequired"])
    expect((await db.admin.query("SELECT is_owner FROM tenant.memberships WHERE id = $1", [mid])).rows[0].is_owner).toBe(false)
    // A role change that does not touch ownership needs no step-up.
    expect((await o.send("patch", path, { status: "disabled" })).status).toBe(200)
    expect((await o.send("patch", path, { status: "active" })).status).toBe(200)
    const wrong = await o.send("post", "/app/v1/auth/step-up", { code: "000000" })
    expect([wrong.status, code(wrong)]).toEqual([400, "err_twoFactorInvalid"])
    const recovery = await o.send("post", "/app/v1/auth/step-up", { code: f.recoveryCodes[1] })
    expect(recovery.status).toBe(400) // step-up takes a code from the app, not a recovery code
    expect((await o.send("post", "/app/v1/auth/step-up", { code: await f.fresh() })).status).toBe(204)
    expect((await o.send("patch", path, { isOwner: true })).status).toBe(200)
  })

  it("lists the person's own sessions and ends them, never the current one by mistake (§8.2 rule 5)", async () => {
    const u = await user()
    const one = await signIn(u.email)
    const two = await signIn(u.email)
    const three = await signIn(u.email)
    const list = await one.get("/app/v1/me/sessions")
    expect(list.body.sessions).toHaveLength(3)
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1)
    const current = list.body.sessions.find((s: { current: boolean }) => s.current).id
    const others = list.body.sessions.filter((s: { current: boolean }) => !s.current).map((s: { id: string }) => s.id)
    expect((await one.send("delete", `/app/v1/me/sessions/${current}`)).status).toBe(404)
    expect((await one.send("delete", `/app/v1/me/sessions/${others[0]}`)).status).toBe(204)
    const stillUp = [await two.get("/app/v1/auth/me"), await three.get("/app/v1/auth/me")].map((r) => r.status).sort()
    expect(stillUp).toEqual([200, 401])
    expect((await one.send("delete", "/app/v1/me/sessions")).body).toEqual({ ended: 1 })
    expect((await two.get("/app/v1/auth/me")).status).toBe(401)
    expect((await three.get("/app/v1/auth/me")).status).toBe(401)
    expect((await one.get("/app/v1/auth/me")).status).toBe(200)
    // Someone else's session id answers like an unknown one.
    const stranger = await signIn((await user()).email)
    expect((await stranger.send("delete", `/app/v1/me/sessions/${current}`)).status).toBe(404)
    expect((await one.get("/app/v1/auth/me")).status).toBe(200)
  })

  it("lets an administrator end a member's sessions, not an employee (§8.2 rule 5)", async () => {
    const owner = await user("Owner")
    const id = await workspaces.provision({ name: "Atlas", slug: `atlas-${uuidv7().slice(-12)}`, country: "MA", currency: "MAD", timeZone: "Africa/Casablanca", locale: "fr", ownerUserId: owner.id }, owner.id)
    const p = await user()
    const mid = uuidv7()
    const c = await db.admin.connect()
    try {
      await c.query("BEGIN")
      await c.query("SELECT set_config('app.principal_id', $1, true)", [owner.id])
      await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) SELECT $1, $2, $3, id, 'active', now() FROM tenant.roles WHERE workspace_id = $2 AND key = 'employee'", [mid, id, p.id])
      await c.query("COMMIT")
    } finally {
      c.release()
    }
    const ownerMid = (await db.admin.query("SELECT id FROM tenant.memberships WHERE workspace_id = $1 AND user_id = $2", [id, owner.id])).rows[0].id
    const member = await signIn(p.email)
    expect((await member.send("delete", `/app/v1/workspaces/${id}/members/${ownerMid}/sessions`)).status).toBe(403)
    const o = await signIn(owner.email)
    await enrol(o, owner.id)
    const res = await o.send("delete", `/app/v1/workspaces/${id}/members/${mid}/sessions`)
    expect(res.body).toEqual({ ended: 1 })
    expect((await member.get("/app/v1/auth/me")).status).toBe(401)
    const trail = await db.admin.query("SELECT action FROM audit.workspace_events WHERE workspace_id = $1 AND target_id = $2", [id, mid])
    expect(trail.rows.map((r) => r.action)).toEqual(["membership.sessions_ended"])
  })

  it("locks an idle session that has a passcode, unlocks it with the passcode, and ends it after 5 wrong ones (IAM-18)", async () => {
    const u = await user()
    const b = await signIn(u.email)
    const badPassword = await b.send("put", "/app/v1/auth/passcode", { passcode: "2468", password: "wrong password here" })
    expect([badPassword.status, code(badPassword)]).toEqual([400, "err_invalidCredentials"])
    expect((await b.send("put", "/app/v1/auth/passcode", { passcode: "24a8", password: PASSWORD })).status).toBe(400)
    expect((await b.send("put", "/app/v1/auth/passcode", { passcode: "2468", password: PASSWORD })).status).toBe(204)
    const stored = await db.admin.query("SELECT passcode_hash FROM identity.passcodes WHERE user_id = $1", [u.id])
    expect(stored.rows[0].passcode_hash).toMatch(/^\$argon2id\$/)

    const idle = () => db.admin.query("UPDATE identity.sessions SET idle_expires_at = now() - interval '1 minute', last_activity_at = now() - interval '31 minutes' WHERE principal_id = $1 AND revoked_at IS NULL", [u.id])
    await idle()
    expect((await b.get("/app/v1/auth/me")).status).toBe(401)
    const locked = await b.send("post", "/app/v1/auth/refresh")
    expect([locked.status, code(locked)]).toEqual([401, "err_sessionLocked"])
    expect(b.jar.nx_m_r).toBeDefined() // the lock keeps the refresh cookie for the passcode
    for (let i = 0; i < 4; i++) expect((await b.send("post", "/app/v1/auth/passcode-verify", { passcode: "1111" })).body).toEqual({ valid: false })
    expect((await b.send("post", "/app/v1/auth/passcode-verify", { passcode: "2468" })).body).toEqual({ valid: true })
    expect((await b.get("/app/v1/auth/me")).status).toBe(200)

    await idle()
    for (let i = 0; i < 4; i++) await b.send("post", "/app/v1/auth/passcode-verify", { passcode: "1111" })
    const fifth = await b.send("post", "/app/v1/auth/passcode-verify", { passcode: "1111" })
    expect([fifth.status, code(fifth)]).toEqual([401, "err_sessionEnded"])
    expect((await b.send("post", "/app/v1/auth/passcode-verify", { passcode: "2468" })).status).toBe(401)
    const reason = await db.admin.query("SELECT revoked_reason FROM identity.sessions WHERE principal_id = $1", [u.id])
    expect(reason.rows.map((r) => r.revoked_reason)).toEqual(["passcode_failed"])
    const trail = await db.admin.query("SELECT action FROM audit.identity_events WHERE principal_id = $1 AND action LIKE 'passcode.%' OR principal_id = $1 AND action = 'session.unlocked' ORDER BY at", [u.id])
    expect(trail.rows.map((r) => r.action)).toEqual(["passcode.set", ...Array(4).fill("passcode.failed"), "session.unlocked", ...Array(4).fill("passcode.failed"), "passcode.locked_out"])
  })

  it("never unlocks after the absolute limit, and ends an idle session without a passcode (IAM-07, IAM-18)", async () => {
    const u = await user()
    const b = await signIn(u.email)
    await b.send("put", "/app/v1/auth/passcode", { passcode: "135790", password: PASSWORD })
    await db.admin.query("UPDATE identity.sessions SET idle_expires_at = now() - interval '2 hours', absolute_expires_at = now() - interval '1 minute', created_at = now() - interval '13 hours', last_activity_at = now() - interval '2 hours' WHERE principal_id = $1", [u.id])
    expect(code(await b.send("post", "/app/v1/auth/refresh"))).toBe("err_sessionEnded")
    const c = await signIn(u.email)
    expect((await c.send("post", "/app/v1/auth/passcode-verify", { passcode: "135790" })).body).toEqual({ valid: true })
    await c.send("delete", "/app/v1/auth/passcode")
    await db.admin.query("UPDATE identity.sessions SET idle_expires_at = now() - interval '1 minute', last_activity_at = now() - interval '31 minutes' WHERE principal_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()", [u.id])
    expect(code(await c.send("post", "/app/v1/auth/refresh"))).toBe("err_sessionEnded")
  })
})

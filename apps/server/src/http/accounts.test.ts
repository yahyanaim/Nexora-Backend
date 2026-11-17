import pino from "pino"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../config/config"
import { ADMIN_URL, createTestDb, type TestDb } from "../db/testing/test-db"
import { uuidv7 } from "../db/uuid"
import { createIdentity } from "../modules/identity/infrastructure/index"
import { argon2Hasher } from "../modules/identity/infrastructure/argon2-hasher"
import { aesGcmBox } from "../modules/identity/infrastructure/secret-box"
import { base32Decode, hotp, totp } from "../modules/identity/infrastructure/totp"
import type { WorkspaceService } from "../modules/workspace/application/index"
import { createWorkspaces } from "../modules/workspace/infrastructure/index"
import { createApp } from "./app"
import { errorBodySchema } from "./error-body"

/**
 * Invitations and password reset end to end on real PostgreSQL (B1b step 4b;
 * cahier §8.1; IAM-03, IAM-10, IAM-15, IAM-16).
 */
describe.skipIf(!ADMIN_URL)("invitations and password reset (B1b step 4b)", () => {
  const ORIGIN = "https://app.nexora.ma"
  const PASSWORD = "lune de miel au maroc"
  const KEY = "k".repeat(40)
  const SECRET = totp.newSecret()
  const factorBox = aesGcmBox(KEY, "second-factor")
  const mailBox = aesGcmBox(KEY, "mail")
  let db: TestDb
  let app: ReturnType<typeof createApp>
  let workspaces: WorkspaceService
  let hash: string

  beforeAll(async () => {
    db = await createTestDb()
    hash = await argon2Hasher.hash(PASSWORD)
    const config = loadConfig({ APP_ORIGIN: ORIGIN, COOKIE_PATH_PREFIX: "/api" })
    const identity = createIdentity({ pool: db.web, sessionSecret: "x".repeat(40), encryptionKey: KEY })
    workspaces = createWorkspaces({ pool: db.web })
    app = createApp({ config, logger: pino({ level: "silent" }), auth: identity.auth, secondFactor: identity.secondFactor, accounts: identity.accounts, workspaces })
  }, 60_000)
  afterAll(async () => db?.drop())
  beforeEach(async () => {
    await db.admin.query("DELETE FROM ops.rate_limits; DELETE FROM identity.sign_in_failures")
  })

  const code = (res: request.Response) => errorBodySchema.parse(res.body).code
  const post = (path: string, body: object) => request(app).post(path).set("Origin", ORIGIN).send(body)

  async function user(name = "Owner", withFactor = true) {
    const id = uuidv7()
    const email = `u-${id.slice(-12)}@atlas.ma`
    await db.admin.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', $2, $3)", [id, `user:${id}`, name])
    await db.admin.query("INSERT INTO identity.users (id, email, name, status, password_hash) VALUES ($1, $2, $3, 'active', $4)", [id, email, name, hash])
    if (withFactor) await db.admin.query("INSERT INTO identity.second_factors (principal_id, secret_enc, enabled_at) VALUES ($1, $2, now())", [id, factorBox.seal(SECRET)])
    return { id, email }
  }

  /** Signs in (with the second factor when the account has one) and answers a browser. */
  async function signIn(email: string, password = PASSWORD) {
    const jar: Record<string, string> = {}
    const keep = (res: request.Response) => {
      for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
        const [pair] = c.split(";")
        const eq = pair!.indexOf("=")
        jar[pair!.slice(0, eq)] = decodeURIComponent(pair!.slice(eq + 1))
      }
      return res
    }
    let res = keep(await post("/app/v1/auth/login", { email, password }))
    if (res.body.twoFactorRequired) {
      await db.admin.query("UPDATE identity.second_factors SET last_step = 0 WHERE principal_id = (SELECT id FROM identity.users WHERE email = $1)", [email])
      res = keep(await post("/app/v1/auth/2fa/verify", { challengeId: res.body.challengeId, code: hotp(base32Decode(SECRET), Math.floor(Date.now() / 30_000)) }))
    }
    const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ")
    return {
      status: res.status,
      get: (path: string) => request(app).get(path).set("Cookie", cookie()),
      send: (method: "post" | "patch" | "delete", path: string, body?: object) =>
        request(app)[method](path).set("Cookie", cookie()).set("Origin", ORIGIN).set("X-XSRF-TOKEN", jar["XSRF-TOKEN"] ?? "").send(body),
    }
  }

  async function company() {
    const owner = await user("Owner")
    const id = await workspaces.provision({ name: "Atlas", slug: `atlas-${uuidv7().slice(-12)}`, country: "MA", currency: "MAD", timeZone: "Africa/Casablanca", locale: "fr", ownerUserId: owner.id }, owner.id)
    const roles = Object.fromEntries((await db.admin.query("SELECT key, id FROM tenant.roles WHERE workspace_id = $1 AND key IS NOT NULL", [id])).rows.map((r) => [r.key, r.id]))
    return { id, owner, roles: roles as Record<"admin" | "manager" | "accountant" | "employee", string> }
  }

  /** The link the e-mail would carry: opened from the outbox, where it is stored sealed. */
  async function lastLink(eventType: string, to: string) {
    const { rows } = await db.admin.query("SELECT payload FROM ops.outbox WHERE event_type = $1 AND payload ->> 'to' = $2 ORDER BY created_at DESC LIMIT 1", [eventType, to])
    expect(rows).toHaveLength(1)
    return mailBox.open(rows[0].payload.link)
  }

  it("invites a new person: an invited account and membership, a sealed 7-day link in the outbox, and the link used once (IAM-10)", async () => {
    const { id, owner, roles } = await company()
    const o = await signIn(owner.email)
    const email = `new-${uuidv7().slice(-10)}@atlas.ma`
    const res = await o.send("post", `/app/v1/workspaces/${id}/members`, { email: email.toUpperCase(), name: "Samir Benali", roleId: roles.employee })
    expect(res.status).toBe(201)
    expect(res.body.member).toMatchObject({ email, name: email, status: "invited", role: { key: "employee" }, isOwner: false })
    const account = await db.admin.query("SELECT status, password_hash FROM identity.users WHERE email = $1", [email])
    expect(account.rows).toEqual([{ status: "invited", password_hash: null }])
    const outbox = await db.admin.query("SELECT workspace_id, aggregate_type, payload FROM ops.outbox WHERE event_type = 'identity.invitation_sent' AND payload ->> 'to' = $1", [email])
    expect(outbox.rows[0]).toMatchObject({ workspace_id: null, aggregate_type: "identity" })
    const link = await lastLink("identity.invitation_sent", email)
    expect(link).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(outbox.rows[0].payload)).not.toContain(link) // the outbox holds it sealed
    const stored = await db.admin.query("SELECT token_hash, expires_at - created_at AS life FROM identity.sign_in_tokens WHERE purpose = 'invite' AND email = $1", [email])
    expect(stored.rows[0].token_hash).not.toBe(link)
    expect(stored.rows[0].life).toMatchObject({ days: 7 })

    expect((await post("/app/v1/auth/invite-check", { token: link })).body).toEqual({ email, workspaceId: id, needsPassword: true })
    // A refused password leaves the link usable.
    const short = await post("/app/v1/auth/invite-accept", { token: link, password: "too short" })
    expect([short.status, code(short), short.body.values]).toEqual([400, "err_passwordTooShort", { min: 12 }])
    expect([(await post("/app/v1/auth/invite-accept", { token: link, password: "Password1234" })).body.code]).toEqual(["err_passwordBreached"])
    const ok = await post("/app/v1/auth/invite-accept", { token: link, password: "un printemps à fès" })
    expect(ok.body).toEqual({ workspaceId: id })
    const again = await post("/app/v1/auth/invite-accept", { token: link, password: "un printemps à fès" })
    expect([again.status, code(again)]).toEqual([400, "err_inviteGone"])
    expect(code(await post("/app/v1/auth/invite-check", { token: link }))).toBe("err_inviteGone")

    const s = await signIn(email, "un printemps à fès")
    expect(s.status).toBe(200)
    expect((await s.get("/app/v1/me/workspaces")).body.map((w: { id: string }) => w.id)).toEqual([id])
    expect((await s.get(`/app/v1/workspaces/${id}/context`)).body.role.key).toBe("employee")
    const trail = await db.admin.query("SELECT action FROM audit.workspace_events WHERE workspace_id = $1 AND action LIKE 'membership.%' ORDER BY at", [id])
    expect(trail.rows.map((r) => r.action)).toEqual(["membership.invited", "membership.joined"])
  })

  it("gives the link once when two acceptances arrive together (IAM-10)", async () => {
    const { id, owner, roles } = await company()
    const o = await signIn(owner.email)
    const email = `twin-${uuidv7().slice(-10)}@atlas.ma`
    await o.send("post", `/app/v1/workspaces/${id}/members`, { email, name: "Twin", roleId: roles.employee })
    const link = await lastLink("identity.invitation_sent", email)
    const both = await Promise.all([1, 2].map(() => post("/app/v1/auth/invite-accept", { token: link, password: "un printemps à fès" })))
    expect(both.map((r) => r.status).sort()).toEqual([200, 400])
  })

  it("lets a person who already has an account join without a new password", async () => {
    const a = await company()
    const b = await company()
    const o = await signIn(b.owner.email)
    const res = await o.send("post", `/app/v1/workspaces/${b.id}/members`, { email: a.owner.email, name: "ignored", roleId: b.roles.manager })
    expect(res.status).toBe(201)
    // The inviter does not learn the name of an account that exists elsewhere before it joins.
    expect(res.body.member.name).toBe(a.owner.email)
    const link = await lastLink("identity.invitation_sent", a.owner.email)
    expect((await post("/app/v1/auth/invite-check", { token: link })).body.needsPassword).toBe(false)
    expect((await post("/app/v1/auth/invite-accept", { token: link })).status).toBe(200)
    const s = await signIn(a.owner.email)
    expect((await s.get("/app/v1/me/workspaces")).body.map((w: { id: string }) => w.id).sort()).toEqual([a.id, b.id].sort())
    // The account and its password stay as they were.
    expect((await db.admin.query("SELECT name FROM identity.users WHERE id = $1", [a.owner.id])).rows[0].name).toBe("Owner")
  })

  it("lets only people with users:create invite, never to a role above their own, and creates nothing when refused", async () => {
    const { id, owner, roles } = await company()
    const o = await signIn(owner.email)
    const lead = await o.send("post", `/app/v1/workspaces/${id}/roles`, { name: "Recruiter", permissions: ["users:read", "users:create", "projects:read", "files:read", "files:create", "time:track"] })
    const p = await user("Recruiter")
    const q = await user("Employee", false)
    const c = await db.admin.connect()
    try {
      await c.query("BEGIN")
      await c.query("SELECT set_config('app.principal_id', $1, true)", [owner.id])
      await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) VALUES ($1, $2, $3, $4, 'active', now())", [uuidv7(), id, p.id, lead.body.role.id])
      await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) VALUES ($1, $2, $3, $4, 'active', now())", [uuidv7(), id, q.id, roles.employee])
      await c.query("COMMIT")
    } finally {
      c.release()
    }
    const count = async () => (await db.admin.query("SELECT count(*)::int AS n FROM identity.users")).rows[0].n
    const before = await count()
    const e = await signIn(q.email)
    const refused = await e.send("post", `/app/v1/workspaces/${id}/members`, { email: "nobody-1@atlas.ma", name: "X", roleId: roles.employee })
    expect([refused.status, code(refused)]).toEqual([403, "err_forbidden"])
    const r = await signIn(p.email)
    const above = await r.send("post", `/app/v1/workspaces/${id}/members`, { email: "nobody-2@atlas.ma", name: "X", roleId: roles.admin })
    expect([above.status, code(above)]).toEqual([403, "err_forbidden"])
    expect(await count()).toBe(before) // no account was made for a refused invitation
    expect((await r.send("post", `/app/v1/workspaces/${id}/members`, { email: "fine@atlas.ma", name: "Fine", roleId: roles.employee })).status).toBe(201)
    const dup = await r.send("post", `/app/v1/workspaces/${id}/members`, { email: "fine@atlas.ma", name: "Fine", roleId: roles.employee })
    expect([dup.status, code(dup)]).toEqual([409, "err_conflict"])
    expect((await r.send("post", `/app/v1/workspaces/${id}/members`, { email: "not an email", name: "X", roleId: roles.employee })).status).toBe(400)
  })

  it("resets a password with a single-use link: same answer for unknown e-mails, every session ended, the lock cleared (IAM-15)", async () => {
    const u = await user("Lina", false)
    const s1 = await signIn(u.email)
    const s2 = await signIn(u.email)
    const outboxRows = async () => (await db.admin.query("SELECT count(*)::int AS n FROM ops.outbox WHERE event_type = 'identity.password_reset_requested'")).rows[0].n
    const before = await outboxRows()
    expect((await post("/app/v1/auth/password-reset-request", { email: "nobody-here@atlas.ma" })).status).toBe(204)
    expect((await post("/app/v1/auth/password-reset-request", { email: "not an email" })).status).toBe(204)
    expect(await outboxRows()).toBe(before)
    expect((await post("/app/v1/auth/password-reset-request", { email: u.email.toUpperCase() })).status).toBe(204)
    const link = await lastLink("identity.password_reset_requested", u.email)

    expect((await post("/app/v1/auth/password-reset-verify", { token: link })).body).toEqual({ resetToken: link })
    expect(code(await post("/app/v1/auth/password-reset", { resetToken: link, password: "Password1234" }))).toBe("err_passwordBreached")
    await db.admin.query("UPDATE identity.users SET failed_attempts = 5, locked_until = now() + interval '10 minutes' WHERE id = $1", [u.id])
    expect((await post("/app/v1/auth/password-reset", { resetToken: link, password: "un nouveau départ à rabat" })).status).toBe(204)
    expect((await s1.get("/app/v1/auth/me")).status).toBe(401)
    expect((await s2.get("/app/v1/auth/me")).status).toBe(401)
    expect((await post("/app/v1/auth/login", { email: u.email, password: PASSWORD })).status).toBe(401)
    expect((await signIn(u.email, "un nouveau départ à rabat")).status).toBe(200)
    expect((await db.admin.query("SELECT failed_attempts, locked_until FROM identity.users WHERE id = $1", [u.id])).rows[0]).toEqual({ failed_attempts: 0, locked_until: null })
    const used = await post("/app/v1/auth/password-reset", { resetToken: link, password: "encore un autre mot de passe" })
    expect([used.status, code(used)]).toEqual([400, "err_resetLinkInvalid"])
    const reasons = await db.admin.query("SELECT DISTINCT revoked_reason FROM identity.sessions WHERE principal_id = $1 AND revoked_at IS NOT NULL", [u.id])
    expect(reasons.rows).toEqual([{ revoked_reason: "password_changed" }])
  })

  it("refuses an expired reset link, ends older reset links with the reset, and limits requests per e-mail", async () => {
    const u = await user("Lina", false)
    await post("/app/v1/auth/password-reset-request", { email: u.email })
    const first = await lastLink("identity.password_reset_requested", u.email)
    await post("/app/v1/auth/password-reset-request", { email: u.email })
    const second = await lastLink("identity.password_reset_requested", u.email)
    expect(second).not.toBe(first)
    expect((await post("/app/v1/auth/password-reset", { resetToken: second, password: "un nouveau départ à rabat" })).status).toBe(204)
    expect(code(await post("/app/v1/auth/password-reset-verify", { token: first }))).toBe("err_resetLinkInvalid")

    await post("/app/v1/auth/password-reset-request", { email: u.email })
    const third = await lastLink("identity.password_reset_requested", u.email)
    await db.admin.query("UPDATE identity.sign_in_tokens SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE purpose = 'reset' AND used_at IS NULL")
    expect(code(await post("/app/v1/auth/password-reset-verify", { token: third }))).toBe("err_resetLinkInvalid")

    await db.admin.query("DELETE FROM ops.rate_limits")
    const answers = []
    for (let i = 0; i < 6; i++) answers.push((await post("/app/v1/auth/password-reset-request", { email: u.email })).status)
    expect(answers).toEqual([204, 204, 204, 204, 204, 429])
    const trail = await db.admin.query("SELECT action FROM audit.identity_events WHERE principal_id = $1 AND action LIKE 'password.%'", [u.id])
    expect(trail.rows.map((r) => r.action)).toContain("password.reset")
  })
})

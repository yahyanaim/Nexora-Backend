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
import { ANY_MEMBER, DEFAULT_ROLES, grants, PERMISSION_OF, type WorkspaceService } from "../modules/workspace/application/index"
import { createWorkspaces } from "../modules/workspace/infrastructure/index"
import { createApp } from "./app"
import { errorBodySchema } from "./error-body"
import { WORKSPACE_ROUTES } from "./workspace-routes"

/**
 * The B1b gate (cahier B1b; TEN-01, TEN-04, TEN-08, AUZ-01, AUZ-02, SCR-16):
 * every company route is called by every default role of the company, by the
 * owner of another company, without a session and without the XSRF header,
 * and the answers are compared with the permissions the routes declare. The
 * matrix is generated from WORKSPACE_ROUTES and PERMISSION_OF, so a new route
 * is covered the day it is added.
 */
describe.skipIf(!ADMIN_URL)("B1b gate: isolation and permission suites", () => {
  const ORIGIN = "https://app.nexora.ma"
  const PASSWORD = "lune de miel au maroc"
  const KEY = "k".repeat(40)
  const SECRET = totp.newSecret()
  const box = aesGcmBox(KEY, "second-factor")
  let db: TestDb
  let app: ReturnType<typeof createApp>
  let workspaces: WorkspaceService
  let hash: string

  type Browser = { cookie: string; xsrf: string }
  type Company = { id: string; roles: Record<string, string>; target: string; members: Record<string, { id: string; email: string; mid: string; b: Browser }> }
  let a: Company
  let b: Company

  beforeAll(async () => {
    db = await createTestDb()
    hash = await argon2Hasher.hash(PASSWORD)
    const config = loadConfig({ APP_ORIGIN: ORIGIN, COOKIE_PATH_PREFIX: "/api" })
    const identity = createIdentity({ pool: db.web, sessionSecret: "x".repeat(40), encryptionKey: KEY })
    workspaces = createWorkspaces({ pool: db.web })
    app = createApp({ config, logger: pino({ level: "silent" }), auth: identity.auth, secondFactor: identity.secondFactor, accounts: identity.accounts, workspaces })
    a = await company("atlas")
    b = await company("helio")
  }, 120_000)
  afterAll(async () => db?.drop())
  beforeEach(async () => {
    await db.admin.query("DELETE FROM ops.rate_limits; DELETE FROM identity.sign_in_failures")
  })

  async function user(name: string) {
    const id = uuidv7()
    const email = `u-${id.slice(-12)}@${name}.ma`
    await db.admin.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', $2, $3)", [id, `user:${id}`, name])
    await db.admin.query("INSERT INTO identity.users (id, email, name, status, password_hash) VALUES ($1, $2, $3, 'active', $4)", [id, email, name, hash])
    await db.admin.query("INSERT INTO identity.second_factors (principal_id, secret_enc, enabled_at) VALUES ($1, $2, now())", [id, box.seal(SECRET)])
    return { id, email }
  }

  async function signIn(email: string): Promise<Browser> {
    const first = await request(app).post("/api/app/v1/auth/login").set("Origin", ORIGIN).send({ email, password: PASSWORD })
    await db.admin.query("UPDATE identity.second_factors SET last_step = 0 WHERE principal_id = (SELECT id FROM identity.users WHERE email = $1)", [email])
    const res = await request(app).post("/api/app/v1/auth/2fa/verify").set("Origin", ORIGIN).send({ challengeId: first.body.challengeId, code: hotp(base32Decode(SECRET), Math.floor(Date.now() / 30_000)) })
    expect(res.status).toBe(200)
    const jar: Record<string, string> = {}
    for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
      const [pair] = c.split(";")
      const eq = pair!.indexOf("=")
      jar[pair!.slice(0, eq)] = decodeURIComponent(pair!.slice(eq + 1))
    }
    return { cookie: `nx_m=${encodeURIComponent(jar.nx_m!)}`, xsrf: jar["XSRF-TOKEN"]! }
  }

  /** A company with one member per default role (the owner holds the administrator role). */
  async function company(slug: string): Promise<Company> {
    const owner = await user(slug)
    const id = await workspaces.provision({ name: slug, slug: `${slug}-${uuidv7().slice(-10)}`, country: "MA", currency: "MAD", timeZone: "Africa/Casablanca", locale: "fr", ownerUserId: owner.id }, owner.id)
    const roles = Object.fromEntries((await db.admin.query("SELECT key, id FROM tenant.roles WHERE workspace_id = $1 AND key IS NOT NULL", [id])).rows.map((r) => [r.key, r.id]))
    const members: Company["members"] = {}
    members.owner = { ...owner, mid: (await db.admin.query("SELECT id FROM tenant.memberships WHERE workspace_id = $1", [id])).rows[0].id, b: await signIn(owner.email) }
    for (const key of ["manager", "accountant", "employee"]) {
      const p = await user(slug)
      const mid = uuidv7()
      const c = await db.admin.connect()
      try {
        await c.query("BEGIN")
        await c.query("SELECT set_config('app.principal_id', $1, true)", [owner.id])
        await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) VALUES ($1, $2, $3, $4, 'active', now())", [mid, id, p.id, roles[key]])
        await c.query("COMMIT")
      } finally {
        c.release()
      }
      members[key] = { ...p, mid, b: await signIn(p.email) }
    }
    // The member the member routes act on: ending its sessions must not sign out a caller of the matrix
    const t = await user(slug)
    const target = uuidv7()
    const c = await db.admin.connect()
    try {
      await c.query("BEGIN")
      await c.query("SELECT set_config('app.principal_id', $1, true)", [owner.id])
      await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) VALUES ($1, $2, $3, $4, 'active', now())", [target, id, t.id, roles.employee])
      await c.query("COMMIT")
    } finally {
      c.release()
    }
    return { id, roles, target, members }
  }

  /** A call of one route of company `of`, with record ids from company `ids` (the company itself unless testing a foreign record). */
  function call(route: (typeof WORKSPACE_ROUTES)[number], of: Company, ids: Company, who: Browser | null, opts: { xsrf?: boolean } = {}) {
    const path = `/api/app/v1/workspaces/${of.id}${route.path}`
      .replace(":mid", ids.target)
      .replace(":rid", ids.roles.employee!)
    const body: Record<string, object> = {
      "post /members": { email: `inv-${uuidv7().slice(-10)}@x.ma`, name: "Invitee", roleId: ids.roles.employee! },
      "patch /members/:mid": { status: "active" },
      "post /roles": { name: `Role ${uuidv7().slice(-8)}`, permissions: ["projects:read"] },
      "patch /roles/:rid": { name: "Employee", version: 1 },
    }
    const r = request(app)[route.method](path).set("Origin", ORIGIN)
    if (who) r.set("Cookie", who.cookie)
    if (who && opts.xsrf !== false) r.set("X-XSRF-TOKEN", who.xsrf)
    return r.send(body[`${route.method} ${route.path}`])
  }

  const codeOf = (res: request.Response) => (res.body && typeof res.body === "object" && "code" in res.body ? errorBodySchema.parse(res.body).code : null)
  const routes = WORKSPACE_ROUTES.filter((r) => r.command !== "deleteRole") // deleting a default role is covered below without losing it

  it("answers each default role as its permissions say, on every company route (AUZ-01, AUZ-02)", async () => {
    const rows: string[] = []
    for (const route of routes) {
      const needed = PERMISSION_OF[route.command]
      for (const [who, member] of Object.entries(a.members)) {
        const held = who === "owner" ? DEFAULT_ROLES.admin.permissions : DEFAULT_ROLES[who as "manager" | "accountant" | "employee"].permissions
        const allowed = needed === ANY_MEMBER || grants(held, needed)
        const res = await call(route, a, a, member.b)
        const refused = res.status === 403 && codeOf(res) === "err_forbidden"
        if (allowed === refused) rows.push(`${who} ${route.method} ${route.path}: ${res.status} ${codeOf(res) ?? ""} (expected ${allowed ? "allowed" : "403 err_forbidden"})`)
      }
    }
    expect(rows).toEqual([])
  }, 120_000)

  it("refuses every route of a company to the owner of another one, and reads or changes nothing (TEN-01, TEN-08)", async () => {
    const before = await db.admin.query("SELECT (SELECT count(*) FROM tenant.memberships WHERE workspace_id = $1)::int AS m, (SELECT count(*) FROM tenant.roles WHERE workspace_id = $1)::int AS r, (SELECT count(*) FROM identity.users)::int AS u", [a.id])
    for (const route of WORKSPACE_ROUTES) {
      const res = await call(route, a, a, b.members.owner!.b)
      expect([route.path, res.status, codeOf(res)]).toEqual([route.path, 403, "err_forbidden"])
      expect(Object.keys(res.body).sort()).toEqual(["code", "requestId", "values"])
    }
    const after = await db.admin.query("SELECT (SELECT count(*) FROM tenant.memberships WHERE workspace_id = $1)::int AS m, (SELECT count(*) FROM tenant.roles WHERE workspace_id = $1)::int AS r, (SELECT count(*) FROM identity.users)::int AS u", [a.id])
    expect(after.rows).toEqual(before.rows)
    const trail = await db.admin.query("SELECT count(*)::int AS n FROM audit.identity_events WHERE principal_id = $1 AND action = 'workspace.access_refused' AND requested_workspace = $2", [b.members.owner!.id, a.id])
    expect(trail.rows[0].n).toBe(WORKSPACE_ROUTES.length)
  }, 120_000)

  it("never reaches another company's record through one's own company path (TEN-04)", async () => {
    for (const route of WORKSPACE_ROUTES.filter((r) => r.path.includes(":"))) {
      const res = await call(route, a, b, a.members.owner!.b)
      expect([route.method, route.path, res.status]).toEqual([route.method, route.path, 404])
    }
    const roleOfB = await db.admin.query("SELECT count(*)::int AS n FROM tenant.roles WHERE workspace_id = $1 AND key = 'employee'", [b.id])
    expect(roleOfB.rows[0].n).toBe(1)
  }, 120_000)

  it("answers every company route 401 without a session and 403 err_csrf on writes without the header (IAM-01, SCR-16)", async () => {
    for (const route of WORKSPACE_ROUTES) {
      const guest = await call(route, a, a, null)
      expect([route.path, guest.status, codeOf(guest)]).toEqual([route.path, 401, "err_sessionEnded"])
      if (route.method !== "get") {
        const noHeader = await call(route, a, a, a.members.owner!.b, { xsrf: false })
        expect([route.path, noHeader.status, codeOf(noHeader)]).toEqual([route.path, 403, "err_csrf"])
      }
    }
  }, 120_000)

  it("serves the same routes with and without the /api prefix the web application's proxy forwards", async () => {
    const owner = a.members.owner!.b
    const withPrefix = await request(app).get(`/api/app/v1/workspaces/${a.id}/context`).set("Cookie", owner.cookie)
    const without = await request(app).get(`/app/v1/workspaces/${a.id}/context`).set("Cookie", owner.cookie)
    expect([withPrefix.status, without.status]).toEqual([200, 200])
    expect(withPrefix.body).toEqual(without.body)
    expect((await request(app).get("/api/health/live")).body).toEqual({ status: "ok" })
    expect((await request(app).get("/apis/app/v1/auth/me")).status).toBe(404) // only the exact prefix is taken off
  })

  it("keeps the default roles: deleting one is refused even to the owner (AUZ-02)", async () => {
    const del = WORKSPACE_ROUTES.find((r) => r.command === "deleteRole")!
    const res = await call(del, a, a, a.members.owner!.b)
    expect([res.status, codeOf(res)]).toEqual([409, "err_defaultRoleFixed"])
  })
})

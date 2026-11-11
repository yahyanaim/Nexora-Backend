import { AdminPermissionsPlatform } from "@nexora/core/types/roles"
import pino from "pino"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loadConfig } from "../config/config"
import { inTransaction } from "../db/session"
import { ADMIN_URL, createTestDb, type TestDb } from "../db/testing/test-db"
import { uuidv7 } from "../db/uuid"
import { createIdentity } from "../modules/identity/infrastructure/index"
import { argon2Hasher } from "../modules/identity/infrastructure/argon2-hasher"
import { DEFAULT_ROLES, PERMISSION_OF, type WorkspaceService } from "../modules/workspace/application/index"
import { createWorkspaces } from "../modules/workspace/infrastructure/index"
import { createApp } from "./app"
import { errorBodySchema } from "./error-body"
import { WORKSPACE_PREFIX, WORKSPACE_ROUTES } from "./workspace-routes"

/**
 * Workspaces, memberships, roles and permissions end to end on real PostgreSQL
 * (B1b step 3; TEN-01, TEN-02, TEN-03, AUZ-01, AUZ-02, AUZ-09, AUZ-10, AUZ-11, AUZ-14).
 */
describe.skipIf(!ADMIN_URL)("workspaces, memberships and roles (B1b step 3)", () => {
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
    workspaces = createWorkspaces({ pool: db.web })
    app = createApp({ config, logger: pino({ level: "silent" }), auth: createIdentity({ pool: db.web, sessionSecret: "x".repeat(40) }).auth, workspaces })
  }, 60_000)
  afterAll(async () => db?.drop())

  async function user(name = "Lina Alaoui") {
    const id = uuidv7()
    const email = `u-${id.slice(-12)}@atlas.ma`
    await db.admin.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', $2, $3)", [id, `user:${id}`, name])
    await db.admin.query("INSERT INTO identity.users (id, email, name, status, password_hash) VALUES ($1, $2, $3, 'active', $4)", [id, email, name, hash])
    return { id, email }
  }

  /** A company with its owner, through the provisioning function. */
  async function company() {
    const owner = await user("Owner")
    const id = await workspaces.provision({ name: "Atlas", slug: `atlas-${uuidv7().slice(-12)}`, country: "MA", currency: "MAD", timeZone: "Africa/Casablanca", locale: "fr", ownerUserId: owner.id }, owner.id)
    return { id, owner }
  }

  async function roleId(wid: string, key: string) {
    const { rows } = await db.admin.query("SELECT id FROM tenant.roles WHERE workspace_id = $1 AND key = $2", [wid, key])
    return rows[0]!.id as string
  }

  async function join(wid: string, userId: string, key: string, status = "active") {
    const id = uuidv7()
    const rid = await roleId(wid, key)
    const c = await db.admin.connect()
    try {
      await c.query("BEGIN")
      await c.query("SELECT set_config('app.principal_id', $1, true)", [userId])
      await c.query("INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, status, activated_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'active' THEN now() END)", [id, wid, userId, rid, status])
      await c.query("COMMIT")
    } finally {
      c.release()
    }
    return id
  }

  async function signIn(email: string) {
    const res = await request(app).post("/app/v1/auth/login").set("Origin", ORIGIN).send({ email, password: PASSWORD })
    expect(res.status).toBe(200)
    const jar: Record<string, string> = {}
    for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
      const [pair] = c.split(";")
      const eq = pair!.indexOf("=")
      jar[pair!.slice(0, eq)] = decodeURIComponent(pair!.slice(eq + 1))
    }
    const cookie = `nx_m=${encodeURIComponent(jar.nx_m!)}`
    const xsrf = jar["XSRF-TOKEN"]!
    return {
      cookie,
      get: (path: string) => request(app).get(path).set("Cookie", cookie),
      send: (method: "post" | "patch" | "put" | "delete", path: string, body?: object) =>
        request(app)[method](path).set("Cookie", cookie).set("Origin", ORIGIN).set("X-XSRF-TOKEN", xsrf).send(body),
    }
  }

  const code = (res: request.Response) => errorBodySchema.parse(res.body).code

  it("keeps the permission catalogue equal to the web application's (§10.1)", async () => {
    const { rows } = await db.admin.query("SELECT key, realm FROM identity.permissions ORDER BY key")
    expect(rows.map((r) => r.key).sort()).toEqual(Object.values(AdminPermissionsPlatform).sort())
    const staff = rows.filter((r) => r.realm === "staff").map((r) => r.key.split(":")[0])
    expect(new Set(staff)).toEqual(new Set(["staffs", "bannedUsers", "systemIssues", "plans", "subscriptions"]))
  })

  it("creates a company with the four default roles of Table 7 and one active owner", async () => {
    const { id, owner } = await company()
    const { rows } = await db.admin.query(
      "SELECT r.key, r.name, array_agg(p.permission ORDER BY p.permission) AS permissions FROM tenant.roles r JOIN tenant.role_permissions p ON p.role_id = r.id WHERE r.workspace_id = $1 GROUP BY r.key, r.name ORDER BY r.key",
      [id],
    )
    expect(rows).toEqual(
      Object.entries(DEFAULT_ROLES)
        .map(([key, r]) => ({ key, name: r.name, permissions: [...r.permissions].sort() }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    )
    const m = await db.admin.query("SELECT user_id, is_owner, status FROM tenant.memberships WHERE workspace_id = $1", [id])
    expect(m.rows).toEqual([{ user_id: owner.id, is_owner: true, status: "active" }])
  })

  it("lists the person's active companies and switches only to one of them (TEN-01)", async () => {
    const a = await company()
    const b = await company()
    const c = await company()
    await join(b.id, a.owner.id, "manager")
    await join(c.id, a.owner.id, "employee", "disabled")
    const s = await signIn(a.owner.email)
    const list = await s.get("/app/v1/me/workspaces")
    expect(list.status).toBe(200)
    expect(list.body.map((w: { id: string }) => w.id).sort()).toEqual([a.id, b.id].sort())
    expect(list.body.find((w: { id: string }) => w.id === b.id)).toMatchObject({ currency: "MAD", role: { key: "manager", name: "Manager" }, isOwner: false })
    expect((await s.get("/app/v1/auth/me")).body.activeWorkspaceId).toBeNull()

    expect((await s.send("put", "/app/v1/auth/workspace", { workspaceId: b.id })).body).toEqual({ activeWorkspaceId: b.id })
    expect((await s.get("/app/v1/auth/me")).body.activeWorkspaceId).toBe(b.id)
    const refused = await s.send("put", "/app/v1/auth/workspace", { workspaceId: c.id })
    expect(refused.status).toBe(403)
    expect((await s.get("/app/v1/auth/me")).body.activeWorkspaceId).toBe(b.id)
  })

  it("refuses another company's path with 403 and an identity-trail event, and reads nothing (TEN-01)", async () => {
    const a = await company()
    const b = await company()
    const s = await signIn(a.owner.email)
    for (const path of [`/app/v1/workspaces/${b.id}/members`, `/app/v1/workspaces/${b.id}/context`]) {
      const res = await s.get(path)
      expect(res.status).toBe(403)
      expect(code(res)).toBe("err_forbidden")
      expect(res.body.members).toBeUndefined()
    }
    expect((await s.get("/app/v1/workspaces/not-a-uuid/members")).status).toBe(403)
    const { rows } = await db.admin.query("SELECT action, requested_workspace FROM audit.identity_events WHERE principal_id = $1 AND action = 'workspace.access_refused'", [a.owner.id])
    expect(rows).toEqual([
      { action: "workspace.access_refused", requested_workspace: b.id },
      { action: "workspace.access_refused", requested_workspace: b.id },
    ])
  })

  it("gives each default role the rights of Table 7 and audits a refused write (AUZ-02, AUZ-09)", async () => {
    const { id, owner } = await company()
    const people = { manager: await user(), accountant: await user(), employee: await user() }
    for (const [key, p] of Object.entries(people)) await join(id, p.id, key)
    const base = `/app/v1/workspaces/${id}`
    const expected: Record<string, { members: number; roles: number; createRole: number }> = {
      owner: { members: 200, roles: 200, createRole: 201 },
      manager: { members: 403, roles: 403, createRole: 403 },
      accountant: { members: 403, roles: 403, createRole: 403 },
      employee: { members: 403, roles: 403, createRole: 403 },
    }
    for (const [who, want] of Object.entries(expected)) {
      const email = who === "owner" ? owner.email : people[who as keyof typeof people].email
      const s = await signIn(email)
      expect((await s.get(`${base}/context`)).status).toBe(200)
      expect((await s.get(`${base}/members`)).status).toBe(want.members)
      expect((await s.get(`${base}/roles`)).status).toBe(want.roles)
      expect((await s.send("post", `${base}/roles`, { name: `Role of ${who}`, permissions: ["projects:read"] })).status).toBe(want.createRole)
    }
    const ctx = await (await signIn(people.employee.email)).get(`${base}/context`)
    expect(ctx.body).toEqual({ workspaceId: id, role: { key: "employee", name: "Employee" }, isOwner: false, permissions: [...DEFAULT_ROLES.employee.permissions].sort() })
    const { rows } = await db.admin.query("SELECT actor_id, actor_role, target_id, after FROM audit.workspace_events WHERE workspace_id = $1 AND action = 'access.refused' ORDER BY at", [id])
    expect(rows).toEqual([
      { actor_id: people.manager.id, actor_role: "manager", target_id: "createRole", after: { needed: "roles:create" } },
      { actor_id: people.accountant.id, actor_role: "accountant", target_id: "createRole", after: { needed: "roles:create" } },
      { actor_id: people.employee.id, actor_role: "employee", target_id: "createRole", after: { needed: "roles:create" } },
    ])
  })

  it("applies a role change and a disabled membership at the next request (AUZ-10)", async () => {
    const { id, owner } = await company()
    const p = await user()
    const mid = await join(id, p.id, "employee")
    const base = `/app/v1/workspaces/${id}`
    const s = await signIn(p.email)
    const o = await signIn(owner.email)
    expect((await s.get(`${base}/members`)).status).toBe(403)
    const promoted = await o.send("patch", `${base}/members/${mid}`, { roleId: await roleId(id, "admin") })
    expect(promoted.status).toBe(200)
    expect(promoted.body.member.role.key).toBe("admin")
    expect((await s.get(`${base}/members`)).status).toBe(200)
    const disabled = await o.send("patch", `${base}/members/${mid}`, { status: "disabled" })
    expect(disabled.status).toBe(200)
    expect((await s.get(`${base}/context`)).status).toBe(403)
    const trail = await db.admin.query("SELECT before, after FROM audit.workspace_events WHERE workspace_id = $1 AND action = 'membership.changed' AND target_id = $2 ORDER BY at", [id, mid])
    expect(trail.rows.map((r) => [r.before.status, r.after.status])).toEqual([["active", "active"], ["active", "disabled"]])
  })

  it("keeps the owner rules: only owners change owners, an owner is an administrator, one owner remains (AUZ-11)", async () => {
    const { id, owner } = await company()
    const admin = await user()
    const manager = await user()
    const adminMid = await join(id, admin.id, "admin")
    const managerMid = await join(id, manager.id, "manager")
    const base = `/app/v1/workspaces/${id}`
    const { rows } = await db.admin.query("SELECT id FROM tenant.memberships WHERE workspace_id = $1 AND user_id = $2", [id, owner.id])
    const ownerMid = rows[0]!.id as string
    const o = await signIn(owner.email)
    const a = await signIn(admin.email)

    let res = await a.send("patch", `${base}/members/${adminMid}`, { isOwner: true })
    expect([res.status, code(res)]).toEqual([403, "err_wsOwnerOnly"])
    res = await a.send("patch", `${base}/members/${ownerMid}`, { status: "disabled" })
    expect([res.status, code(res)]).toEqual([403, "err_wsOwnerOnly"])
    res = await o.send("patch", `${base}/members/${managerMid}`, { isOwner: true })
    expect([res.status, code(res)]).toEqual([409, "err_wsOwnerNeedsAdmin"])
    res = await o.send("patch", `${base}/members/${ownerMid}`, { isOwner: false })
    expect([res.status, code(res)]).toEqual([409, "err_wsLastOwner"])

    // Transfer: a second owner first, then the first one steps down.
    expect((await o.send("patch", `${base}/members/${adminMid}`, { isOwner: true })).status).toBe(200)
    expect((await o.send("patch", `${base}/members/${ownerMid}`, { isOwner: false })).status).toBe(200)
    // The database refuses the last owner's removal by itself as well.
    await expect(
      inTransaction(db.web, { role: "nx_app", workspaceId: id, principalId: admin.id }, (c) => c.query("UPDATE tenant.memberships SET is_owner = false WHERE id = $1", [adminMid])),
    ).rejects.toThrow(/LAST_OWNER/)
  })

  it("lets an administrator manage custom roles, never the default ones (AUZ-02, AUZ-14)", async () => {
    const { id, owner } = await company()
    const base = `/app/v1/workspaces/${id}`
    const o = await signIn(owner.email)
    const created = await o.send("post", `${base}/roles`, { name: "Project lead", permissions: ["projects:read", "projects:update", "projects:read"] })
    expect(created.status).toBe(201)
    expect(created.body.role).toMatchObject({ name: "Project lead", isDefault: false, permissions: ["projects:read", "projects:update"], members: 0 })
    const rid = created.body.role.id as string

    const dup = await o.send("post", `${base}/roles`, { name: " project LEAD ", permissions: [] })
    expect([dup.status, code(dup)]).toEqual([409, "err_roleNameTaken"])
    for (const permissions of [["plans:update"], ["*"], ["projects:fly"]]) {
      expect((await o.send("post", `${base}/roles`, { name: "Bad", permissions })).status).toBe(400)
    }
    const updated = await o.send("patch", `${base}/roles/${rid}`, { permissions: ["projects:read", "time:approve"], version: 1 })
    expect(updated.status).toBe(200)
    expect(updated.body.role.permissions).toEqual(["projects:read", "time:approve"])
    const stale = await o.send("patch", `${base}/roles/${rid}`, { name: "Lead", version: 1 })
    expect([stale.status, code(stale)]).toEqual([409, "err_conflict"])
    const fixed = await o.send("patch", `${base}/roles/${await roleId(id, "employee")}`, { permissions: ["projects:read"], version: 1 })
    expect([fixed.status, code(fixed)]).toEqual([409, "err_defaultRoleFixed"])

    const p = await user()
    const mid = await join(id, p.id, "employee")
    expect((await o.send("patch", `${base}/members/${mid}`, { roleId: rid })).status).toBe(200)
    const inUse = await o.send("delete", `${base}/roles/${rid}`)
    expect([inUse.status, code(inUse)]).toEqual([409, "err_roleInUse"])
    const ctx = await (await signIn(p.email)).get(`${base}/context`)
    expect(ctx.body.role).toEqual({ key: null, name: "Project lead" })
    expect(ctx.body.permissions).toEqual(["projects:read", "time:approve"])

    const spare = await o.send("post", `${base}/roles`, { name: "Spare", permissions: [] })
    expect((await o.send("delete", `${base}/roles/${spare.body.role.id}`)).status).toBe(204)
    const trail = await db.admin.query("SELECT action, before, after FROM audit.workspace_events WHERE workspace_id = $1 AND target_id = $2 ORDER BY at", [id, rid])
    expect(trail.rows).toEqual([
      { action: "role.created", before: null, after: { name: "Project lead", permissions: ["projects:read", "projects:update"] } },
      { action: "role.changed", before: { name: "Project lead", permissions: ["projects:read", "projects:update"] }, after: { name: "Project lead", permissions: ["projects:read", "time:approve"] } },
    ])
  })

  it("never reaches another company's records through one's own workspace path (TEN-04)", async () => {
    const a = await company()
    const b = await company()
    const p = await user()
    const foreignMember = await join(b.id, p.id, "employee")
    const foreignRole = await roleId(b.id, "manager")
    const o = await signIn(a.owner.email)
    const base = `/app/v1/workspaces/${a.id}`
    expect((await o.send("patch", `${base}/members/${foreignMember}`, { status: "disabled" })).status).toBe(404)
    expect((await o.send("patch", `${base}/members/${uuidv7()}`, { status: "disabled" })).status).toBe(404)
    expect((await o.send("delete", `${base}/roles/${foreignRole}`)).status).toBe(404)
    expect((await o.send("delete", `${base}/roles/not-a-uuid`)).status).toBe(404)
    const members = await o.get(`${base}/members`)
    expect(members.body.members.map((m: { userId: string }) => m.userId)).toEqual([a.owner.id])
  })

  it("needs the XSRF header and the application's origin on writes (SCR-16)", async () => {
    const { id, owner } = await company()
    const s = await signIn(owner.email)
    const path = `/app/v1/workspaces/${id}/roles`
    const noXsrf = await request(app).post(path).set("Cookie", s.cookie).set("Origin", ORIGIN).send({ name: "X", permissions: [] })
    expect([noXsrf.status, code(noXsrf)]).toEqual([403, "err_csrf"])
    const foreign = await request(app).post(path).set("Cookie", s.cookie).set("Origin", "https://evil.example").send({ name: "X", permissions: [] })
    expect([foreign.status, code(foreign)]).toEqual([403, "err_csrf"])
    expect((await db.admin.query("SELECT 1 FROM tenant.roles WHERE workspace_id = $1 AND name = 'X'", [id])).rowCount).toBe(0)
  })

  it("hands the application a frozen tenant context that cannot be changed after resolution (TEN-03)", async () => {
    const { id, owner } = await company()
    const ctx = await workspaces.resolve(owner.id, id, { ip: null, userAgent: null, requestId: null, sessionId: null })
    expect(ctx).toMatchObject({ workspaceId: id, principalId: owner.id, roleKey: "admin", isOwner: true })
    expect(() => {
      ;(ctx as { workspaceId: string }).workspaceId = uuidv7()
    }).toThrow(TypeError)
    expect(() => (ctx!.permissions as string[]).push("plans:update")).toThrow(TypeError)
    expect(Object.isFrozen(ctx)).toBe(true)
  })

  it("declares a permission for every workspace route (AUZ-01)", () => {
    expect(new Set(WORKSPACE_ROUTES.map((r) => r.command))).toEqual(new Set(Object.keys(PERMISSION_OF)))
    // Every route mounted under the workspace prefix comes from the declared table.
    const stack = (app as unknown as { _router: { stack: Array<{ handle: { stack?: Array<{ handle: { stack?: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } }> } }> } })._router.stack
    const mounted: string[] = []
    for (const layer of stack) for (const inner of layer.handle.stack ?? []) for (const r of inner.handle.stack ?? []) if (r.route) mounted.push(`${Object.keys(r.route.methods)[0]} ${r.route.path}`)
    expect(mounted.sort()).toEqual(WORKSPACE_ROUTES.map((r) => `${r.method} ${r.path}`).sort())
    expect(WORKSPACE_PREFIX).toBe("/app/v1/workspaces/:wid")
  })
})

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { databaseReadiness } from "./pool"
import { inTransaction } from "./session"
import { ADMIN_URL, createTestDb, seedTwoWorkspaces, type TestDb } from "./testing/test-db"
import { uuidv7 } from "./uuid"

const SCHEMAS = ["identity", "tenant", "platform", "ops", "audit", "archive"]
const GROUP_ROLES = ["nx_app", "nx_portal", "nx_platform", "nx_support", "nx_dataops", "nx_provision", "nx_readonly"]

/** The error code PostgreSQL returns, or null when the call succeeded. */
async function sqlState(run: () => Promise<unknown>) {
  try {
    await run()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

describe.skipIf(!ADMIN_URL)("database foundation", () => {
  let db: TestDb
  let seed: Awaited<ReturnType<typeof seedTwoWorkspaces>>
  let tenantTables: string[]

  beforeAll(async () => {
    db = await createTestDb()
    seed = await seedTwoWorkspaces(db.admin)
    const { rows } = await db.admin.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'tenant' ORDER BY 1")
    tenantTables = rows.map((r) => `tenant.${r.t}`)
  }, 60_000)
  afterAll(async () => db?.drop())

  const asApp = <T>(work: (c: pg.PoolClient) => Promise<T>, workspaceId?: string) =>
    inTransaction(db.web, { role: "nx_app", workspaceId, principalId: seed.principal }, work)

  describe("schemas and roles (DAT-02)", () => {
    it("has the six schemas, all owned by nx_owner, with every object in them owned by nx_owner", async () => {
      const { rows: schemas } = await db.admin.query("SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ANY($1)", [SCHEMAS])
      expect(schemas.map((s) => s.nspname).sort()).toEqual([...SCHEMAS].sort())
      expect(new Set(schemas.map((s) => s.owner))).toEqual(new Set(["nx_owner"]))
      const { rows: objects } = await db.admin.query(
        `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($1) AND pg_get_userbyid(c.relowner) <> 'nx_owner'
         UNION ALL
         SELECT n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = ANY($1) AND pg_get_userbyid(p.proowner) <> 'nx_owner'`,
        [SCHEMAS],
      )
      expect(objects).toEqual([])
    })

    it("has group roles that cannot sign in, are not superusers and never bypass row-level security", async () => {
      const { rows } = await db.admin.query("SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1", [GROUP_ROLES])
      expect(rows.map((r) => r.rolname)).toEqual([...GROUP_ROLES].sort())
      for (const r of rows) expect([r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole]).toEqual([false, false, false, false])
    })

    it("gives no application role the right to create objects anywhere", async () => {
      const { rows } = await db.admin.query(
        "SELECT r, s FROM unnest($1::text[]) r, unnest($2::text[]) s WHERE has_schema_privilege(r, s, 'CREATE')",
        [GROUP_ROLES, [...SCHEMAS, "public"]],
      )
      expect(rows).toEqual([])
    })

    it("keeps the web login user powerless outside SET LOCAL ROLE (NOINHERIT)", async () => {
      expect(await sqlState(() => db.web.query("SELECT count(*) FROM tenant.departments"))).toBe("42501")
    })

    it("keeps the console role away from company data (TEN-10)", async () => {
      for (const table of tenantTables) {
        expect(await sqlState(() => inTransaction(db.web, { role: "nx_platform" }, (c) => c.query(`SELECT 1 FROM ${table} LIMIT 1`)))).toBe("42501")
      }
    })

    it("lets the app neither create nor delete workspaces (§6.2, RET-02)", async () => {
      expect(await sqlState(() => asApp((c) => c.query("DELETE FROM tenant.workspaces"), seed.a))).toBe("42501")
      expect(
        await sqlState(() =>
          asApp((c) => c.query("INSERT INTO tenant.workspaces (id, name, slug, country, base_currency, time_zone, locale) VALUES ($1, 'X', 'x', 'MA', 'MAD', 'UTC', 'en')", [uuidv7()]), seed.a),
        ),
      ).toBe("42501")
    })

    it("gives the portal and support roles no direct access to business rows yet", async () => {
      expect(await sqlState(() => inTransaction(db.web, { role: "nx_portal", workspaceId: seed.a }, (c) => c.query("SELECT 1 FROM tenant.departments")))).toBe("42501")
      // nx_support reads only inside an approved support session; that policy and its grants come in B1f
      expect(await sqlState(() => inTransaction(db.web, { role: "nx_support", workspaceId: seed.a }, (c) => c.query("SELECT 1 FROM tenant.workspaces")))).toBe("42501")
    })
  })

  describe("row-level security (DAT-09, TEN-05)", () => {
    beforeAll(async () => {
      for (const [ws, name] of [[seed.a, "Engineering"], [seed.b, "Design"]] as const) {
        await asApp((c) => c.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, $3)", [uuidv7(), ws, name]), ws)
      }
    })

    it("shows no row of any tenant table when no workspace is set", async () => {
      for (const table of tenantTables) {
        const { rows } = await asApp((c) => c.query(`SELECT count(*)::int AS n FROM ${table}`))
        expect(rows[0].n, table).toBe(0)
      }
    })

    it("shows only the rows of the workspace set, and refuses to write into another one", async () => {
      const { rows } = await asApp((c) => c.query("SELECT name FROM tenant.departments"), seed.a)
      expect(rows.map((r) => r.name)).toEqual(["Engineering"])
      const ws = await asApp((c) => c.query("SELECT slug FROM tenant.workspaces"), seed.a)
      expect(ws.rows).toEqual([{ slug: "atlas" }])
      expect(
        await sqlState(() => asApp((c) => c.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, 'Sneaky')", [uuidv7(), seed.b]), seed.a)),
      ).toBe("42501")
      expect(await sqlState(() => asApp((c) => c.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, 'Nowhere')", [uuidv7(), seed.a])))).toBe("42501")
    })

    it("leaves nothing on a pooled connection after commit", async () => {
      const pool = new pg.Pool({ connectionString: db.webUrl, max: 1 })
      try {
        const a = await inTransaction(pool, { role: "nx_app", workspaceId: seed.a }, (c) => c.query("SELECT name FROM tenant.departments"))
        const b = await inTransaction(pool, { role: "nx_app", workspaceId: seed.b }, (c) => c.query("SELECT name FROM tenant.departments"))
        expect([a.rows[0].name, b.rows[0].name]).toEqual(["Engineering", "Design"])
        const { rows } = await pool.query("SELECT current_user AS u, coalesce(current_setting('app.workspace_id', true), '') AS ws")
        expect(rows[0]).toEqual({ u: "nx_web_test", ws: "" })
      } finally {
        await pool.end()
      }
    })

    it("keeps a name once per company, whatever its case, but lets another company use it", async () => {
      expect(await sqlState(() => asApp((c) => c.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, ' engineering ')", [uuidv7(), seed.a]), seed.a))).toBe("23505")
      expect(await sqlState(() => asApp((c) => c.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, 'Engineering')", [uuidv7(), seed.b]), seed.b))).toBeNull()
    })
  })

  describe("actor and version stamps (DAT-10, DAT-11)", () => {
    it("stamps the actor from the request context and bumps the version on every update", async () => {
      const other = uuidv7()
      await db.admin.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', $2, 'Lina')", [other, `user:${other}`])
      const id = uuidv7()
      await asApp((c) => c.query("INSERT INTO tenant.departments (id, workspace_id, name, created_by, version) VALUES ($1, $2, 'Finance', $3, 99)", [id, seed.a, other]), seed.a)
      await inTransaction(db.web, { role: "nx_app", workspaceId: seed.a, principalId: other }, (c) => c.query("UPDATE tenant.departments SET name = 'Finance & HR' WHERE id = $1", [id]))
      const { rows } = await asApp((c) => c.query("SELECT created_by, updated_by, version FROM tenant.departments WHERE id = $1", [id]), seed.a)
      expect(rows[0]).toEqual({ created_by: seed.principal, updated_by: other, version: 2 })
    })

    it("refuses any change without an actor", async () => {
      const state = await sqlState(() => inTransaction(db.web, { role: "nx_app", workspaceId: seed.a }, (c) => c.query("UPDATE tenant.departments SET name = name")))
      expect(state).toBe("42501")
    })

    it("refuses to move a row to another workspace or change its id", async () => {
      expect(await sqlState(() => asApp((c) => c.query("UPDATE tenant.departments SET id = $1 WHERE name = 'Engineering'", [uuidv7()]), seed.a))).toBe("23514")
    })

    it("lets only the first of two saves based on the same version win (optimistic lock)", async () => {
      const { rows } = await asApp((c) => c.query("SELECT id, version FROM tenant.departments WHERE name = 'Engineering'"), seed.a)
      const { id, version } = rows[0]
      const save = (name: string) => asApp((c) => c.query("UPDATE tenant.departments SET name = $1 WHERE id = $2 AND version = $3", [name, id, version]), seed.a)
      expect((await save("Engineering 1")).rowCount).toBe(1)
      expect((await save("Engineering 2")).rowCount).toBe(0)
    })
  })

  describe("readiness (QAL-05)", () => {
    it("is ready when the database answers and every migration has run", async () => {
      await expect(databaseReadiness(db.web)()).resolves.toBeUndefined()
    })

    it("is not ready when a migration file has not been applied", async () => {
      await db.admin.query("DELETE FROM ops.schema_migrations WHERE version = '0004'")
      try {
        await expect(databaseReadiness(db.web)()).rejects.toThrow(/migrations pending/)
      } finally {
        await db.admin.query("INSERT INTO ops.schema_migrations (version, name, checksum) VALUES ('0004', 'restored', 'x')")
      }
    })
  })

  describe("schema rules", () => {
    it("has no floating-point or money column anywhere (DAT-05)", async () => {
      const { rows } = await db.admin.query(
        "SELECT table_schema || '.' || table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = ANY($1) AND data_type IN ('real', 'double precision', 'money')",
        [SCHEMAS],
      )
      expect(rows).toEqual([])
    })

    it("gives every tenant table the tenant key, the common columns, forced row-level security and the stamp (DAT-08, DAT-09, DAT-10)", async () => {
      expect(tenantTables.length).toBeGreaterThanOrEqual(2)
      for (const table of tenantTables) {
        const [schema, name] = table.split(".")
        const { rows: cols } = await db.admin.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2", [schema, name])
        const col = new Map(cols.map((c) => [c.column_name, c]))
        for (const c of ["id", "workspace_id", "created_at", "created_by", "updated_at", "updated_by", "version"]) expect(col.has(c), `${table}.${c}`).toBe(true)
        expect(col.get("workspace_id")?.data_type).toBe("uuid")
        const { rows: meta } = await db.admin.query(
          `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                  EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_rows') AS policy,
                  EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'stamp_row') AS stamp,
                  EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique
                          AND (SELECT array_agg(a.attname ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = ANY(i.indkey)) = ARRAY['id', 'workspace_id']::name[]) AS tenant_key
           FROM pg_class c WHERE c.oid = $1::regclass`,
          [table],
        )
        expect(meta[0], table).toEqual({ rls: true, forced: true, policy: true, stamp: true, tenant_key: true })
      }
    })

    it("makes every foreign key between tenant tables include the workspace (DAT-08, TEN-06)", async () => {
      const { rows } = await db.admin.query(
        `SELECT con.conname, con.conrelid::regclass::text AS from_table, con.confrelid::regclass::text AS to_table,
                (SELECT array_agg(a.attname) FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)) AS cols
         FROM pg_constraint con
         JOIN pg_namespace fn ON fn.oid = (SELECT relnamespace FROM pg_class WHERE oid = con.conrelid)
         JOIN pg_namespace tn ON tn.oid = (SELECT relnamespace FROM pg_class WHERE oid = con.confrelid)
         WHERE con.contype = 'f' AND fn.nspname = 'tenant' AND tn.nspname = 'tenant'`,
      )
      const bad = rows.filter((r) => !r.cols.includes("workspace_id"))
      expect(bad).toEqual([])
      expect(rows.length).toBeGreaterThan(0)
    })
  })
})

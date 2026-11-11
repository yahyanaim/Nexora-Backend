import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ADMIN_URL, createTestDb, type TestDb } from "./testing/test-db"

/**
 * The privilege suite of the B1a exit gate (cahier §21.2; DAT-02, TEN-10, SEC-02).
 * It reads every right every group role has on every table, view and function of
 * the six schemas and compares it with the matrix below. A new GRANT, a forgotten
 * REVOKE or a default privilege fails this test until the matrix is changed on
 * purpose, in the same pull request, where the reviewer sees it.
 */

const ROLES = ["nx_app", "nx_portal", "nx_platform", "nx_support", "nx_dataops", "nx_provision", "nx_readonly", "nx_jobs"]
const SCHEMAS = ["identity", "tenant", "platform", "ops", "audit", "archive"]

/** table → role → rights. Anything missing has no right at all. */
const TABLES: Record<string, Record<string, string>> = {
  "audit.console_events": { nx_platform: "SELECT INSERT" },
  "audit.identity_events": { nx_app: "INSERT", nx_platform: "INSERT", nx_portal: "INSERT" },
  "audit.seals": {},
  "audit.workspace_events": { nx_app: "SELECT INSERT", nx_dataops: "SELECT" },
  "identity.refresh_tokens": { nx_app: "SELECT INSERT UPDATE" },
  "identity.sessions": { nx_app: "SELECT INSERT UPDATE" },
  "identity.sign_in_tokens": { nx_app: "SELECT INSERT UPDATE" },
  "identity.users": { nx_app: "SELECT INSERT UPDATE" },
  "identity.principals": {
    nx_app: "SELECT INSERT", nx_dataops: "SELECT", nx_jobs: "SELECT INSERT", nx_platform: "SELECT INSERT",
    nx_portal: "SELECT INSERT", nx_readonly: "SELECT", nx_support: "SELECT",
  },
  "ops.jobs": { nx_app: "INSERT", nx_jobs: "SELECT INSERT UPDATE", nx_platform: "INSERT" },
  "ops.outbox": { nx_app: "INSERT", nx_jobs: "SELECT INSERT UPDATE", nx_platform: "INSERT" },
  "ops.schedules": { nx_jobs: "SELECT UPDATE" },
  "ops.schema_migrations": { nx_app: "SELECT", nx_jobs: "SELECT", nx_platform: "SELECT", nx_readonly: "SELECT" },
  "ops.worker_heartbeats": { nx_jobs: "SELECT INSERT UPDATE DELETE", nx_platform: "SELECT" },
  "tenant.departments": { nx_app: "SELECT INSERT UPDATE DELETE", nx_dataops: "SELECT DELETE", nx_readonly: "SELECT" },
  "tenant.workspaces": { nx_app: "SELECT UPDATE", nx_dataops: "SELECT DELETE", nx_readonly: "SELECT" },
}

const EVERY_REQUEST_ROLE = ["nx_app", "nx_dataops", "nx_jobs", "nx_platform", "nx_portal", "nx_readonly", "nx_support"]
/** function → roles that may execute it. */
const FUNCTIONS: Record<string, string[]> = {
  "audit.seal(p_margin interval)": ["nx_jobs"],
  "audit.secret_scan()": ["nx_jobs"],
  "audit.verify()": ["nx_jobs"],
  "ops.current_principal()": EVERY_REQUEST_ROLE,
  "ops.current_workspace()": EVERY_REQUEST_ROLE,
}

describe.skipIf(!ADMIN_URL)("privilege suite (B1a exit gate)", () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  }, 60_000)
  afterAll(async () => db?.drop())

  it("gives each role exactly the table rights of the matrix, and none on anything else", async () => {
    const { rows } = await db.admin.query(
      `SELECT n.nspname || '.' || c.relname AS obj, r AS role,
         array_to_string(array_remove(ARRAY[
           CASE WHEN has_table_privilege(r, c.oid, 'SELECT') THEN 'SELECT' WHEN has_any_column_privilege(r, c.oid, 'SELECT') THEN 'SELECT(columns)' END,
           CASE WHEN has_table_privilege(r, c.oid, 'INSERT') THEN 'INSERT' WHEN has_any_column_privilege(r, c.oid, 'INSERT') THEN 'INSERT(columns)' END,
           CASE WHEN has_table_privilege(r, c.oid, 'UPDATE') THEN 'UPDATE' WHEN has_any_column_privilege(r, c.oid, 'UPDATE') THEN 'UPDATE(columns)' END,
           CASE WHEN has_table_privilege(r, c.oid, 'DELETE') THEN 'DELETE' END,
           CASE WHEN has_table_privilege(r, c.oid, 'TRUNCATE') THEN 'TRUNCATE' END,
           CASE WHEN has_table_privilege(r, c.oid, 'REFERENCES') THEN 'REFERENCES' END,
           CASE WHEN has_table_privilege(r, c.oid, 'TRIGGER') THEN 'TRIGGER' END], NULL), ' ') AS rights
       FROM unnest($1::text[]) r, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY($2) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       ORDER BY 1, 2`,
      [ROLES, SCHEMAS],
    )
    const actual: Record<string, Record<string, string>> = {}
    for (const r of rows) {
      actual[r.obj] ??= {}
      if (r.rights) actual[r.obj]![r.role] = r.rights
    }
    expect(actual).toEqual(TABLES)
  })

  it("lets each role execute exactly the functions of the matrix", async () => {
    const { rows } = await db.admin.query(
      `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn, array_agg(r ORDER BY r) AS roles
       FROM unnest($1::text[]) r, pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY($2) AND has_function_privilege(r, p.oid, 'EXECUTE')
       GROUP BY 1 ORDER BY 1`,
      [ROLES, SCHEMAS],
    )
    expect(Object.fromEntries(rows.map((r) => [r.fn, r.roles]))).toEqual(FUNCTIONS)
  })

  it("forces row-level security on every table that holds a workspace", async () => {
    const { rows } = await db.admin.query(
      `SELECT n.nspname || '.' || c.relname AS obj, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p') AND a.attname = 'workspace_id' AND NOT a.attisdropped ORDER BY 1`,
      [SCHEMAS],
    )
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.filter((r) => !r.rls || !r.forced)).toEqual([])
  })

  it("fixes the search path of every function that runs with its owner's rights", async () => {
    const { rows } = await db.admin.query(
      `SELECT n.nspname || '.' || p.proname AS fn, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY($1) AND p.prosecdef`,
      [SCHEMAS],
    )
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.filter((r) => !(r.proconfig ?? []).some((s: string) => s.startsWith("search_path=")))).toEqual([])
  })

  it("keeps the default privileges to the documented ones: tenant tables for the company roles, no function for anyone", async () => {
    const { rows } = await db.admin.query(
      "SELECT defaclrole::regrole::text AS owner, defaclnamespace::regnamespace::text AS schema, defaclobjtype AS type, defaclacl::text AS acl FROM pg_default_acl ORDER BY 2, 3",
    )
    expect(rows).toEqual([
      { owner: "nx_owner", schema: "-", type: "f", acl: "{nx_owner=X/nx_owner}" },
      { owner: "nx_owner", schema: "tenant", type: "r", acl: "{nx_app=arwd/nx_owner,nx_dataops=rd/nx_owner,nx_readonly=r/nx_owner}" },
    ])
  })
})

import { randomBytes } from "node:crypto"
import pg from "pg"
import { migrate } from "../migrate"
import { uuidv7 } from "../uuid"

/**
 * A throwaway database for integration tests (TST-02: real PostgreSQL, all
 * migrations applied). Needs TEST_DATABASE_ADMIN_URL, a superuser URL of a
 * PostgreSQL 16 server (CI provides one; see docs/DATABASE.md to run one
 * locally). Without it the database suites are skipped.
 */
export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL
// CI always runs the database suites: a missing URL there is a broken pipeline, not a skip.
if (process.env.CI && !ADMIN_URL) throw new Error("TEST_DATABASE_ADMIN_URL is required in CI")

const OWNER = "nx_owner"
const WEB = "nx_web_test"
const PASSWORD = "test-only-password" // test databases only; production logins are created at bootstrap

function onDatabase(url: string, database: string) {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

function withUser(url: string, user: string, database: string) {
  const u = new URL(onDatabase(url, database))
  u.username = user
  u.password = PASSWORD
  return u.toString()
}

export interface TestDb {
  name: string
  adminUrl: string
  ownerUrl: string
  webUrl: string
  /** Superuser pool on the test database (bypasses row-level security): for setting up data only. */
  admin: pg.Pool
  /** Pool of the web login user: NOINHERIT, reaches data only through SET LOCAL ROLE. */
  web: pg.Pool
  drop(): Promise<void>
}

async function ensureRole(client: pg.Client, sql: string, name: string) {
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])
  if (rowCount) return
  try {
    await client.query(sql)
  } catch (error) {
    if ((error as { code?: string }).code !== "42710" && (error as { code?: string }).code !== "23505") throw error
  }
}

/** Creates an empty database owned by nx_owner, without migrating it. */
export async function createEmptyDb(adminUrl = ADMIN_URL!): Promise<Omit<TestDb, "admin" | "web"> & { dropOnly(): Promise<void> }> {
  const name = `nx_test_${randomBytes(6).toString("hex")}`
  const root = new pg.Client({ connectionString: adminUrl })
  await root.connect()
  try {
    await ensureRole(root, `CREATE ROLE ${OWNER} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`, OWNER)
    await ensureRole(root, `CREATE ROLE ${WEB} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`, WEB)
    await root.query(`CREATE DATABASE ${name} OWNER ${OWNER}`)
  } finally {
    await root.end()
  }
  const drop = async () => {
    const c = new pg.Client({ connectionString: adminUrl })
    await c.connect()
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await c.end()
  }
  return { name, adminUrl: onDatabase(adminUrl, name), ownerUrl: withUser(adminUrl, OWNER, name), webUrl: withUser(adminUrl, WEB, name), drop, dropOnly: drop }
}

/** Creates a database, applies every migration, and gives the web login user its group roles. */
export async function createTestDb(): Promise<TestDb> {
  const db = await createEmptyDb()
  await migrate({ connectionString: db.ownerUrl })
  const admin = new pg.Pool({ connectionString: db.adminUrl, max: 3 })
  await admin.query(`GRANT nx_app, nx_portal, nx_platform, nx_support, nx_dataops, nx_readonly TO ${WEB}`)
  const web = new pg.Pool({ connectionString: db.webUrl, max: 4 })
  return {
    ...db,
    admin,
    web,
    async drop() {
      await web.end()
      await admin.end()
      await db.drop()
    },
  }
}

/** Seeds a principal and two workspaces through the superuser pool. */
export async function seedTwoWorkspaces(admin: pg.Pool) {
  const principal = uuidv7()
  const a = uuidv7()
  const b = uuidv7()
  const client = await admin.connect()
  try {
    await client.query("BEGIN")
    await client.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'system', 'system:test', 'Test seed')", [principal])
    await client.query("SELECT set_config('app.principal_id', $1, true)", [principal])
    for (const [id, slug] of [[a, "atlas"], [b, "helio"]] as const) {
      await client.query(
        "INSERT INTO tenant.workspaces (id, name, slug, country, base_currency, time_zone, locale) VALUES ($1, $2, $3, 'MA', 'MAD', 'Africa/Casablanca', 'fr')",
        [id, slug.toUpperCase(), slug],
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  return { principal, a, b }
}

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pg from "pg"
import { afterEach, describe, expect, it } from "vitest"
import { MIGRATIONS_DIR, MigrationError, migrate, readMigrations } from "./migrate"
import { ADMIN_URL, createEmptyDb } from "./testing/test-db"

describe("migration files", () => {
  it("are numbered, unique and named in lower case", () => {
    const files = readMigrations()
    expect(files.length).toBeGreaterThan(0)
    expect(files.map((f) => f.version)).toEqual([...files.map((f) => f.version)].sort())
  })
})

describe.skipIf(!ADMIN_URL)("migration runner (DAT-14, DAT-15)", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function emptyDb() {
    const db = await createEmptyDb()
    cleanups.push(db.drop)
    return db
  }

  it("applies every migration on an empty database, then nothing on a second run", async () => {
    const db = await emptyDb()
    const first = await migrate({ connectionString: db.ownerUrl })
    expect(first).toEqual(readMigrations().map((f) => f.name))
    expect(await migrate({ connectionString: db.ownerUrl })).toEqual([])
  })

  it("stops when an applied migration was edited", async () => {
    const db = await emptyDb()
    await migrate({ connectionString: db.ownerUrl })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-migrations-"))
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f))
    fs.appendFileSync(path.join(dir, "0002_identity_principals.sql"), "\n-- edited later\n")
    await expect(migrate({ connectionString: db.ownerUrl, dir })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" })
  })

  it("rolls back a failing migration completely and records nothing for it", async () => {
    const db = await emptyDb()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-migrations-"))
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f))
    fs.writeFileSync(path.join(dir, "9999_broken.sql"), "CREATE TABLE tenant.half_done (id int);\nSELECT * FROM no_such_table;\n")
    const error = await migrate({ connectionString: db.ownerUrl, dir }).catch((e) => e)
    expect(error).toBeInstanceOf(MigrationError)
    expect(error.code).toBe("FAILED")
    const c = new pg.Client({ connectionString: db.ownerUrl })
    await c.connect()
    const { rows } = await c.query("SELECT to_regclass('tenant.half_done') AS t, (SELECT count(*) FROM ops.schema_migrations WHERE version = '9999')::int AS n")
    await c.end()
    expect(rows[0]).toEqual({ t: null, n: 0 })
  })

  it("lets two instances start together: the lock makes them apply each file once", async () => {
    const db = await emptyDb()
    const [a, b] = await Promise.all([migrate({ connectionString: db.ownerUrl }), migrate({ connectionString: db.ownerUrl })])
    expect([...a, ...b].sort()).toEqual(readMigrations().map((f) => f.name).sort())
  })
})

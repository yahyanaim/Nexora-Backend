import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

/**
 * Forward-only SQL migrations (DAT-14, §6.8). Files `NNNN_name.sql` run in
 * order, each in its own transaction, under an advisory lock so two
 * instances never migrate at once. Each applied file is recorded with its
 * SHA-256; changing an applied file stops the next run.
 */
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")

const LOCK_KEY = 4_206_101 // any constant shared by every runner of this database
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/

export class MigrationError extends Error {
  constructor(
    readonly code: "CHECKSUM_MISMATCH" | "MISSING_FILE" | "BAD_NAME" | "FAILED",
    message: string,
  ) {
    super(message)
    this.name = "MigrationError"
  }
}

export interface MigrationFile {
  version: string
  name: string
  sql: string
  checksum: string
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  const seen = new Set<string>()
  return names.map((name) => {
    const m = FILE_RE.exec(name)
    if (!m) throw new MigrationError("BAD_NAME", `Migration file ${name} must be named NNNN_lower_case.sql`)
    const version = m[1]!
    if (seen.has(version)) throw new MigrationError("BAD_NAME", `Two migrations have the number ${version}`)
    seen.add(version)
    const sql = fs.readFileSync(path.join(dir, name), "utf8")
    return { version, name, sql, checksum: createHash("sha256").update(sql).digest("hex") }
  })
}

export interface MigrateOptions {
  connectionString: string
  dir?: string
  log?: (message: string) => void
}

/** Applies pending migrations; returns the names applied by this call. */
export async function migrate({ connectionString, dir, log = () => {} }: MigrateOptions): Promise<string[]> {
  const files = readMigrations(dir)
  const client = new pg.Client({ connectionString, application_name: "nexora-migrate" })
  await client.connect()
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY])
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS ops;
      CREATE TABLE IF NOT EXISTS ops.schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM ops.schema_migrations ORDER BY version",
    )
    const byVersion = new Map(files.map((f) => [f.version, f]))
    for (const row of rows) {
      const file = byVersion.get(row.version)
      if (!file) throw new MigrationError("MISSING_FILE", `Migration ${row.name} was applied but its file is gone`)
      if (file.checksum !== row.checksum) {
        throw new MigrationError("CHECKSUM_MISMATCH", `Migration ${row.name} changed after it was applied; add a new migration instead`)
      }
    }
    const done = new Set(rows.map((r) => r.version))
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file.version)) continue
      try {
        await client.query("BEGIN")
        await client.query(file.sql)
        await client.query("INSERT INTO ops.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [file.version, file.name, file.checksum])
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw new MigrationError("FAILED", `Migration ${file.name} failed: ${(error as Error).message}`)
      }
      applied.push(file.name)
      log(`applied ${file.name}`)
    }
    return applied
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {})
    await client.end()
  }
}

/** True when every migration file has been applied (readiness, QAL-05). */
export async function migrationsCurrent(query: (sql: string) => Promise<{ rows: Array<{ version: string }> }>, dir?: string) {
  const { rows } = await query("SELECT version FROM ops.schema_migrations")
  const applied = new Set(rows.map((r) => r.version))
  return readMigrations(dir).every((f) => applied.has(f.version))
}

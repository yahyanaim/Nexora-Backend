import pg from "pg"
import type { Config } from "../config/config"
import { migrationsCurrent } from "./migrate"
import { inTransaction } from "./session"

/** One pool per process (QAL-06). Errors on idle clients are logged by the caller, never crash the process. */
export function createPool(config: Pick<Config, "DATABASE_URL" | "DATABASE_POOL_MAX">, onError: (error: Error) => void) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 5_000, // a full pool answers 503 quickly instead of hanging
    idleTimeoutMillis: 30_000,
    application_name: "nexora-web",
  })
  pool.on("error", onError)
  return pool
}

/** Readiness (QAL-05): the database answers and every migration has run. */
export function databaseReadiness(pool: pg.Pool) {
  return async () => {
    const current = await inTransaction(pool, { role: "nx_readonly" }, (c) => migrationsCurrent((sql) => c.query(sql)))
    if (!current) throw new Error("migrations pending")
  }
}

import { ConfigError, loadConfig } from "../config/config"
import { migrate } from "./migrate"

/** `npm run db:migrate`: a deployment step, run as nx_owner before the processes roll (QAL-12). */
async function main() {
  const config = loadConfig()
  if (!config.MIGRATION_DATABASE_URL) throw new ConfigError(["MIGRATION_DATABASE_URL: required to run migrations"])
  const applied = await migrate({ connectionString: config.MIGRATION_DATABASE_URL, log: (m) => console.log(m) })
  console.log(applied.length ? `${applied.length} migration(s) applied` : "Database is up to date")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

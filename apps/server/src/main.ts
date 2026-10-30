import pino from "pino"
import { ConfigError, loadConfig } from "./config/config"
import { createApp } from "./http/app"
import { createPool, databaseReadiness } from "./db/pool"

/** Web process entry point (ARC-05). The worker gets its own entry in phase B1a step 3. */
function main() {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
  const logger = pino({ level: config.LOG_LEVEL, base: { service: "nexora-web" } })
  const pool = config.DATABASE_URL ? createPool(config, (err) => logger.error({ err }, "idle database client failed")) : undefined
  const readiness = pool ? [databaseReadiness(pool)] : []
  const server = createApp({ config, logger, readiness }).listen(config.PORT, () => logger.info({ port: config.PORT }, "web process listening"))

  const stop = (signal: string) => {
    logger.info({ signal }, "stopping: no new requests, finishing current ones")
    server.close(() => {
      void (pool?.end() ?? Promise.resolve()).finally(() => process.exit(0))
    })
    setTimeout(() => process.exit(1), 20_000).unref() // QAL-13
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))
}

main()

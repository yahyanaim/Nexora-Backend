import { hostname } from "node:os"
import pino from "pino"
import { ConfigError, loadConfig } from "./config/config"
import { createPool } from "./db/pool"
import { jobHandlers, outboxRoutes } from "./jobs/registry"
import { Worker } from "./worker/worker"

/** Worker process entry point (§5: the same image as the web process, another command). */
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
  const logger = pino({ level: config.LOG_LEVEL, base: { service: "nexora-worker" } })
  if (!config.DATABASE_URL) {
    logger.fatal("DATABASE_URL is required by the worker")
    process.exit(1)
  }
  const pool = createPool(config, (err) => logger.error({ err }, "idle database client failed"), "nexora-worker")
  const worker = new Worker(pool, { id: `${hostname()}:${process.pid}`, handlers: jobHandlers, routes: outboxRoutes, logger })
  worker.start()
  logger.info({ jobs: Object.keys(jobHandlers), events: Object.keys(outboxRoutes) }, "worker started")

  const stop = (signal: string) => {
    logger.info({ signal }, "stopping: no new jobs, finishing the current one")
    void worker.stop(30_000).finally(() => pool.end().finally(() => process.exit(0))) // JOB-08
    setTimeout(() => process.exit(1), 35_000).unref()
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))
}

main()

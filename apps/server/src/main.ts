import { randomBytes } from "node:crypto"
import pino from "pino"
import { ConfigError, loadConfig } from "./config/config"
import { loggerOptions } from "./config/logging"
import { createPool, databaseReadiness } from "./db/pool"
import { createApp } from "./http/app"
import { createIdentity } from "./modules/identity/infrastructure/index"
import { createWorkspaces } from "./modules/workspace/infrastructure/index"

/** Web process entry point (ARC-05). The worker has its own: src/worker-main.ts. */
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
  const logger = pino(loggerOptions(config.LOG_LEVEL, "nexora-web"))
  const pool = config.DATABASE_URL ? createPool(config, (err) => logger.error({ err }, "idle database client failed")) : undefined
  const readiness = pool ? [databaseReadiness(pool)] : []
  // Production refuses to start without a strong SESSION_SECRET (config); elsewhere a random one per start is enough.
  const sessionSecret = config.SESSION_SECRET ?? randomBytes(32).toString("base64url")
  // Stored secrets need a key that survives restarts in production (config); elsewhere one per start is enough.
  const encryptionKey = config.ENCRYPTION_KEY ?? randomBytes(32).toString("base64url")
  const identity = pool ? createIdentity({ pool, sessionSecret, encryptionKey }) : undefined
  const auth = identity?.auth
  const workspaces = pool ? createWorkspaces({ pool }) : undefined
  const server = createApp({ config, logger, readiness, auth, secondFactor: identity?.secondFactor, workspaces }).listen(config.PORT, () => logger.info({ port: config.PORT }, "web process listening"))

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

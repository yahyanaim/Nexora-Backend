import pino from "pino"
import { ConfigError, loadConfig } from "./config/config"
import { createApp } from "./http/app"

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
  const server = createApp({ config, logger }).listen(config.PORT, () => logger.info({ port: config.PORT }, "web process listening"))

  const stop = (signal: string) => {
    logger.info({ signal }, "stopping: no new requests, finishing current ones")
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 20_000).unref() // QAL-13
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))
}

main()

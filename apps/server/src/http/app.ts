import { randomUUID } from "node:crypto"
import express, { type RequestHandler } from "express"
import type { Logger } from "pino"
import type { Config } from "../config/config"
import type { AuthService, SecondFactorService } from "../modules/identity/application/index"
import type { WorkspaceService } from "../modules/workspace/application/index"
import { accessLog } from "./access-log"
import { memberAuthRoutes } from "./auth-routes"
import { errorHandler } from "./error-body"
import { notFound } from "./errors"
import { workspaceRoutes } from "./workspace-routes"

declare module "express-serve-static-core" {
  interface Request {
    id: string
  }
}

export interface AppDeps {
  config: Readonly<Config>
  logger: Logger
  /** Readiness checks (database, storage, migrations) added by later phases (QAL-05). */
  readiness?: Array<() => Promise<void>>
  /** Sign-in and sessions (B1b); without it the auth routes are not mounted. */
  auth?: AuthService
  /** Second factor, step-up and passcode (B1b step 4); mounted with auth. */
  secondFactor?: SecondFactorService
  /** Workspaces, members and roles (B1b step 3); mounted with auth. */
  workspaces?: WorkspaceService
}

/** Builds the HTTP application. Steps 1 of the request chain (§5.5): id, size limit, headers. */
export function createApp({ config, logger, readiness = [], auth, secondFactor, workspaces }: AppDeps) {
  const app = express()
  app.disable("x-powered-by")
  // How many proxies stand in front (security plan G-7): the client address of logs and rate limits depends on it.
  app.set("trust proxy", config.TRUST_PROXY_HOPS)

  const requestId: RequestHandler = (req, res, next) => {
    const incoming = req.get("x-request-id")
    req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID()
    res.set("x-request-id", req.id)
    next()
  }
  const securityHeaders: RequestHandler = (_req, res, next) => {
    res.set({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
    })
    next()
  }
  app.use(requestId, securityHeaders, accessLog(logger), express.json({ limit: "1mb" }))

  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok" })
  })
  app.get("/health/ready", async (req, res) => {
    try {
      await Promise.all(readiness.map((check) => check()))
      res.json({ status: "ok" })
    } catch (error) {
      logger.warn({ requestId: req.id, err: error }, "readiness check failed")
      res.status(503).json({ status: "unavailable" })
    }
  })

  if (auth) {
    const cookies = { pathPrefix: config.COOKIE_PATH_PREFIX, secure: config.NODE_ENV === "production" || config.APP_ORIGIN.startsWith("https://") }
    const secondFactorRequired = workspaces ? (principalId: string) => workspaces.secondFactorRequired(principalId) : undefined
    app.use(memberAuthRoutes({ auth, secondFactor, secondFactorRequired, appOrigin: config.APP_ORIGIN, cookies }))
    if (workspaces) app.use(workspaceRoutes({ auth, workspaces, appOrigin: config.APP_ORIGIN }))
  }

  app.use((_req, _res, next) => next(notFound()))

  app.use(errorHandler(logger))
  return app
}

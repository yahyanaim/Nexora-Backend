import { randomUUID } from "node:crypto"
import express, { type ErrorRequestHandler, type RequestHandler } from "express"
import type { Logger } from "pino"
import type { Config } from "../config/config"
import { AppError, notFound } from "./errors"

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
}

/** Builds the HTTP application. Steps 1 of the request chain (§5.5): id, size limit, headers. */
export function createApp({ logger, readiness = [] }: AppDeps) {
  const app = express()
  app.disable("x-powered-by")
  app.set("trust proxy", 1)

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
  app.use(requestId, securityHeaders, express.json({ limit: "1mb" }))

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

  app.use((_req, _res, next) => next(notFound()))

  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ code: error.code, values: error.values, requestId: req.id })
      return
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ code: "err_bodyTooLarge", values: {}, requestId: req.id })
      return
    }
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ code: "err_badRequest", values: {}, requestId: req.id })
      return
    }
    logger.error({ requestId: req.id, err: error }, "unhandled error")
    res.status(500).json({ code: "err_internal", values: {}, requestId: req.id })
  }
  app.use(errors)
  return app
}

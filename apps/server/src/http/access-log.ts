import type { RequestHandler } from "express"
import type { Logger } from "pino"

/**
 * One log line per request (QAL-07, audit M-5): request id, method, path
 * without its query, status, duration, and the principal and realm once a
 * session is known. Never a cookie, a header value, a body or a query string
 * (security plan G-6).
 */
export function accessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint()
    res.on("finish", () => {
      logger.info(
        {
          requestId: req.id,
          method: req.method,
          path: req.originalUrl.split("?")[0],
          status: res.statusCode,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          principalId: req.session?.principalId,
          realm: req.session?.realm,
        },
        "request",
      )
    })
    next()
  }
}


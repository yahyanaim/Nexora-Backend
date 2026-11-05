import type { ErrorRequestHandler } from "express"
import type { Logger } from "pino"
import { z } from "zod"
import { AppError } from "./errors"

/**
 * The one error body of the API (cahier des charges ARC-08, decision E1,
 * API contract §2): a catalogue code, the values that fill its translation,
 * the request id (equal to the X-Request-Id header) and, optionally, an
 * English fallback. A validation error names the field in values.field.
 */
export const errorBodySchema = z.strictObject({
  code: z.string().regex(/^err_[A-Za-z0-9]+$/),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
  requestId: z.string().min(1),
  message: z.string().optional(),
})

export type ErrorBody = z.infer<typeof errorBodySchema>

export function errorBody(code: string, requestId: string, values: Record<string, string | number> = {}): ErrorBody {
  return { code, values, requestId }
}

/** Turns every error into the error body; never a sentence, a stack trace or SQL (SCR-04). */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (error instanceof AppError) {
      res.status(error.status).json(errorBody(error.code, req.id, error.values))
      return
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json(errorBody("err_bodyTooLarge", req.id))
      return
    }
    if (error?.type === "entity.parse.failed") {
      res.status(400).json(errorBody("err_badRequest", req.id))
      return
    }
    logger.error({ requestId: req.id, err: error }, "unhandled error")
    res.status(500).json(errorBody("err_internal", req.id))
  }
}

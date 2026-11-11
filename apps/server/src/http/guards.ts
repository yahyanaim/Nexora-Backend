import { createHash, timingSafeEqual } from "node:crypto"
import type { RequestHandler } from "express"
import type { AuthService, Realm, SessionContext } from "../modules/identity/application/index"
import { MEMBER_ACCESS_COOKIE, readCookie, XSRF_HEADER } from "./cookies"
import { AppError } from "./errors"

declare module "express-serve-static-core" {
  interface Request {
    /** The verified identity of the request, set by requireSession; frozen (TEN-03). */
    session?: SessionContext
  }
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"])
const ACCESS_COOKIE: Record<Realm, string> = { member: MEMBER_ACCESS_COOKIE, portal: "nx_p", staff: "nx_s" }

export const sessionEnded = () => new AppError(401, "err_sessionEnded")
export const csrfRefused = () => new AppError(403, "err_csrf")

/**
 * Writes must come from the application's own origin (SCR-16, §8.2 rule 4):
 * browsers always send `Origin` on a cross-site or same-site POST, so a missing
 * or foreign one is refused.
 */
export function requireOrigin(appOrigin: string): RequestHandler {
  const expected = new URL(appOrigin).origin
  return (req, _res, next) => {
    if (SAFE.has(req.method)) return next()
    next(req.get("origin") === expected ? undefined : csrfRefused())
  }
}

/** Loads and checks the session of the route's realm on every request (IAM-01, IAM-08). */
export function requireSession(auth: AuthService, realm: Realm): RequestHandler {
  return (req, _res, next) => {
    const token = readCookie(req, ACCESS_COOKIE[realm])
    if (!token) return next(sessionEnded())
    auth
      .authenticate(token, realm)
      .then((session) => {
        if (!session) return next(sessionEnded())
        req.session = session
        next()
      })
      .catch(next)
  }
}

/**
 * Double submit (SCR-16): on a write, the X-XSRF-TOKEN header must be the value
 * of the session's XSRF-TOKEN cookie, whose hash the session holds. Runs after
 * requireSession.
 */
export function requireXsrf(): RequestHandler {
  return (req, _res, next) => {
    if (SAFE.has(req.method)) return next()
    const header = req.get(XSRF_HEADER)
    const expected = req.session?.xsrfHash
    if (!header || !expected) return next(csrfRefused())
    const given = Buffer.from(createHash("sha256").update(header, "utf8").digest("hex"), "hex")
    const want = Buffer.from(expected, "hex")
    next(given.length === want.length && timingSafeEqual(given, want) ? undefined : csrfRefused())
  }
}

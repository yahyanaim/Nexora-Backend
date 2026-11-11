import { Router } from "express"
import { z } from "zod"
import type { AuthService, ClientInfo } from "../modules/identity/application/index"
import { clearMemberSessionCookies, type CookieSettings, MEMBER_REFRESH_COOKIE, readCookie, setMemberSessionCookies } from "./cookies"
import { AppError } from "./errors"
import { requireOrigin, requireSession, requireXsrf, sessionEnded } from "./guards"

/**
 * Sign-in for company members (cahier §8; IAM-01, IAM-04, IAM-07; API contract
 * §2), under `/app/v1/auth`. The answers never say whether an e-mail exists.
 */

const loginBody = z.strictObject({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
})

export function memberAuthRoutes(deps: { auth: AuthService; appOrigin: string; cookies: CookieSettings }) {
  const { auth, cookies } = deps
  const router = Router()
  const client = (req: import("express").Request): ClientInfo => ({ ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null, requestId: req.id })
  const origin = requireOrigin(deps.appOrigin)

  router.post("/app/v1/auth/login", origin, async (req, res, next) => {
    try {
      const body = loginBody.safeParse(req.body)
      // A malformed body is answered like wrong credentials: no hint about what was wrong.
      if (!body.success) throw new AppError(401, "err_invalidCredentials")
      const result = await auth.signIn({ ...body.data, realm: "member" }, client(req))
      if (!result.ok) {
        if (result.reason === "rate_limited") {
          res.set("Retry-After", String(result.retryAfterSeconds))
          throw new AppError(429, "err_tooManyRequests")
        }
        throw new AppError(401, "err_invalidCredentials")
      }
      setMemberSessionCookies(res, cookies, result.session)
      res.status(200).json({ user: result.session.user })
    } catch (error) {
      next(error)
    }
  })

  router.post("/app/v1/auth/refresh", origin, async (req, res, next) => {
    try {
      const token = readCookie(req, MEMBER_REFRESH_COOKIE)
      const issued = token ? await auth.refresh(token, client(req)) : null
      if (!issued) {
        clearMemberSessionCookies(res, cookies)
        throw sessionEnded()
      }
      setMemberSessionCookies(res, cookies, issued)
      res.status(200).json({ user: issued.user })
    } catch (error) {
      next(error)
    }
  })

  router.post("/app/v1/auth/logout", origin, requireSession(auth, "member"), requireXsrf(), async (req, res, next) => {
    try {
      await auth.signOut(req.session!.sessionId, client(req))
      clearMemberSessionCookies(res, cookies)
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  router.get("/app/v1/auth/me", requireSession(auth, "member"), (req, res) => {
    res.json({ user: req.session!.user })
  })

  return router
}

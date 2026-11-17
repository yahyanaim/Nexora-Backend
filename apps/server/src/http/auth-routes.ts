import { type Request, type RequestHandler, Router } from "express"
import { z } from "zod"
import { type AuthService, type ClientInfo, SecondFactorError, type SecondFactorRefusal, type SecondFactorService } from "../modules/identity/application/index"
import { clearMemberSessionCookies, type CookieSettings, MEMBER_REFRESH_COOKIE, readCookie, setMemberSessionCookies } from "./cookies"
import { AppError, notFound } from "./errors"
import { requireOrigin, requireSession, requireXsrf, sessionEnded } from "./guards"

/**
 * Sign-in for company members (cahier §8; IAM-01, IAM-04, IAM-05, IAM-06,
 * IAM-18; API contract §2, §4.1), under `/app/v1/auth` and `/app/v1/me`. The
 * answers never say whether an e-mail exists. Answers to a signed-in person's
 * own mistakes (a wrong code or password) are 400, so the client does not take
 * them for an ended session and refresh.
 */

const loginBody = z.strictObject({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
})
const challengeBody = z.strictObject({ challengeId: z.string().min(20).max(100), code: z.string().min(6).max(20) })
const codeBody = z.strictObject({ code: z.string().min(6).max(20) })
const enableBody = z.strictObject({ code: z.string().min(6).max(20), password: z.string().min(1).max(1024) })
const disableBody = z.strictObject({ password: z.string().min(1).max(1024), code: z.string().min(6).max(20) })
const passcodeBody = z.strictObject({ passcode: z.string().max(8), password: z.string().min(1).max(1024) })
const unlockBody = z.strictObject({ passcode: z.string().max(8) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REFUSAL: Record<SecondFactorRefusal, () => AppError> = {
  already_enabled: () => new AppError(409, "err_conflict"),
  not_set_up: () => new AppError(400, "err_badRequest"),
  invalid_code: () => new AppError(400, "err_twoFactorInvalid"),
  required: () => new AppError(403, "err_twoFactorRequired"),
  invalid_password: () => new AppError(400, "err_invalidCredentials"),
  bad_passcode: () => new AppError(400, "err_badRequest"),
  rate_limited: () => new AppError(429, "err_tooManyRequests"),
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new AppError(400, "err_badRequest")
  return result.data
}

type Handler = (req: Request, res: import("express").Response) => Promise<void> | void
const handle =
  (fn: Handler): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res)
    } catch (error) {
      next(error instanceof SecondFactorError ? REFUSAL[error.code]() : error)
    }
  }

export function memberAuthRoutes(deps: {
  auth: AuthService
  secondFactor?: SecondFactorService
  /** Whether the person must keep a second factor (an owner, administrator or accountant somewhere; IAM-05). */
  secondFactorRequired?: (principalId: string) => Promise<boolean>
  appOrigin: string
  cookies: CookieSettings
}) {
  const { auth, cookies } = deps
  const router = Router()
  const client = (req: Request): ClientInfo => ({ ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null, requestId: req.id })
  const origin = requireOrigin(deps.appOrigin)
  const session = requireSession(auth, "member")
  const signedIn = [origin, session, requireXsrf()]

  router.post(
    "/app/v1/auth/login",
    origin,
    handle(async (req, res) => {
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
      // With a second factor, no session yet: the code comes next (IAM-05).
      if ("challengeId" in result) {
        res.status(200).json({ twoFactorRequired: true, challengeId: result.challengeId })
        return
      }
      setMemberSessionCookies(res, cookies, result.session)
      res.status(200).json({ user: result.session.user })
    }),
  )

  router.post(
    "/app/v1/auth/2fa/verify",
    origin,
    handle(async (req, res) => {
      const body = challengeBody.safeParse(req.body)
      if (!body.success) throw new AppError(401, "err_twoFactorInvalid")
      const result = await auth.verifyChallenge(body.data.challengeId, body.data.code.trim(), client(req))
      if (!result.ok) {
        if (result.reason === "rate_limited") {
          res.set("Retry-After", String(result.retryAfterSeconds))
          throw new AppError(429, "err_tooManyRequests")
        }
        throw new AppError(401, "err_twoFactorInvalid")
      }
      setMemberSessionCookies(res, cookies, result.session)
      res.status(200).json({ user: result.session.user })
    }),
  )

  router.post(
    "/app/v1/auth/refresh",
    origin,
    handle(async (req, res) => {
      const token = readCookie(req, MEMBER_REFRESH_COOKIE)
      const result = token ? await auth.refresh(token, client(req)) : ({ ok: false, reason: "ended" } as const)
      if (!result.ok) {
        // A locked session keeps its cookies: the lock screen sends the passcode with them (IAM-18).
        if (result.reason === "locked") throw new AppError(401, "err_sessionLocked")
        clearMemberSessionCookies(res, cookies)
        throw sessionEnded()
      }
      setMemberSessionCookies(res, cookies, result.session)
      res.status(200).json({ user: result.session.user })
    }),
  )

  router.post(
    "/app/v1/auth/passcode-verify",
    origin,
    handle(async (req, res) => {
      const { passcode } = parse(unlockBody, req.body)
      const token = readCookie(req, MEMBER_REFRESH_COOKIE)
      const result = token ? await auth.unlock(token, passcode, client(req)) : ({ valid: false, ended: true } as const)
      if (result.valid) {
        setMemberSessionCookies(res, cookies, result.session)
        res.status(200).json({ valid: true })
        return
      }
      if (result.ended) {
        clearMemberSessionCookies(res, cookies)
        throw sessionEnded()
      }
      res.status(200).json({ valid: false })
    }),
  )

  router.post(
    "/app/v1/auth/logout",
    ...signedIn,
    handle(async (req, res) => {
      await auth.signOut(req.session!.sessionId, client(req))
      clearMemberSessionCookies(res, cookies)
      res.status(204).end()
    }),
  )

  router.get("/app/v1/auth/me", session, (req, res) => {
    const s = req.session!
    res.json({ user: s.user, activeWorkspaceId: s.activeWorkspaceId, twoFactorEnabled: s.twoFactorEnabled })
  })

  // ---- The person's own sessions (§8.2 rule 5) ----

  router.get(
    "/app/v1/me/sessions",
    session,
    handle(async (req, res) => {
      res.json({ sessions: await auth.listSessions(req.session!) })
    }),
  )
  router.delete(
    "/app/v1/me/sessions/:id",
    ...signedIn,
    handle(async (req, res) => {
      const id = String(req.params.id)
      if (!UUID.test(id) || !(await auth.endSession(req.session!, id.toLowerCase(), client(req)))) throw notFound()
      res.status(204).end()
    }),
  )
  router.delete(
    "/app/v1/me/sessions",
    ...signedIn,
    handle(async (req, res) => {
      res.json({ ended: await auth.endOtherSessions(req.session!, client(req)) })
    }),
  )

  // ---- Second factor, step-up and passcode ----

  const factor = deps.secondFactor
  if (factor) {
    router.get(
      "/app/v1/auth/2fa",
      session,
      handle(async (req, res) => {
        const required = (await deps.secondFactorRequired?.(req.session!.principalId)) ?? false
        res.json({ ...(await factor.status(req.session!)), required })
      }),
    )
    router.post(
      "/app/v1/auth/2fa/setup",
      ...signedIn,
      handle(async (req, res) => {
        res.json(await factor.setup(req.session!, client(req)))
      }),
    )
    router.post(
      "/app/v1/auth/2fa/enable",
      ...signedIn,
      handle(async (req, res) => {
        const body = parse(enableBody, req.body)
        res.json(await factor.enable(req.session!, { code: body.code.trim(), password: body.password }, client(req)))
      }),
    )
    router.post(
      "/app/v1/auth/2fa/disable",
      ...signedIn,
      handle(async (req, res) => {
        const body = parse(disableBody, req.body)
        const required = (await deps.secondFactorRequired?.(req.session!.principalId)) ?? false
        await factor.disable(req.session!, { password: body.password, code: body.code.trim(), required }, client(req))
        res.status(204).end()
      }),
    )
    router.post(
      "/app/v1/auth/2fa/recovery-codes",
      ...signedIn,
      handle(async (req, res) => {
        res.json(await factor.regenerateCodes(req.session!, parse(codeBody, req.body).code.trim(), client(req)))
      }),
    )
    router.post(
      "/app/v1/auth/step-up",
      ...signedIn,
      handle(async (req, res) => {
        await factor.stepUp(req.session!, parse(codeBody, req.body).code.trim(), client(req))
        res.status(204).end()
      }),
    )
    router.put(
      "/app/v1/auth/passcode",
      ...signedIn,
      handle(async (req, res) => {
        await factor.setPasscode(req.session!, parse(passcodeBody, req.body), client(req))
        res.status(204).end()
      }),
    )
    router.delete(
      "/app/v1/auth/passcode",
      ...signedIn,
      handle(async (req, res) => {
        await factor.removePasscode(req.session!, client(req))
        res.status(204).end()
      }),
    )
  }

  return router
}

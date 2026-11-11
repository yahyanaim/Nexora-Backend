import type { CookieOptions, Request, Response } from "express"

/**
 * The cookies of the member realm (cahier Table 6, §8.2 rule 4; API contract
 * §2). The browser reaches the API under the app's origin at COOKIE_PATH_PREFIX
 * (e.g. /api), so each cookie is scoped to the paths that need it:
 *
 * | Cookie | Holds | Path | Readable by script |
 * |---|---|---|---|
 * | `nx_m` | the access token (15 minutes) | `<prefix>/app` | no |
 * | `nx_m_r` | the refresh token (session's absolute end) | `<prefix>/app/v1/auth` | no |
 * | `XSRF-TOKEN` | the double-submit value | `/` | yes, by design |
 */
export const MEMBER_ACCESS_COOKIE = "nx_m"
export const MEMBER_REFRESH_COOKIE = "nx_m_r"
export const XSRF_COOKIE = "XSRF-TOKEN"
export const XSRF_HEADER = "x-xsrf-token"

/** Reads one cookie from the Cookie header, without a parsing library. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.get("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim()
      try {
        return decodeURIComponent(value) || null
      } catch {
        return null
      }
    }
  }
  return null
}

export interface CookieSettings {
  pathPrefix: string
  /** False only in development over http://localhost. */
  secure: boolean
}

function base(settings: CookieSettings): CookieOptions {
  return { httpOnly: true, secure: settings.secure, sameSite: "lax" }
}

export function setMemberSessionCookies(
  res: Response,
  settings: CookieSettings,
  issued: { accessToken: string; accessExpiresAt: Date; refreshToken: string; refreshExpiresAt: Date; xsrfToken?: string },
) {
  res.cookie(MEMBER_ACCESS_COOKIE, issued.accessToken, { ...base(settings), path: `${settings.pathPrefix}/app`, expires: issued.accessExpiresAt })
  res.cookie(MEMBER_REFRESH_COOKIE, issued.refreshToken, { ...base(settings), path: `${settings.pathPrefix}/app/v1/auth`, expires: issued.refreshExpiresAt })
  if (issued.xsrfToken) res.cookie(XSRF_COOKIE, issued.xsrfToken, { secure: settings.secure, sameSite: "lax", httpOnly: false, path: "/", expires: issued.refreshExpiresAt })
}

export function clearMemberSessionCookies(res: Response, settings: CookieSettings) {
  res.clearCookie(MEMBER_ACCESS_COOKIE, { ...base(settings), path: `${settings.pathPrefix}/app` })
  res.clearCookie(MEMBER_REFRESH_COOKIE, { ...base(settings), path: `${settings.pathPrefix}/app/v1/auth` })
  res.clearCookie(XSRF_COOKIE, { secure: settings.secure, sameSite: "lax", path: "/" })
}

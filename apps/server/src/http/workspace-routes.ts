import { type Request, type RequestHandler, Router } from "express"
import { z } from "zod"
import type { AuthService } from "../modules/identity/application/index"
import { type RefusalCode, type RequestInfo, type TenantContext, type WorkspaceCommand, WorkspaceRefusal, type WorkspaceService } from "../modules/workspace/application/index"
import { AppError, notFound } from "./errors"
import { requireOrigin, requireSession, requireXsrf } from "./guards"

declare module "express-serve-static-core" {
  interface Request {
    /** The resolved tenant context, set by requireWorkspace; frozen (TEN-03). */
    tenant?: TenantContext
  }
}

/**
 * Workspaces, members and roles of the member realm (cahier §5.5 step 4, §9,
 * §10; TEN-01, AUZ-01). Records of a company live under
 * `/app/v1/workspaces/:wid/…`: the workspace is accepted only when the person
 * holds an active membership in it, otherwise 403 and an identity-trail event.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const WORKSPACE_PREFIX = "/app/v1/workspaces/:wid"

const REFUSAL: Record<RefusalCode, () => AppError> = {
  forbidden: () => new AppError(403, "err_forbidden"),
  not_found: () => notFound(),
  owner_only: () => new AppError(403, "err_wsOwnerOnly"),
  owner_needs_admin: () => new AppError(409, "err_wsOwnerNeedsAdmin"),
  last_owner: () => new AppError(409, "err_wsLastOwner"),
  default_role: () => new AppError(409, "err_defaultRoleFixed"),
  role_in_use: () => new AppError(409, "err_roleInUse"),
  name_taken: () => new AppError(409, "err_roleNameTaken"),
  conflict: () => new AppError(409, "err_conflict"),
  bad_input: () => new AppError(400, "err_badRequest"),
}

const asAppError = (error: unknown) => (error instanceof WorkspaceRefusal ? REFUSAL[error.code]() : error)

const info = (req: Request): RequestInfo => ({ ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null, requestId: req.id, sessionId: req.session?.sessionId ?? null })

const switchBody = z.strictObject({ workspaceId: z.string().regex(UUID) })
const memberBody = z.strictObject({
  roleId: z.string().regex(UUID).optional(),
  isOwner: z.boolean().optional(),
  status: z.enum(["active", "disabled"]).optional(),
})
const roleName = z.string().trim().min(1).max(60)
const permissionList = z.array(z.string().max(40)).max(100)
const newRoleBody = z.strictObject({ name: roleName, permissions: permissionList })
const roleBody = z.strictObject({ name: roleName.optional(), permissions: permissionList.optional(), version: z.number().int().positive() })

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new AppError(400, "err_badRequest")
  return result.data
}

/** Resolves the workspace of the path for the signed-in member (TEN-01). Runs after requireSession. */
export function requireWorkspace(workspaces: WorkspaceService): RequestHandler {
  return (req, _res, next) => {
    const wid = req.params.wid
    if (!wid || !UUID.test(wid)) return next(new AppError(403, "err_forbidden"))
    workspaces
      .resolve(req.session!.principalId, wid.toLowerCase(), info(req))
      .then((ctx) => {
        if (!ctx) return next(new AppError(403, "err_forbidden"))
        req.tenant = ctx
        next()
      })
      .catch(next)
  }
}

type Method = "get" | "post" | "patch" | "delete"

/**
 * Every route under the workspace prefix, with the command it runs. The command
 * declares its permission (PERMISSION_OF); a test checks that no route of the
 * router is missing from this table (AUZ-01).
 */
export const WORKSPACE_ROUTES: ReadonlyArray<{ method: Method; path: string; command: WorkspaceCommand }> = [
  { method: "get", path: "/context", command: "context" },
  { method: "get", path: "/members", command: "listMembers" },
  { method: "patch", path: "/members/:mid", command: "changeMember" },
  { method: "get", path: "/roles", command: "listRoles" },
  { method: "post", path: "/roles", command: "createRole" },
  { method: "patch", path: "/roles/:rid", command: "updateRole" },
  { method: "delete", path: "/roles/:rid", command: "deleteRole" },
]

export function workspaceRoutes(deps: { auth: AuthService; workspaces: WorkspaceService; appOrigin: string }) {
  const { auth, workspaces } = deps
  const router = Router()
  const origin = requireOrigin(deps.appOrigin)
  const session = requireSession(auth, "member")

  // The person's companies (API contract §4.1), most recently used first. Plan, features and seats come with B2.
  router.get("/app/v1/me/workspaces", session, async (req, res, next) => {
    try {
      const list = await workspaces.listMine(req.session!.principalId)
      res.json(list.map((w) => ({ id: w.workspaceId, name: w.name, slug: w.slug, currency: w.currency, role: { key: w.roleKey, name: w.roleName }, isOwner: w.isOwner })))
    } catch (error) {
      next(error)
    }
  })

  // Switching company: only to one where the person is an active member.
  router.put("/app/v1/auth/workspace", origin, session, requireXsrf(), async (req, res, next) => {
    try {
      const { workspaceId } = parse(switchBody, req.body)
      const ctx = await workspaces.resolve(req.session!.principalId, workspaceId.toLowerCase(), info(req))
      if (!ctx) throw new AppError(403, "err_forbidden")
      await auth.setActiveWorkspace(req.session!.sessionId, ctx.workspaceId)
      res.json({ activeWorkspaceId: ctx.workspaceId })
    } catch (error) {
      next(error)
    }
  })

  const inWorkspace = Router({ mergeParams: true })
  const handlers: Record<WorkspaceCommand, RequestHandler> = {
    context: (req, res) => {
      res.json(workspaces.context(req.tenant!))
    },
    listMembers: async (req, res) => {
      res.json({ members: await workspaces.listMembers(req.tenant!, info(req)) })
    },
    changeMember: async (req, res) => {
      const body = parse(memberBody, req.body)
      res.json({ member: await workspaces.changeMember(req.tenant!, String(req.params.mid), body, info(req)) })
    },
    listRoles: async (req, res) => {
      res.json({ roles: await workspaces.listRoles(req.tenant!, info(req)) })
    },
    createRole: async (req, res) => {
      res.status(201).json({ role: await workspaces.createRole(req.tenant!, parse(newRoleBody, req.body), info(req)) })
    },
    updateRole: async (req, res) => {
      res.json({ role: await workspaces.updateRole(req.tenant!, String(req.params.rid), parse(roleBody, req.body), info(req)) })
    },
    deleteRole: async (req, res) => {
      await workspaces.deleteRole(req.tenant!, String(req.params.rid), info(req))
      res.status(204).end()
    },
  }
  for (const route of WORKSPACE_ROUTES) {
    const handle = handlers[route.command]
    inWorkspace[route.method](route.path, async (req, res, next) => {
      try {
        // An id of the path that is not a UUID names no record of this company.
        for (const key of ["mid", "rid"] as const) if (req.params[key] !== undefined && !UUID.test(String(req.params[key]))) throw notFound()
        await handle(req, res, next)
      } catch (error) {
        next(asAppError(error))
      }
    })
  }
  router.use(WORKSPACE_PREFIX, origin, session, requireXsrf(), requireWorkspace(workspaces), inWorkspace)

  return router
}

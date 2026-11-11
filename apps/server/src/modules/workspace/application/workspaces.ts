import { uuidv7 } from "../../../db/uuid"
import { memberChangeProblem, type MembershipStatus } from "../domain/owner-rules"
import { DEFAULT_ROLES, grants, isMemberPermission, type Permission } from "../domain/permissions"
import type { MemberRecord, RoleRecord, WorkspaceStore, WorkspaceSummary, WorkspaceTransactions } from "../ports"

/**
 * Workspaces, memberships and roles (cahier §3.3, §9, §10; TEN-01, TEN-03,
 * AUZ-01, AUZ-02, AUZ-09, AUZ-10, AUZ-11, AUZ-14).
 *
 * - The workspace of a request is accepted only with an active membership;
 *   otherwise the refusal is written to the identity trail (TEN-01).
 * - The context is rebuilt from the database on every request, so a role
 *   change or a disabled membership applies at the next request (AUZ-10).
 * - Each command and query below declares its permission in PERMISSION_OF and
 *   checks it first; a refused write is written to the company's trail (AUZ-09).
 */

/** Any active member may run it. */
export const ANY_MEMBER = "member" as const
export type Need = Permission | typeof ANY_MEMBER

/** The permission of every command and query of this module (AUZ-01). */
export const PERMISSION_OF = Object.freeze({
  context: ANY_MEMBER,
  listMembers: "users:read",
  changeMember: "users:update",
  listRoles: "roles:read",
  createRole: "roles:create",
  updateRole: "roles:update",
  deleteRole: "roles:delete",
} as const satisfies Record<string, Need>)

export type WorkspaceCommand = keyof typeof PERMISSION_OF
const WRITES = new Set<WorkspaceCommand>(["changeMember", "createRole", "updateRole", "deleteRole"])

/** The resolved tenant context (TEN-03): frozen, built only here. */
export interface TenantContext {
  readonly workspaceId: string
  readonly membershipId: string
  readonly principalId: string
  readonly roleKey: string | null
  readonly roleName: string
  readonly isOwner: boolean
  readonly permissions: readonly string[]
}

export interface RequestInfo {
  ip: string | null
  userAgent: string | null
  requestId: string | null
  sessionId: string | null
}

export type RefusalCode = "forbidden" | "not_found" | "owner_only" | "owner_needs_admin" | "last_owner" | "default_role" | "role_in_use" | "name_taken" | "conflict" | "bad_input"

/** A refusal of this module, turned into an error code by the HTTP layer. */
export class WorkspaceRefusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code)
    this.name = "WorkspaceRefusal"
  }
}

export interface MemberView {
  id: string
  userId: string
  name: string
  email: string
  role: { id: string; key: string | null; name: string }
  isOwner: boolean
  status: MembershipStatus
  invitedAt: string
  activatedAt: string | null
  lastSeenAt: string | null
}

export interface RoleView {
  id: string
  key: string | null
  name: string
  isDefault: boolean
  status: "active" | "disabled"
  permissions: string[]
  members: number
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const memberView = (m: MemberRecord): MemberView => ({
  id: m.id,
  userId: m.userId,
  name: m.name,
  email: m.email,
  role: { id: m.roleId, key: m.roleKey, name: m.roleName },
  isOwner: m.isOwner,
  status: m.status,
  invitedAt: m.invitedAt.toISOString(),
  activatedAt: iso(m.activatedAt),
  lastSeenAt: iso(m.lastSeenAt),
})
const roleView = (r: RoleRecord): RoleView => ({
  id: r.id,
  key: r.key,
  name: r.name,
  isDefault: r.isDefault,
  status: r.status,
  permissions: [...r.permissions].sort(),
  members: r.members,
})
const memberAudit = (m: { roleId: string; isOwner: boolean; status: MembershipStatus }) => ({ roleId: m.roleId, isOwner: m.isOwner, status: m.status })

/** last_seen_at is written at most once an hour. */
const SEEN_EVERY_MS = 3_600_000

export interface WorkspaceService {
  listMine(principalId: string): Promise<WorkspaceSummary[]>
  /** The context of an active member, or null after writing the refusal. */
  resolve(principalId: string, workspaceId: string, info: RequestInfo): Promise<TenantContext | null>
  context(ctx: TenantContext): { workspaceId: string; role: { key: string | null; name: string }; isOwner: boolean; permissions: string[] }
  listMembers(ctx: TenantContext, info: RequestInfo): Promise<MemberView[]>
  changeMember(ctx: TenantContext, memberId: string, change: { roleId?: string; isOwner?: boolean; status?: "active" | "disabled" }, info: RequestInfo): Promise<MemberView>
  listRoles(ctx: TenantContext, info: RequestInfo): Promise<RoleView[]>
  createRole(ctx: TenantContext, input: { name: string; permissions: string[] }, info: RequestInfo): Promise<RoleView>
  updateRole(ctx: TenantContext, roleId: string, input: { name?: string; permissions?: string[]; version: number }, info: RequestInfo): Promise<RoleView>
  deleteRole(ctx: TenantContext, roleId: string, info: RequestInfo): Promise<void>
  /** Creates a company with the four default roles and its owner. */
  provision(input: { id?: string; name: string; slug: string; country: string; currency: string; timeZone: string; locale: string; ownerUserId: string }, actorId: string): Promise<string>
}

export function workspaceService(deps: { tx: WorkspaceTransactions; clock: { now(): Date } }): WorkspaceService {
  const { tx, clock } = deps

  /** The permission check every command and query starts with (AUZ-01, AUZ-09). */
  async function need(ctx: TenantContext, command: WorkspaceCommand, info: RequestInfo) {
    const needed = PERMISSION_OF[command]
    if (needed === ANY_MEMBER || grants(ctx.permissions, needed)) return
    if (WRITES.has(command)) {
      await tx.inWorkspace(ctx.workspaceId, ctx.principalId, (s) =>
        s.audit({ ...info, actorRole: actorRole(ctx), action: "access.refused", targetType: "command", targetId: command, after: { needed } }),
      )
    }
    throw new WorkspaceRefusal("forbidden")
  }

  const actorRole = (ctx: TenantContext) => (ctx.isOwner ? "owner" : (ctx.roleKey ?? "custom"))

  function cleanPermissions(list: string[]) {
    const unique = [...new Set(list)]
    if (!unique.every(isMemberPermission)) throw new WorkspaceRefusal("bad_input")
    return unique.sort()
  }

  async function loadRole(s: WorkspaceStore, roleId: string) {
    const role = await s.roleById(roleId)
    if (!role) throw new WorkspaceRefusal("not_found")
    return role
  }

  return {
    listMine: (principalId) => tx.myMemberships(principalId),

    async resolve(principalId, workspaceId, info) {
      const found = await tx.inWorkspace(workspaceId, principalId, async (s) => {
        const m = await s.membershipOf(principalId)
        if (!m || m.status !== "active") return null
        const permissions = await s.permissionsOfRole(m.roleId)
        const now = clock.now()
        if (!m.lastSeenAt || now.getTime() - m.lastSeenAt.getTime() >= SEEN_EVERY_MS) await s.touchMembership(m.id, now)
        return { m, permissions }
      })
      if (!found) {
        await tx.refused(principalId, { workspaceId, ...info })
        return null
      }
      return Object.freeze({
        workspaceId,
        membershipId: found.m.id,
        principalId,
        roleKey: found.m.roleKey,
        roleName: found.m.roleName,
        isOwner: found.m.isOwner,
        permissions: Object.freeze([...found.permissions].sort()),
      })
    },

    context(ctx) {
      return { workspaceId: ctx.workspaceId, role: { key: ctx.roleKey, name: ctx.roleName }, isOwner: ctx.isOwner, permissions: [...ctx.permissions] }
    },

    async listMembers(ctx, info) {
      await need(ctx, "listMembers", info)
      return tx.inWorkspace(ctx.workspaceId, ctx.principalId, async (s) => (await s.members()).map(memberView))
    },

    async changeMember(ctx, memberId, change, info) {
      await need(ctx, "changeMember", info)
      return tx.inWorkspace(ctx.workspaceId, ctx.principalId, async (s) => {
        const before = await s.memberById(memberId)
        if (!before) throw new WorkspaceRefusal("not_found")
        // No version check: the row is locked for the change, and the member's own visits move its version (last_seen_at).
        const role = change.roleId && change.roleId !== before.roleId ? await loadRole(s, change.roleId) : null
        if (role && role.status !== "active") throw new WorkspaceRefusal("bad_input")
        const after = {
          roleId: role?.id ?? before.roleId,
          roleKey: role ? role.key : before.roleKey,
          isOwner: change.isOwner ?? before.isOwner,
          status: change.status ?? before.status,
        }
        if (before.status === "invited" && change.status === "active") throw new WorkspaceRefusal("bad_input") // an invitation is accepted by the person
        const problem = memberChangeProblem({ actorIsOwner: ctx.isOwner, before, after, activeOwners: await s.activeOwnerCount() })
        if (problem === "OWNER_ONLY") throw new WorkspaceRefusal("owner_only")
        if (problem === "OWNER_NEEDS_ADMIN") throw new WorkspaceRefusal("owner_needs_admin")
        if (problem === "LAST_OWNER") throw new WorkspaceRefusal("last_owner")
        await s.updateMember(memberId, { roleId: after.roleId, isOwner: after.isOwner, status: after.status, activatedAt: before.activatedAt })
        await s.audit({ ...info, actorRole: actorRole(ctx), action: "membership.changed", targetType: "membership", targetId: memberId, targetLabel: before.email, before: memberAudit(before), after: memberAudit(after) })
        const updated = await s.memberById(memberId)
        return memberView(updated!)
      })
    },

    async listRoles(ctx, info) {
      await need(ctx, "listRoles", info)
      return tx.inWorkspace(ctx.workspaceId, ctx.principalId, async (s) => (await s.roles()).map(roleView))
    },

    async createRole(ctx, input, info) {
      await need(ctx, "createRole", info)
      const permissions = cleanPermissions(input.permissions)
      if (permissions.includes("*")) throw new WorkspaceRefusal("bad_input") // full rights stay with the administrator role
      return tx.inWorkspace(ctx.workspaceId, ctx.principalId, async (s) => {
        const id = uuidv7()
        if (!(await s.createRole({ id, name: input.name.trim(), permissions }))) throw new WorkspaceRefusal("name_taken")
        await s.audit({ ...info, actorRole: actorRole(ctx), action: "role.created", targetType: "role", targetId: id, targetLabel: input.name.trim(), after: { name: input.name.trim(), permissions } })
        return roleView((await s.roleById(id))!)
      })
    },

    async updateRole(ctx, roleId, input, info) {
      await need(ctx, "updateRole", info)
      const permissions = input.permissions ? cleanPermissions(input.permissions) : undefined
      if (permissions?.includes("*")) throw new WorkspaceRefusal("bad_input")
      return tx.inWorkspace(ctx.workspaceId, ctx.principalId, async (s) => {
        const before = await loadRole(s, roleId)
        // The default roles enforce Table 7 as written (AUZ-02); a company adds its own roles beside them.
        if (before.isDefault) throw new WorkspaceRefusal("default_role")
        if (before.version !== input.version) throw new WorkspaceRefusal("conflict")
        const next = { name: input.name?.trim() ?? before.name, permissions: permissions ?? before.permissions }
        if (!(await s.updateRole(roleId, next))) throw new WorkspaceRefusal("name_taken")
        await s.audit({ ...info, actorRole: actorRole(ctx), action: "role.changed", targetType: "role", targetId: roleId, targetLabel: next.name, before: { name: before.name, permissions: [...before.permissions].sort() }, after: next })
        return roleView((await s.roleById(roleId))!)
      })
    },

    async deleteRole(ctx, roleId, info) {
      await need(ctx, "deleteRole", info)
      await tx.inWorkspace(ctx.workspaceId, ctx.principalId, async (s) => {
        const role = await loadRole(s, roleId)
        if (role.isDefault) throw new WorkspaceRefusal("default_role")
        if (role.members > 0) throw new WorkspaceRefusal("role_in_use")
        await s.deleteRole(roleId)
        await s.audit({ ...info, actorRole: actorRole(ctx), action: "role.deleted", targetType: "role", targetId: roleId, targetLabel: role.name, before: { name: role.name, permissions: [...role.permissions].sort() } })
      })
    },

    async provision(input, actorId) {
      const id = input.id ?? uuidv7()
      await tx.provision({ ...input, id, roles: DEFAULT_ROLES }, actorId)
      return id
    },
  }
}

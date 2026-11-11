import { AdminPermissionsPlatform } from "@nexora/core/types/roles"
import { WORK_ROLE_PERMISSIONS, WorkRole } from "@nexora/core/types/workforce"
import { describe, expect, it } from "vitest"
import { memberChangeProblem, type MemberState } from "./owner-rules"
import { ALL_PERMISSIONS, DEFAULT_ROLES, grants, isMemberPermission, MEMBER_PERMISSIONS } from "./permissions"

describe("permission catalogue (§10.1)", () => {
  it("is the shared enum, with the console's areas kept out of company roles", () => {
    expect(ALL_PERMISSIONS).toEqual(Object.values(AdminPermissionsPlatform))
    expect(isMemberPermission("invoices:create")).toBe(true)
    expect(isMemberPermission("*")).toBe(true)
    for (const p of ["plans:update", "staffs:create", "subscriptions:read", "bannedUsers:read", "systemIssues:read", "projects:fly"]) expect(isMemberPermission(p)).toBe(false)
    expect(MEMBER_PERMISSIONS.length).toBe(ALL_PERMISSIONS.length - 18)
  })

  it("grants what is held, and everything to the administrator's *", () => {
    expect(grants(["projects:read"], "projects:read")).toBe(true)
    expect(grants(["projects:read"], "projects:update")).toBe(false)
    expect(grants(["*"], "costs:read")).toBe(true)
    expect(grants([], "projects:read")).toBe(false)
  })

  it("seeds the four default roles from the shared role table, without the portal contact (Table 7)", () => {
    expect(Object.keys(DEFAULT_ROLES)).toEqual(["admin", "manager", "accountant", "employee"])
    expect(DEFAULT_ROLES.manager.permissions).toEqual(WORK_ROLE_PERMISSIONS[WorkRole.MANAGER])
    expect(DEFAULT_ROLES.admin.permissions).toEqual(["*"])
    for (const r of Object.values(DEFAULT_ROLES)) expect(r.permissions.every(isMemberPermission)).toBe(true)
    expect(Object.isFrozen(DEFAULT_ROLES)).toBe(true)
  })
})

describe("owner rules (AUZ-11)", () => {
  const owner: MemberState = { isOwner: true, roleKey: "admin", status: "active" }
  const admin: MemberState = { isOwner: false, roleKey: "admin", status: "active" }
  const manager: MemberState = { isOwner: false, roleKey: "manager", status: "active" }

  it("lets only an owner change an owner, or make one", () => {
    expect(memberChangeProblem({ actorIsOwner: false, before: admin, after: { ...admin, isOwner: true }, activeOwners: 1 })).toBe("OWNER_ONLY")
    expect(memberChangeProblem({ actorIsOwner: false, before: owner, after: { ...owner, status: "disabled" }, activeOwners: 2 })).toBe("OWNER_ONLY")
    expect(memberChangeProblem({ actorIsOwner: true, before: admin, after: { ...admin, isOwner: true }, activeOwners: 1 })).toBeNull()
    // An administrator manages everyone else.
    expect(memberChangeProblem({ actorIsOwner: false, before: manager, after: { ...manager, status: "disabled" }, activeOwners: 1 })).toBeNull()
  })

  it("keeps an owner an administrator", () => {
    expect(memberChangeProblem({ actorIsOwner: true, before: manager, after: { ...manager, isOwner: true }, activeOwners: 1 })).toBe("OWNER_NEEDS_ADMIN")
    expect(memberChangeProblem({ actorIsOwner: true, before: owner, after: { ...owner, roleKey: "manager" }, activeOwners: 2 })).toBe("OWNER_NEEDS_ADMIN")
  })

  it("keeps one active owner", () => {
    expect(memberChangeProblem({ actorIsOwner: true, before: owner, after: { ...owner, isOwner: false }, activeOwners: 1 })).toBe("LAST_OWNER")
    expect(memberChangeProblem({ actorIsOwner: true, before: owner, after: { ...owner, status: "disabled" }, activeOwners: 1 })).toBe("LAST_OWNER")
    expect(memberChangeProblem({ actorIsOwner: true, before: owner, after: { ...owner, isOwner: false }, activeOwners: 2 })).toBeNull()
  })
})

import { AdminPermissionsPlatform } from "@nexora/core/types/roles"
import { WORK_ROLE_PERMISSIONS, WorkRole } from "@nexora/core/types/workforce"

/**
 * The permission catalogue (cahier §10.1, AUZ-02): the values of the web
 * application's `AdminPermissionsPlatform`. The database holds the same list
 * (`identity.permissions`) and a test keeps the two equal.
 */

export type Permission = `${AdminPermissionsPlatform}`

export const ALL_PERMISSIONS = Object.values(AdminPermissionsPlatform) as Permission[]

/** Areas of the Nexora console: staff permissions, never held by a company role. */
const STAFF_AREAS = new Set(["staffs", "bannedUsers", "systemIssues", "plans", "subscriptions"])

export const isStaffPermission = (p: string) => STAFF_AREAS.has(p.split(":")[0] ?? "")

/** What a company role may hold. */
export const MEMBER_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter((p) => !isStaffPermission(p))

const MEMBER_SET = new Set<string>(MEMBER_PERMISSIONS)
export const isMemberPermission = (p: string): p is Permission => MEMBER_SET.has(p)

/** True when the permissions held cover the one needed; `*` (administrator) covers all. */
export function grants(held: readonly string[], needed: Permission): boolean {
  return held.includes("*") || held.includes(needed)
}

/**
 * No escalation: a person may hand out, take away or edit only rights they
 * hold themselves. True when the permissions held cover every one of `asked`.
 */
export function covers(held: readonly string[], asked: readonly string[]): boolean {
  return held.includes("*") || asked.every((p) => p !== "*" && held.includes(p))
}

export type DefaultRoleKey = "admin" | "manager" | "accountant" | "employee"

/**
 * The four default roles a company starts with (Table 7), from the shared role
 * table, so the screens and the server grant the same rights. The client
 * contact is not a role: the portal realm fixes their rights.
 */
export const DEFAULT_ROLES: Readonly<Record<DefaultRoleKey, { name: string; permissions: readonly Permission[] }>> = Object.freeze({
  admin: { name: "Administrator", permissions: WORK_ROLE_PERMISSIONS[WorkRole.ADMIN] as Permission[] },
  manager: { name: "Manager", permissions: WORK_ROLE_PERMISSIONS[WorkRole.MANAGER] as Permission[] },
  accountant: { name: "Accountant", permissions: WORK_ROLE_PERMISSIONS[WorkRole.ACCOUNTANT] as Permission[] },
  employee: { name: "Employee", permissions: WORK_ROLE_PERMISSIONS[WorkRole.EMPLOYEE] as Permission[] },
})

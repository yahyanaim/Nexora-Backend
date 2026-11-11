/**
 * Owner rules (cahier §3.3, AUZ-11). An owner is an administrator whose
 * membership carries the owner flag. Only owners change owners, an owner keeps
 * the administrator role, and a company always keeps one active owner. The
 * database checks the last two again (triggers of migration 0011). Pure.
 */

export type MembershipStatus = "invited" | "active" | "disabled"

export interface MemberState {
  isOwner: boolean
  /** Key of the role: admin, manager, accountant, employee, or null for a custom role. */
  roleKey: string | null
  status: MembershipStatus
}

export type MemberChangeProblem = "OWNER_ONLY" | "OWNER_NEEDS_ADMIN" | "LAST_OWNER"

const activeOwner = (m: MemberState) => m.isOwner && m.status === "active"

export function memberChangeProblem(input: {
  actorIsOwner: boolean
  before: MemberState
  after: MemberState
  /** Active owners of the company before the change. */
  activeOwners: number
}): MemberChangeProblem | null {
  const { before, after } = input
  const touchesOwner = before.isOwner || after.isOwner
  const changed = before.isOwner !== after.isOwner || before.roleKey !== after.roleKey || before.status !== after.status
  if (touchesOwner && changed && !input.actorIsOwner) return "OWNER_ONLY"
  if (after.isOwner && after.roleKey !== "admin") return "OWNER_NEEDS_ADMIN"
  if (activeOwner(before) && !activeOwner(after) && input.activeOwners <= 1) return "LAST_OWNER"
  return null
}

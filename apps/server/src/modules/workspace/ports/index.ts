import type { MembershipStatus } from "../domain/owner-rules"

/** What the workspace module needs from the outside world (ARC-02). */

export interface WorkspaceSummary {
  workspaceId: string
  name: string
  slug: string
  currency: string
  membershipId: string
  roleKey: string | null
  roleName: string
  isOwner: boolean
}

/** A membership as the request resolution reads it, with its role's permissions. */
export interface MembershipRecord {
  id: string
  userId: string
  roleId: string
  roleKey: string | null
  roleName: string
  isOwner: boolean
  status: MembershipStatus
  lastSeenAt: Date | null
}

export interface MemberRecord extends MembershipRecord {
  name: string
  email: string
  invitedAt: Date
  activatedAt: Date | null
  version: number
}

export interface RoleRecord {
  id: string
  key: string | null
  name: string
  isDefault: boolean
  status: "active" | "disabled"
  permissions: string[]
  members: number
  version: number
}

/** An event of the company's audit trail (TRL-01); the actor is the request's principal. */
export interface WorkspaceEvent {
  actorRole: string
  action: string
  targetType: string
  targetId: string | null
  targetLabel?: string | null
  before?: unknown
  after?: unknown
  ip: string | null
  userAgent: string | null
  requestId: string | null
  sessionId: string | null
}

/** Everything a request reads or changes inside one workspace (row-level security set to it). */
export interface WorkspaceStore {
  membershipOf(userId: string): Promise<MembershipRecord | null>
  permissionsOfRole(roleId: string): Promise<string[]>
  touchMembership(id: string, at: Date): Promise<void>
  members(): Promise<MemberRecord[]>
  /** Locked until the transaction ends. */
  memberById(id: string): Promise<MemberRecord | null>
  activeOwnerCount(): Promise<number>
  updateMember(id: string, change: { roleId: string; isOwner: boolean; status: MembershipStatus; activatedAt: Date | null }): Promise<void>
  roles(): Promise<RoleRecord[]>
  /** Locked until the transaction ends. */
  roleById(id: string): Promise<RoleRecord | null>
  /** False when the name is used by another role of the company. */
  createRole(role: { id: string; name: string; permissions: string[] }): Promise<boolean>
  updateRole(id: string, change: { name: string; permissions: string[] }): Promise<boolean>
  deleteRole(id: string): Promise<void>
  audit(event: WorkspaceEvent): Promise<void>
}

/** The trail of refusals before a workspace is accepted (no workspace row is written in). */
export interface RefusedWorkspaceEvent {
  workspaceId: string
  ip: string | null
  userAgent: string | null
  requestId: string | null
  sessionId: string | null
}

export interface WorkspaceTransactions {
  /** A unit of work in one workspace, as the member realm, with the principal set for the stamps and the trail. */
  inWorkspace<T>(workspaceId: string, principalId: string, work: (store: WorkspaceStore) => Promise<T>): Promise<T>
  /** The principal's active memberships, across workspaces. */
  myMemberships(principalId: string): Promise<WorkspaceSummary[]>
  /** Writes `workspace.access_refused` to the identity trail. */
  refused(principalId: string, event: RefusedWorkspaceEvent): Promise<void>
  /** Creates a company with its default roles and its owner (provisioning role). */
  provision(input: ProvisionInput, actorId: string): Promise<void>
}

export interface ProvisionInput {
  id: string
  name: string
  slug: string
  country: string
  currency: string
  timeZone: string
  locale: string
  ownerUserId: string
  roles: Record<string, { name: string; permissions: readonly string[] }>
}

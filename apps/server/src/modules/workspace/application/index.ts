/**
 * The public interface of the workspace module (ARC-06): other modules and the
 * HTTP layer import only from here.
 */
export {
  ANY_MEMBER,
  PERMISSION_OF,
  WorkspaceRefusal,
  workspaceService,
  type MemberView,
  type Need,
  type RefusalCode,
  type RequestInfo,
  type RoleView,
  type TenantContext,
  type WorkspaceCommand,
  type WorkspaceService,
} from "./workspaces"
export { ALL_PERMISSIONS, DEFAULT_ROLES, MEMBER_PERMISSIONS, grants, isMemberPermission, isStaffPermission, type DefaultRoleKey, type Permission } from "../domain/permissions"
export { memberChangeProblem, type MemberChangeProblem, type MemberState, type MembershipStatus } from "../domain/owner-rules"
export type { WorkspaceSummary, WorkspaceTransactions } from "../ports"

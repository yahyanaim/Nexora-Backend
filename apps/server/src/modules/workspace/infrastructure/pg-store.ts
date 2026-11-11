import type pg from "pg"
import { inTransaction } from "../../../db/session"
import { uuidv7 } from "../../../db/uuid"
import type { MemberRecord, MembershipRecord, RoleRecord, WorkspaceStore, WorkspaceSummary, WorkspaceTransactions } from "../ports"

/**
 * The workspace store on PostgreSQL. Every unit of work runs as the member
 * realm (nx_app) with the workspace and principal set, so row-level security
 * limits it to that company; each query also names the workspace (TEN-04).
 * Queries are parameterised only (SCR-02).
 */

type Row = Record<string, unknown>
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string))

const MEMBERSHIP_COLUMNS = `m.id, m.user_id, m.role_id, r.key AS role_key, r.name AS role_name, m.is_owner, m.status, m.last_seen_at`
const MEMBER_COLUMNS = `${MEMBERSHIP_COLUMNS}, u.name, u.email, m.invited_at, m.activated_at, m.version`
const MEMBER_FROM = `FROM tenant.memberships m
  JOIN tenant.roles r ON r.workspace_id = m.workspace_id AND r.id = m.role_id
  JOIN identity.users u ON u.id = m.user_id`

function toMembership(r: Row): MembershipRecord {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    roleId: r.role_id as string,
    roleKey: (r.role_key as string | null) ?? null,
    roleName: r.role_name as string,
    isOwner: r.is_owner as boolean,
    status: r.status as MembershipRecord["status"],
    lastSeenAt: date(r.last_seen_at),
  }
}

function toMember(r: Row): MemberRecord {
  return { ...toMembership(r), name: r.name as string, email: r.email as string, invitedAt: date(r.invited_at)!, activatedAt: date(r.activated_at), version: r.version as number }
}

const ROLE_SELECT = `SELECT r.id, r.key, r.name, r.is_default, r.status, r.version,
    coalesce((SELECT array_agg(p.permission ORDER BY p.permission) FROM tenant.role_permissions p WHERE p.workspace_id = r.workspace_id AND p.role_id = r.id), '{}') AS permissions,
    (SELECT count(*)::int FROM tenant.memberships m WHERE m.workspace_id = r.workspace_id AND m.role_id = r.id AND m.status <> 'disabled') AS members
  FROM tenant.roles r`

function toRole(r: Row): RoleRecord {
  return {
    id: r.id as string,
    key: (r.key as string | null) ?? null,
    name: r.name as string,
    isDefault: r.is_default as boolean,
    status: r.status as RoleRecord["status"],
    permissions: r.permissions as string[],
    members: r.members as number,
    version: r.version as number,
  }
}

function store(c: pg.PoolClient, workspaceId: string): WorkspaceStore {
  const rows = async (sql: string, params: unknown[]) => (await c.query<Row>(sql, params)).rows
  const nameTaken = async (name: string, exceptId: string | null) =>
    (await rows("SELECT 1 FROM tenant.roles WHERE workspace_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND id IS DISTINCT FROM $3", [workspaceId, name, exceptId])).length > 0
  async function setPermissions(roleId: string, permissions: string[]) {
    await c.query("DELETE FROM tenant.role_permissions WHERE workspace_id = $1 AND role_id = $2 AND NOT (permission = ANY ($3::text[]))", [workspaceId, roleId, permissions])
    for (const permission of permissions) {
      await c.query(
        "INSERT INTO tenant.role_permissions (id, workspace_id, role_id, permission) VALUES ($1, $2, $3, $4) ON CONFLICT (role_id, permission) DO NOTHING",
        [uuidv7(), workspaceId, roleId, permission],
      )
    }
  }

  return {
    async membershipOf(userId) {
      const [r] = await rows(`SELECT ${MEMBERSHIP_COLUMNS} FROM tenant.memberships m JOIN tenant.roles r ON r.workspace_id = m.workspace_id AND r.id = m.role_id WHERE m.workspace_id = $1 AND m.user_id = $2`, [workspaceId, userId])
      return r ? toMembership(r) : null
    },
    async permissionsOfRole(roleId) {
      const list = await rows(
        "SELECT p.permission FROM tenant.role_permissions p JOIN tenant.roles r ON r.workspace_id = p.workspace_id AND r.id = p.role_id WHERE p.workspace_id = $1 AND p.role_id = $2 AND r.status = 'active'",
        [workspaceId, roleId],
      )
      return list.map((r) => r.permission as string)
    },
    async touchMembership(id, at) {
      await c.query("UPDATE tenant.memberships SET last_seen_at = $3 WHERE workspace_id = $1 AND id = $2", [workspaceId, id, at])
    },
    async members() {
      return (await rows(`SELECT ${MEMBER_COLUMNS} ${MEMBER_FROM} WHERE m.workspace_id = $1 ORDER BY u.name, u.email`, [workspaceId])).map(toMember)
    },
    async memberById(id) {
      const [r] = await rows(`SELECT ${MEMBER_COLUMNS} ${MEMBER_FROM} WHERE m.workspace_id = $1 AND m.id = $2 FOR UPDATE OF m`, [workspaceId, id])
      return r ? toMember(r) : null
    },
    async activeOwnerCount() {
      const [r] = await rows("SELECT count(*)::int AS n FROM tenant.memberships WHERE workspace_id = $1 AND is_owner AND status = 'active'", [workspaceId])
      return (r?.n as number) ?? 0
    },
    async updateMember(id, change) {
      await c.query("UPDATE tenant.memberships SET role_id = $3, is_owner = $4, status = $5, activated_at = $6 WHERE workspace_id = $1 AND id = $2", [
        workspaceId,
        id,
        change.roleId,
        change.isOwner,
        change.status,
        change.activatedAt,
      ])
    },
    async roles() {
      return (await rows(`${ROLE_SELECT} WHERE r.workspace_id = $1 ORDER BY r.key IS NULL, r.name`, [workspaceId])).map(toRole)
    },
    async roleById(id) {
      const [r] = await rows(`${ROLE_SELECT} WHERE r.workspace_id = $1 AND r.id = $2 FOR UPDATE OF r`, [workspaceId, id])
      return r ? toRole(r) : null
    },
    async createRole(role) {
      if (await nameTaken(role.name, null)) return false
      await c.query("INSERT INTO tenant.roles (id, workspace_id, name) VALUES ($1, $2, $3)", [role.id, workspaceId, role.name])
      await setPermissions(role.id, role.permissions)
      return true
    },
    async updateRole(id, change) {
      if (await nameTaken(change.name, id)) return false
      await c.query("UPDATE tenant.roles SET name = $3 WHERE workspace_id = $1 AND id = $2", [workspaceId, id, change.name])
      await setPermissions(id, change.permissions)
      return true
    },
    async deleteRole(id) {
      await c.query("DELETE FROM tenant.roles WHERE workspace_id = $1 AND id = $2", [workspaceId, id])
    },
    async audit(e) {
      await c.query(
        `INSERT INTO audit.workspace_events (id, workspace_id, actor_id, actor_role, action, target_type, target_id, target_label, before, after, ip, user_agent, request_id, session_id)
         VALUES ($1, $2, ops.current_principal(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          uuidv7(),
          workspaceId,
          e.actorRole,
          e.action,
          e.targetType,
          e.targetId,
          e.targetLabel ?? null,
          e.before === undefined ? null : JSON.stringify(e.before),
          e.after === undefined ? null : JSON.stringify(e.after),
          e.ip,
          e.userAgent,
          e.requestId,
          e.sessionId,
        ],
      )
    },
  }
}

export function pgWorkspaceTransactions(pool: pg.Pool): WorkspaceTransactions {
  return {
    inWorkspace: (workspaceId, principalId, work) => inTransaction(pool, { role: "nx_app", workspaceId, principalId }, (c) => work(store(c, workspaceId))),

    myMemberships: (principalId) =>
      inTransaction(pool, { role: "nx_app", principalId }, async (c) => {
        const { rows } = await c.query<Row>("SELECT workspace_id, name, slug, currency, membership_id, role_key, role_name, is_owner FROM tenant.my_memberships()")
        return rows.map(
          (r): WorkspaceSummary => ({
            workspaceId: r.workspace_id as string,
            name: r.name as string,
            slug: r.slug as string,
            currency: r.currency as string,
            membershipId: r.membership_id as string,
            roleKey: (r.role_key as string | null) ?? null,
            roleName: r.role_name as string,
            isOwner: r.is_owner as boolean,
          }),
        )
      }),

    refused: (principalId, e) =>
      inTransaction(pool, { role: "nx_app", principalId }, async (c) => {
        await c.query(
          `INSERT INTO audit.identity_events (id, principal_id, realm, action, ip, user_agent, request_id, session_id, requested_workspace)
           VALUES ($1, $2, 'member', 'workspace.access_refused', $3, $4, $5, $6, $7)`,
          [uuidv7(), principalId, e.ip, e.userAgent, e.requestId, e.sessionId, e.workspaceId],
        )
      }),

    provision: (input, actorId) =>
      inTransaction(pool, { role: "nx_provision", principalId: actorId }, async (c) => {
        await c.query("SELECT tenant.provision_workspace($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
          input.id,
          input.name,
          input.slug,
          input.country,
          input.currency,
          input.timeZone,
          input.locale,
          input.ownerUserId,
          JSON.stringify(input.roles),
        ])
      }),
  }
}

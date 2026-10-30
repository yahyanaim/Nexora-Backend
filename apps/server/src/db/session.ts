import type pg from "pg"

/**
 * The database side of a request (§5.5 step 7, TEN-05). Each transaction runs
 * under one group role and carries the workspace, principal and portal client
 * as SET LOCAL settings, so row-level security and the actor stamp see them
 * and a pooled connection keeps nothing after commit. The login user is
 * NOINHERIT: outside this function it can read nothing.
 */
export const DB_ROLES = ["nx_app", "nx_portal", "nx_platform", "nx_support", "nx_dataops", "nx_readonly"] as const
export type DbRole = (typeof DB_ROLES)[number]

export interface DbContext {
  role: DbRole
  workspaceId?: string
  principalId?: string
  clientId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function checkId(name: string, value: string | undefined) {
  if (value !== undefined && !UUID.test(value)) throw new TypeError(`${name} must be a UUID`)
  return value ?? ""
}

export async function inTransaction<T>(pool: pg.Pool, ctx: DbContext, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!DB_ROLES.includes(ctx.role)) throw new TypeError(`Unknown database role ${String(ctx.role)}`)
  const settings = [checkId("workspaceId", ctx.workspaceId), checkId("principalId", ctx.principalId), checkId("clientId", ctx.clientId)]
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`SET LOCAL ROLE ${ctx.role}`) // from the closed list above, never from input
    await client.query(
      "SELECT set_config('app.workspace_id', $1, true), set_config('app.principal_id', $2, true), set_config('app.client_id', $3, true)",
      settings,
    )
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

import type pg from "pg"

/**
 * The audit sealing jobs (TRL-05, audit M-4): `audit.seal` every 5 minutes,
 * `audit.verify` every day (Table 56). The work is done by the SQL functions
 * of migration 0007, which run as the owner; the worker only calls them as
 * nx_jobs, which can read no audit event itself.
 */

export interface SealBreak {
  trail: string
  workspaceId: string | null
  sealId: string
  problem: string
}

/** Seals the new events of every chain; returns the number of seals written. */
export async function sealAuditTrails(client: pg.PoolClient, marginSeconds = 120): Promise<number> {
  const { rows } = await client.query<{ written: number }>("SELECT audit.seal(make_interval(secs => $1)) AS written", [marginSeconds])
  return rows[0]?.written ?? 0
}

/** Recomputes every chain; returns each break found (none when the trails are intact). */
export async function verifyAuditTrails(client: pg.PoolClient): Promise<SealBreak[]> {
  const { rows } = await client.query("SELECT trail, workspace_id, seal_id, problem FROM audit.verify()")
  return rows.map((r) => ({ trail: r.trail, workspaceId: r.workspace_id, sealId: r.seal_id, problem: r.problem }))
}

/** Thrown by the verify job so the break stays visible: the job retries, then is dead and alerted (JOB-07). */
export class AuditChainBroken extends Error {
  constructor(readonly breaks: SealBreak[]) {
    const first = breaks.slice(0, 3).map((b) => `${b.trail}${b.workspaceId ? ` ${b.workspaceId}` : ""}: ${b.problem}`)
    super(`audit chain broken in ${breaks.length} place(s): ${first.join("; ")}`)
    this.name = "AuditChainBroken"
  }
}

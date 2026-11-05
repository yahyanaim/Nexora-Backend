import type pg from "pg"
import { inTransaction } from "../db/session"
import { uuidv7 } from "../db/uuid"

/** Jobs act as system:<job type> (JOB-03): the actor of their changes and audit events. */
const known = new Map<string, string>()

export async function systemPrincipal(pool: pg.Pool, jobType: string): Promise<string> {
  const reference = `system:${jobType}`
  const cached = known.get(reference)
  if (cached) return cached
  const id = await inTransaction(pool, { role: "nx_jobs" }, async (c) => {
    await c.query(
      `INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'system', $2, $3) ON CONFLICT (kind, reference) DO NOTHING`,
      [uuidv7(), reference, `Job ${jobType}`],
    )
    const { rows } = await c.query<{ id: string }>("SELECT id FROM identity.principals WHERE kind = 'system' AND reference = $1", [reference])
    return rows[0]!.id // inserted just above, or already there
  })
  known.set(reference, id)
  return id
}

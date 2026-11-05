import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { inTransaction } from "./session"
import { ADMIN_URL, createTestDb, seedTwoWorkspaces, type TestDb } from "./testing/test-db"
import { maskSecrets, runUnitOfWork, type UnitOfWorkContext } from "./unit-of-work"
import { uuidv7 } from "./uuid"

async function sqlState(run: () => Promise<unknown>) {
  try {
    await run()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

describe("maskSecrets (TRL-04)", () => {
  it("masks secret fields at any depth and keeps the rest", () => {
    expect(maskSecrets({ name: "Lina", password: "x", nested: { apiKey: "k", iban: "MA64…", rate: 450 }, list: [{ token: "t" }] })).toEqual({
      name: "Lina", password: "[redacted]", nested: { apiKey: "[redacted]", iban: "[redacted]", rate: 450 }, list: [{ token: "[redacted]" }],
    })
  })
})

describe.skipIf(!ADMIN_URL)("unit of work, audit trails and outbox", () => {
  let db: TestDb
  let seed: Awaited<ReturnType<typeof seedTwoWorkspaces>>
  let ctxA: UnitOfWorkContext

  beforeAll(async () => {
    db = await createTestDb()
    seed = await seedTwoWorkspaces(db.admin)
    ctxA = { role: "nx_app", workspaceId: seed.a, principalId: seed.principal, actor: { role: "admin", ip: "198.51.100.7", requestId: "req-1" } }
  }, 60_000)
  afterAll(async () => db?.drop())

  const count = async (sql: string, params: unknown[] = []) => Number((await db.admin.query(sql, params)).rows[0].n)

  it("writes the change, its audit event, its outbox event and its job in one transaction (TRX-01)", async () => {
    const id = uuidv7()
    await runUnitOfWork(db.web, ctxA, async (w) => {
      await w.client.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, 'Design')", [id, seed.a])
      await w.audit({ action: "department.created", targetType: "department", targetId: id, targetLabel: "Design", after: { name: "Design" } })
      await w.emit({ aggregateType: "department", aggregateId: id, eventType: "department.created", payload: { id } })
      await w.enqueue({ type: "summaries.refresh", dedupeKey: `dept:${id}` })
    })
    const { rows } = await db.admin.query("SELECT * FROM audit.workspace_events WHERE target_id = $1", [id])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ workspace_id: seed.a, actor_id: seed.principal, actor_role: "admin", action: "department.created", ip: "198.51.100.7", request_id: "req-1" })
    expect(await count("SELECT count(*) AS n FROM ops.outbox WHERE aggregate_id = $1 AND workspace_id = $2", [id, seed.a])).toBe(1)
    expect(await count("SELECT count(*) AS n FROM ops.jobs WHERE dedupe_key = $1 AND workspace_id = $2", [`dept:${id}`, seed.a])).toBe(1)
  })

  it("leaves no trace when the command fails after writing (TRX-01, TRL-01)", async () => {
    const id = uuidv7()
    await expect(runUnitOfWork(db.web, ctxA, async (w) => {
      await w.client.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, 'Ghost')", [id, seed.a])
      await w.audit({ action: "department.created", targetType: "department", targetId: id })
      await w.emit({ aggregateType: "department", aggregateId: id, eventType: "department.created" })
      throw new Error("fault injected before commit")
    })).rejects.toThrow("fault injected")
    expect(await count("SELECT count(*) AS n FROM tenant.departments WHERE id = $1", [id])).toBe(0)
    expect(await count("SELECT count(*) AS n FROM audit.workspace_events WHERE target_id = $1", [id])).toBe(0)
    expect(await count("SELECT count(*) AS n FROM ops.outbox WHERE aggregate_id = $1", [id])).toBe(0)
  })

  it("rolls the change back when its audit event cannot be written (TRL-01)", async () => {
    const id = uuidv7()
    await expect(runUnitOfWork(db.web, ctxA, async (w) => {
      await w.client.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, 'No audit')", [id, seed.a])
      await w.audit({ action: "Not A Valid Action", targetType: "department", targetId: id })
    })).rejects.toMatchObject({ code: "23514" })
    expect(await count("SELECT count(*) AS n FROM tenant.departments WHERE id = $1", [id])).toBe(0)
  })

  it("retries a deadlock up to three times, then gives up (TRX-08)", async () => {
    let calls = 0
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" })
    await expect(runUnitOfWork(db.web, ctxA, async () => {
      calls++
      if (calls < 3) throw deadlock
      return "ok"
    })).resolves.toBe("ok")
    expect(calls).toBe(3)
    calls = 0
    await expect(runUnitOfWork(db.web, ctxA, async () => { calls++; throw deadlock })).rejects.toBe(deadlock)
    expect(calls).toBe(3)
    calls = 0
    await expect(runUnitOfWork(db.web, ctxA, async () => { calls++; throw new Error("other") })).rejects.toThrow("other")
    expect(calls).toBe(1)
  })

  it("never stores secrets in before and after (TRL-04)", async () => {
    const id = uuidv7()
    await runUnitOfWork(db.web, ctxA, (w) => w.audit({ action: "settings.changed", targetType: "settings", targetId: id, before: { bankIban: "MA64 0000" }, after: { smtpPassword: "hunter2", name: "Atlas" } }))
    const { rows } = await db.admin.query("SELECT before, after FROM audit.workspace_events WHERE target_id = $1", [id])
    expect(rows[0]).toEqual({ before: { bankIban: "[redacted]" }, after: { smtpPassword: "[redacted]", name: "Atlas" } })
  })

  it("writes console actions to the console trail, which company roles cannot touch (AUD-01)", async () => {
    const id = uuidv7()
    await runUnitOfWork(db.web, { role: "nx_platform", principalId: seed.principal, actor: { role: "owner" } }, async (w) => {
      await w.audit({ action: "customer.suspended", targetType: "customer", targetId: id, reason: "unpaid" })
      await w.emit({ aggregateType: "customer", aggregateId: id, eventType: "customer.suspended" })
    })
    expect(await count("SELECT count(*) AS n FROM audit.console_events WHERE target_id = $1", [id])).toBe(1)
    expect(await count("SELECT count(*) AS n FROM ops.outbox WHERE aggregate_id = $1 AND workspace_id IS NULL", [id])).toBe(1)
    expect(await sqlState(() => inTransaction(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal }, (c) => c.query("SELECT * FROM audit.console_events")))).toBe("42501")
    expect(await sqlState(() => inTransaction(db.web, { role: "nx_platform", principalId: seed.principal }, (c) => c.query("SELECT * FROM audit.workspace_events")))).toBe("42501")
  })

  describe("audit trails are insert-only and isolated (TRL-02, TRL-03)", () => {
    it("refuses UPDATE, DELETE and TRUNCATE to nx_app, nx_platform and nx_owner", async () => {
      await runUnitOfWork(db.web, ctxA, (w) => w.audit({ action: "department.renamed", targetType: "department" }))
      await runUnitOfWork(db.web, { role: "nx_platform", principalId: seed.principal, actor: { role: "owner" } }, (w) => w.audit({ action: "plan.changed", targetType: "plan" }))
      const app = { role: "nx_app" as const, workspaceId: seed.a, principalId: seed.principal }
      const platform = { role: "nx_platform" as const, principalId: seed.principal }
      expect(await sqlState(() => inTransaction(db.web, app, (c) => c.query("UPDATE audit.workspace_events SET reason = 'x'")))).toBe("42501")
      expect(await sqlState(() => inTransaction(db.web, app, (c) => c.query("DELETE FROM audit.workspace_events")))).toBe("42501")
      expect(await sqlState(() => inTransaction(db.web, platform, (c) => c.query("UPDATE audit.console_events SET reason = 'x'")))).toBe("42501")
      expect(await sqlState(() => inTransaction(db.web, platform, (c) => c.query("DELETE FROM audit.console_events")))).toBe("42501")
      const owner = new (await import("pg")).default.Client({ connectionString: db.ownerUrl })
      await owner.connect()
      try {
        // The owner could lift row-level security on its own tables; the trigger still refuses.
        for (const table of ["audit.workspace_events", "audit.console_events"]) {
          for (const change of [`UPDATE ${table} SET at = now()`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
            await owner.query("BEGIN")
            await owner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`)
            expect(await sqlState(() => owner.query(change))).toBe("42501")
            await owner.query("ROLLBACK")
          }
        }
        await db.admin.query("INSERT INTO audit.identity_events (id, principal_id, realm, action) VALUES ($1, $2, 'member', 'session.signed_in')", [uuidv7(), seed.principal])
        for (const change of ["UPDATE audit.identity_events SET at = now()", "DELETE FROM audit.identity_events", "TRUNCATE audit.identity_events"]) {
          expect(await sqlState(() => owner.query(change))).toBe("42501")
        }
      } finally {
        await owner.end()
      }
      expect(await count("SELECT count(*) AS n FROM audit.workspace_events")).toBeGreaterThan(0)
    })

    it("shows a company only its own events, and refuses an event for another workspace or actor", async () => {
      await runUnitOfWork(db.web, { ...ctxA, workspaceId: seed.b }, (w) => w.audit({ action: "client.created", targetType: "client", targetLabel: "only in B" }))
      const seen = await inTransaction(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal }, (c) => c.query("SELECT DISTINCT workspace_id FROM audit.workspace_events"))
      expect(seen.rows.map((r) => r.workspace_id)).toEqual([seed.a])
      const forgedWorkspace = sqlState(() => inTransaction(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal }, (c) =>
        c.query("INSERT INTO audit.workspace_events (id, workspace_id, actor_id, actor_role, action, target_type) VALUES ($1, $2, $3, 'admin', 'client.created', 'client')", [uuidv7(), seed.b, seed.principal])))
      expect(await forgedWorkspace).toBe("42501")
      const other = uuidv7()
      await db.admin.query("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', 'member:other', 'Other')", [other])
      const forgedActor = sqlState(() => inTransaction(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal }, (c) =>
        c.query("INSERT INTO audit.workspace_events (id, workspace_id, actor_id, actor_role, action, target_type) VALUES ($1, $2, $3, 'admin', 'client.created', 'client')", [uuidv7(), seed.a, other])))
      expect(await forgedActor).toBe("42501")
    })

    it("lets a company add outbox events and jobs only for its own workspace, and never read the queue", async () => {
      const app = { role: "nx_app" as const, workspaceId: seed.a, principalId: seed.principal }
      expect(await sqlState(() => inTransaction(db.web, app, (c) =>
        c.query("INSERT INTO ops.outbox (id, workspace_id, aggregate_type, aggregate_id, event_type) VALUES ($1, $2, 'client', 'x', 'client.created')", [uuidv7(), seed.b])))).toBe("42501")
      expect(await sqlState(() => inTransaction(db.web, app, (c) =>
        c.query("INSERT INTO ops.jobs (id, type, workspace_id) VALUES ($1, 'summaries.refresh', $2)", [uuidv7(), seed.b])))).toBe("42501")
      expect(await sqlState(() => inTransaction(db.web, app, (c) => c.query("SELECT * FROM ops.jobs")))).toBe("42501")
      expect(await sqlState(() => inTransaction(db.web, app, (c) => c.query("SELECT * FROM ops.outbox")))).toBe("42501")
    })
  })
})

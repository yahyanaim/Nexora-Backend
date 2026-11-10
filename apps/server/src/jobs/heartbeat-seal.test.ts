import pino from "pino"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { inTransaction } from "../db/session"
import { ADMIN_URL, createTestDb, seedTwoWorkspaces, type TestDb } from "../db/testing/test-db"
import { runUnitOfWork } from "../db/unit-of-work"
import { Worker } from "../worker/worker"
import { sealAuditTrails, verifyAuditTrails } from "./audit-seal"
import { markStopped, workerHealth, writeHeartbeat } from "./heartbeat"
import { enqueueJob } from "./queue"
import { jobHandlers } from "./registry"

describe.skipIf(!ADMIN_URL)("worker heartbeat (JOB-09) and audit seals (TRL-05)", () => {
  let db: TestDb
  let seed: Awaited<ReturnType<typeof seedTwoWorkspaces>>
  const silent = pino({ level: "silent" })

  beforeAll(async () => {
    db = await createTestDb()
    seed = await seedTwoWorkspaces(db.admin)
  }, 60_000)
  afterAll(async () => db?.drop())

  describe("heartbeat", () => {
    beforeEach(async () => {
      await db.admin.query("DELETE FROM ops.worker_heartbeats; DELETE FROM ops.jobs")
    })

    it("writes the queue metrics with each beat, and the worker counts as alive", async () => {
      await enqueueJob(db.web, { type: "test.waiting" })
      const metrics = await writeHeartbeat(db.web, "w-1", new Date())
      expect(metrics).toMatchObject({ due: 1, running: 0, dead: 0 })
      const health = await workerHealth(db.web)
      expect(health.missing).toEqual([])
      expect(health.alive).toHaveLength(1)
      expect(health.alive[0]).toMatchObject({ workerId: "w-1", metrics: { due: 1, outboxPending: 0 } })
    })

    it("reports a worker whose last beat is older than 2 minutes, but not one that stopped cleanly", async () => {
      await writeHeartbeat(db.web, "w-dead", new Date())
      await writeHeartbeat(db.web, "w-stopped", new Date())
      await markStopped(db.web, "w-stopped")
      await db.admin.query("UPDATE ops.worker_heartbeats SET beat_at = now() - interval '3 minutes'")
      const health = await workerHealth(db.web)
      expect(health.missing.map((w) => w.workerId)).toEqual(["w-dead"])
      expect(health.missing[0]!.secondsSinceBeat).toBeGreaterThanOrEqual(180)
      expect(health.alive).toEqual([])
    })

    it("beats as soon as the worker starts, and records the stop on shutdown", async () => {
      const worker = new Worker(db.web, { id: "w-run", logger: silent, handlers: {}, idleMs: 20, heartbeatMs: 50 })
      worker.start()
      await expect.poll(async () => (await db.admin.query("SELECT 1 FROM ops.worker_heartbeats WHERE worker_id = 'w-run'")).rowCount).toBe(1)
      await worker.stop(200)
      const { rows } = await db.admin.query("SELECT stopped_at IS NOT NULL AS stopped FROM ops.worker_heartbeats WHERE worker_id = 'w-run'")
      expect(rows).toEqual([{ stopped: true }])
      expect((await workerHealth(db.web)).alive).toEqual([])
    })

    it("lets the console read the heartbeats and nothing write them but the worker", async () => {
      await writeHeartbeat(db.web, "w-1", new Date())
      const read = await inTransaction(db.web, { role: "nx_platform" }, (c) => c.query("SELECT worker_id FROM ops.worker_heartbeats"))
      expect(read.rows).toEqual([{ worker_id: "w-1" }])
      await expect(inTransaction(db.web, { role: "nx_platform" }, (c) => c.query("DELETE FROM ops.worker_heartbeats"))).rejects.toThrow(/permission denied/)
      await expect(inTransaction(db.web, { role: "nx_app", workspaceId: seed.a }, (c) => c.query("SELECT 1 FROM ops.worker_heartbeats"))).rejects.toThrow(/permission denied/)
    })
  })

  describe("audit seals", () => {
    const actor = { role: "owner" }
    const event = (workspaceId: string, label: string) =>
      runUnitOfWork(db.web, { role: "nx_app", workspaceId, principalId: seed.principal, actor }, (w) =>
        w.audit({ action: "department.created", targetType: "department", targetLabel: label }))
    const consoleEvent = (label: string) =>
      runUnitOfWork(db.web, { role: "nx_platform", principalId: seed.principal, actor: { role: "staff" } }, (w) =>
        w.audit({ action: "plan.changed", targetType: "plan", targetLabel: label }))
    const seal = (margin = 0) => inTransaction(db.web, { role: "nx_jobs" }, (c) => sealAuditTrails(c, margin))
    const verify = () => inTransaction(db.web, { role: "nx_jobs" }, (c) => verifyAuditTrails(c))
    /** Changes the trail as a database superuser would: with the immutability triggers switched off for the session. */
    const tamper = async (sql: string, params: unknown[] = []) => {
      const c = await db.admin.connect()
      try {
        await c.query("SET session_replication_role = replica")
        await c.query(sql, params)
      } finally {
        await c.query("RESET session_replication_role")
        c.release()
      }
    }

    it("creates the two schedules: seal every 5 minutes, verify every day", async () => {
      const { rows } = await db.admin.query("SELECT name, job_type, interval_seconds FROM ops.schedules WHERE name LIKE 'audit.%' ORDER BY name")
      expect(rows).toEqual([
        { name: "audit.seal", job_type: "audit.seal", interval_seconds: 300 },
        { name: "audit.verify", job_type: "audit.verify", interval_seconds: 86400 },
      ])
    })

    it("seals each workspace and each trail in its own chain, links the next seal to the previous one, and verifies them", async () => {
      await event(seed.a, "A1")
      await event(seed.a, "A2")
      await event(seed.b, "B1")
      await consoleEvent("C1")
      expect(await seal()).toBe(3) // workspace A, workspace B, console
      expect(await seal()).toBe(0) // nothing new
      await event(seed.a, "A3")
      expect(await seal()).toBe(1)
      const { rows } = await db.admin.query(
        `SELECT s.event_count, s.previous_hash = p.seal_hash AS linked FROM audit.seals s
         LEFT JOIN audit.seals p ON p.trail = s.trail AND p.workspace_id = s.workspace_id AND p.last_event_id < s.last_event_id
         WHERE s.workspace_id = $1 ORDER BY s.last_event_id`,
        [seed.a],
      )
      expect(rows).toEqual([{ event_count: 2, linked: null }, { event_count: 1, linked: true }])
      expect(await verify()).toEqual([])
    })

    it("leaves events younger than the margin for the next run", async () => {
      await event(seed.b, "recent")
      expect(await seal(120)).toBe(0)
      expect(await seal(0)).toBe(1)
    })

    it("reports an event changed, removed or slipped into a sealed range by a superuser", async () => {
      await event(seed.a, "to-change")
      await event(seed.a, "to-remove")
      await seal()
      expect(await verify()).toEqual([])

      await tamper("UPDATE audit.workspace_events SET target_label = 'changed' WHERE target_label = 'to-change'")
      const changed = await verify()
      expect(changed).toHaveLength(1)
      expect(changed[0]).toMatchObject({ trail: "workspace", workspaceId: seed.a, problem: expect.stringMatching(/^events changed/) })

      await tamper("UPDATE audit.workspace_events SET target_label = 'to-change' WHERE target_label = 'changed'")
      expect(await verify()).toEqual([]) // put back exactly: the chain is whole again

      // An event slipped in with an id inside the sealed range
      await tamper(
        `INSERT INTO audit.workspace_events (id, workspace_id, actor_id, actor_role, action, target_type, target_label)
         VALUES ('00000000-0000-7000-8000-000000000001', $1, $2, 'owner', 'department.created', 'department', 'slipped in')`,
        [seed.a, seed.principal],
      )
      expect((await verify())[0]?.problem).toMatch(/^events changed/)
      await tamper("DELETE FROM audit.workspace_events WHERE target_label = 'slipped in'")
      expect(await verify()).toEqual([])

      await tamper("DELETE FROM audit.workspace_events WHERE target_label = 'to-remove'")
      expect((await verify())[0]?.problem).toMatch(/events changed: \d+ sealed, \d+ found/)
    })

    it("reports an altered seal and a broken link", async () => {
      await event(seed.b, "B-seal-1")
      await seal()
      await event(seed.b, "B-seal-2")
      await seal()
      const before = (await verify()).filter((b) => b.workspaceId === seed.b)
      expect(before).toEqual([])
      await tamper(
        `UPDATE audit.seals SET event_count = event_count + 1 WHERE id = (SELECT id FROM audit.seals WHERE workspace_id = $1 ORDER BY last_event_id DESC LIMIT 1)`,
        [seed.b],
      )
      const problems = (await verify()).filter((b) => b.workspaceId === seed.b).map((b) => b.problem)
      expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/^events changed/), "seal altered"]))
    })

    it("gives the job role the two functions and no audit event", async () => {
      await expect(inTransaction(db.web, { role: "nx_jobs" }, (c) => c.query("SELECT 1 FROM audit.workspace_events LIMIT 1"))).rejects.toThrow(/permission denied/)
      await expect(inTransaction(db.web, { role: "nx_jobs" }, (c) => c.query("SELECT 1 FROM audit.seals LIMIT 1"))).rejects.toThrow(/permission denied/)
      await expect(inTransaction(db.web, { role: "nx_app", workspaceId: seed.a }, (c) => c.query("SELECT audit.seal()"))).rejects.toThrow(/permission denied/)
      await expect(inTransaction(db.web, { role: "nx_jobs" }, (c) => c.query("INSERT INTO audit.seals (trail, first_event_id, last_event_id, event_count, events_hash, seal_hash) VALUES ('identity', gen_random_uuid(), gen_random_uuid(), 1, repeat('a', 64), repeat('b', 64))"))).rejects.toThrow(/permission denied/)
    })

    it("runs as worker jobs: the verify job fails while a chain is broken, so the break stays visible (JOB-07)", async () => {
      await db.admin.query("DELETE FROM ops.jobs")
      const worker = new Worker(db.web, { id: "w-audit", logger: silent, handlers: jobHandlers })
      await event(seed.b, "job-1")
      await enqueueJob(db.web, { type: "audit.seal" })
      await worker.turn()
      // The seal job uses the 2-minute margin: "job-1" is too young, so seal it now, then break it.
      await seal()
      await tamper("UPDATE audit.workspace_events SET target_label = 'job-1 changed' WHERE target_label = 'job-1'")
      await enqueueJob(db.web, { type: "audit.verify" })
      await worker.turn()
      const { rows } = await db.admin.query("SELECT type, status, attempts, last_error FROM ops.jobs ORDER BY created_at")
      expect(rows[0]).toMatchObject({ type: "audit.seal", status: "done" })
      expect(rows[1]).toMatchObject({ type: "audit.verify", status: "queued", attempts: 1 })
      expect(rows[1].last_error).toMatch(/^audit chain broken in \d+ place/)
    })
  })
})

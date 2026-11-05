import pino from "pino"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ADMIN_URL, createTestDb, seedTwoWorkspaces, type TestDb } from "../db/testing/test-db"
import { runUnitOfWork } from "../db/unit-of-work"
import { uuidv7 } from "../db/uuid"
import { Worker } from "../worker/worker"
import { relayOutbox } from "./outbox-relay"
import { backoffMinutes, claimJobs, completeJob, enqueueJob, failJob, queueStats, reapExpiredLeases, releaseJob, retryDeadJob } from "./queue"
import { enqueueDueSchedules } from "./scheduler"

describe("backoff (§17.1)", () => {
  it("waits 1, 2, 4… minutes, at most 60", () => {
    expect([1, 2, 3, 4, 7, 8, 20].map(backoffMinutes)).toEqual([1, 2, 4, 8, 60, 60, 60])
  })
})

describe.skipIf(!ADMIN_URL)("job queue, scheduler, outbox relay and worker", () => {
  let db: TestDb
  let seed: Awaited<ReturnType<typeof seedTwoWorkspaces>>
  const silent = pino({ level: "silent" })

  beforeAll(async () => {
    db = await createTestDb()
    seed = await seedTwoWorkspaces(db.admin)
  }, 60_000)
  afterAll(async () => db?.drop())
  // Each test starts from an empty queue (the superuser bypasses row-level security).
  beforeEach(async () => {
    await db.admin.query("DELETE FROM ops.jobs; DELETE FROM ops.outbox; DELETE FROM ops.schedules")
  })

  const job = async (id: string) => (await db.admin.query("SELECT * FROM ops.jobs WHERE id = $1", [id])).rows[0]

  describe("queue (JOB-01)", () => {
    it("never gives the same job to two workers claiming at the same moment", async () => {
      for (let i = 0; i < 20; i++) await enqueueJob(db.web, { type: "test.work", payload: { i } })
      const claims = await Promise.all(Array.from({ length: 4 }, (_, w) => claimJobs(db.web, `w${w}`, { limit: 10 })))
      const ids = claims.flat().map((j) => j.id)
      expect(ids).toHaveLength(20)
      expect(new Set(ids).size).toBe(20)
    })

    it("takes only due jobs of the requested types", async () => {
      await enqueueJob(db.web, { type: "test.later", runAt: new Date(Date.now() + 3_600_000) })
      await enqueueJob(db.web, { type: "test.other" })
      expect(await claimJobs(db.web, "w", { types: ["test.later", "test.work"] })).toEqual([])
      expect((await claimJobs(db.web, "w", { types: ["test.other"] }))[0]?.type).toBe("test.other")
    })

    it("puts back a job whose worker died, once its lease has expired", async () => {
      await enqueueJob(db.web, { type: "test.work" })
      const [claimed] = await claimJobs(db.web, "dead-worker", { leaseSeconds: 60 })
      expect(await reapExpiredLeases(db.web)).toBe(0) // lease still valid
      await db.admin.query("UPDATE ops.jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [claimed!.id])
      expect(await reapExpiredLeases(db.web)).toBe(1)
      const [again] = await claimJobs(db.web, "live-worker")
      expect(again).toMatchObject({ id: claimed!.id, attempts: 2 })
      expect(await completeJob(db.web, "dead-worker", claimed!.id)).toBe(false) // the old worker lost its lease
      expect(await completeJob(db.web, "live-worker", claimed!.id)).toBe(true)
      expect((await job(claimed!.id)).status).toBe("done")
    })

    it("retries a failed job with backoff, then marks it dead after its last attempt", async () => {
      await enqueueJob(db.web, { type: "test.work", maxAttempts: 2 })
      const [first] = await claimJobs(db.web, "w")
      expect(await failJob(db.web, "w", first!.id, new Error("provider down"))).toBe("retry")
      const retried = await job(first!.id)
      expect(retried.status).toBe("queued")
      expect(new Date(retried.run_at).getTime() - Date.now()).toBeGreaterThan(50_000) // 1 minute later
      await db.admin.query("UPDATE ops.jobs SET run_at = now() WHERE id = $1", [first!.id])
      const [second] = await claimJobs(db.web, "w")
      expect(await failJob(db.web, "w", second!.id, new Error("still down"))).toBe("dead")
      expect(await job(first!.id)).toMatchObject({ status: "dead", attempts: 2, last_error: "still down" })
      expect(await retryDeadJob(db.web, first!.id)).toBe(true)
      expect(await job(first!.id)).toMatchObject({ status: "queued", attempts: 0 })
    })

    it("gives a job back at shutdown without using an attempt (JOB-08)", async () => {
      await enqueueJob(db.web, { type: "test.work" })
      const [claimed] = await claimJobs(db.web, "w")
      expect(await releaseJob(db.web, "w", claimed!.id)).toBe(true)
      expect(await job(claimed!.id)).toMatchObject({ status: "queued", attempts: 0, locked_by: null })
    })

    it("runs one job of a type per workspace at a time (JOB-06)", async () => {
      await enqueueJob(db.web, { type: "summaries.refresh", workspaceId: seed.a, payload: { n: 1 } })
      await enqueueJob(db.web, { type: "summaries.refresh", workspaceId: seed.a, payload: { n: 2 } })
      await enqueueJob(db.web, { type: "summaries.refresh", workspaceId: seed.b })
      const first = await claimJobs(db.web, "w1", { limit: 10 })
      expect(first.map((j) => j.workspaceId).sort()).toEqual([seed.a, seed.b].sort())
      expect(await claimJobs(db.web, "w2", { limit: 10 })).toEqual([])
      await completeJob(db.web, "w1", first.find((j) => j.workspaceId === seed.a)!.id)
      expect((await claimJobs(db.web, "w2", { limit: 10 }))[0]?.payload).toEqual({ n: 2 })
    })

    it("enqueues a dedupe key once, whoever enqueues it (JOB-02)", async () => {
      expect(await enqueueJob(db.web, { type: "test.work", dedupeKey: "k1" })).toBe(true)
      expect(await enqueueJob(db.web, { type: "test.work", dedupeKey: "k1" })).toBe(false)
      await runUnitOfWork(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal, actor: { role: "admin" } }, (w) => w.enqueue({ type: "test.work", dedupeKey: "k1" }))
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM ops.jobs WHERE dedupe_key = 'k1'")).rows[0].n)).toBe(1)
    })

    it("measures depth, the oldest due job, dead jobs and outbox lag (JOB-07)", async () => {
      await enqueueJob(db.web, { type: "test.work" })
      await db.admin.query("UPDATE ops.jobs SET run_at = now() - interval '90 seconds'")
      await enqueueJob(db.web, { type: "test.later", runAt: new Date(Date.now() + 3_600_000) })
      const stats = await queueStats(db.web)
      expect(stats).toMatchObject({ due: 1, running: 0, dead: 0, outboxPending: 0 })
      expect(stats.oldestDueSeconds).toBeGreaterThanOrEqual(89)
    })
  })

  describe("scheduler (JOB-04)", () => {
    it("enqueues each due run once, even with two workers started together", async () => {
      await db.admin.query(
        "INSERT INTO ops.schedules (name, job_type, interval_seconds, next_run_at) VALUES ('audit.seal', 'audit.seal', 300, now() - interval '1 second'), ('later.job', 'later.job', 3600, now() + interval '1 hour')",
      )
      const results = await Promise.all([enqueueDueSchedules(db.web), enqueueDueSchedules(db.web), enqueueDueSchedules(db.web)])
      expect(results.reduce((a, b) => a + b, 0)).toBe(1)
      const { rows } = await db.admin.query("SELECT type, dedupe_key FROM ops.jobs")
      expect(rows).toHaveLength(1)
      expect(rows[0].dedupe_key).toMatch(/^schedule:audit\.seal:\d{4}-/)
      const { rows: s } = await db.admin.query("SELECT next_run_at > now() AS future FROM ops.schedules WHERE name = 'audit.seal'")
      expect(s[0].future).toBe(true)
      expect(await enqueueDueSchedules(db.web)).toBe(0) // a restart enqueues nothing new
    })

    it("enqueues runs missed while no worker was up once, then moves to the next future time", async () => {
      await db.admin.query("INSERT INTO ops.schedules (name, job_type, interval_seconds, next_run_at) VALUES ('test.tick', 'test.tick', 60, now() - interval '10 minutes')")
      expect(await enqueueDueSchedules(db.web)).toBe(1)
      const { rows } = await db.admin.query("SELECT next_run_at > now() AS future, next_run_at <= now() + interval '60 seconds' AS soon FROM ops.schedules")
      expect(rows[0]).toEqual({ future: true, soon: true })
    })
  })

  describe("outbox relay (TRX-05)", () => {
    const emit = (eventType: string, aggregateId = uuidv7()) =>
      runUnitOfWork(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal, actor: { role: "admin" } }, (w) =>
        w.emit({ aggregateType: "invoice", aggregateId, eventType, payload: { aggregateId } }))

    it("turns each event into its jobs once, even when relayed twice", async () => {
      await emit("invoice.issued")
      const routes = { "invoice.issued": () => [{ type: "invoice.render_pdf" }, { type: "invoice.build_ubl" }] }
      expect(await relayOutbox(db.web, routes)).toEqual({ published: 1, failed: 0, jobs: 2 })
      // A relay that died after enqueueing but before marking published sends the event again.
      await db.admin.query("UPDATE ops.outbox SET status = 'pending'")
      expect(await relayOutbox(db.web, routes)).toEqual({ published: 1, failed: 0, jobs: 0 })
      const { rows } = await db.admin.query("SELECT type, workspace_id FROM ops.jobs ORDER BY type")
      expect(rows).toEqual([{ type: "invoice.build_ubl", workspace_id: seed.a }, { type: "invoice.render_pdf", workspace_id: seed.a }])
    })

    it("keeps a failing event for later without blocking the others", async () => {
      await emit("invoice.issued")
      await emit("invoice.sent")
      const routes = { "invoice.issued": () => { throw new Error("route broken") }, "invoice.sent": () => [{ type: "email.send" }] }
      expect(await relayOutbox(db.web, routes)).toEqual({ published: 1, failed: 1, jobs: 1 })
      const { rows } = await db.admin.query("SELECT event_type, status, attempts, last_error, available_at > now() AS later FROM ops.outbox ORDER BY event_type")
      expect(rows[0]).toMatchObject({ event_type: "invoice.issued", status: "pending", attempts: 1, last_error: "route broken", later: true })
      expect(rows[1]).toMatchObject({ event_type: "invoice.sent", status: "published" })
    })

    it("never relays an event of a rolled-back command (NTF-01)", async () => {
      await expect(runUnitOfWork(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal, actor: { role: "admin" } }, async (w) => {
        await w.emit({ aggregateType: "invoice", aggregateId: "x", eventType: "invoice.sent" })
        throw new Error("rolled back")
      })).rejects.toThrow()
      expect(await relayOutbox(db.web, { "invoice.sent": () => [{ type: "email.send" }] })).toEqual({ published: 0, failed: 0, jobs: 0 })
    })
  })

  describe("worker", () => {
    it("runs a tenant job as system:<job type>, with its change audited in the job's workspace (JOB-03)", async () => {
      await enqueueJob(db.web, { type: "test.rename_departments", workspaceId: seed.a })
      const worker = new Worker(db.web, {
        id: "w-test", logger: silent,
        handlers: {
          "test.rename_departments": async (_job, ctx) => {
            await ctx.inWorkspace(async (w) => {
              await w.client.query("INSERT INTO tenant.departments (id, workspace_id, name) VALUES ($1, $2, 'Made by a job')", [uuidv7(), seed.a])
              await w.audit({ action: "department.created", targetType: "department", targetLabel: "Made by a job" })
            })
          },
        },
      })
      expect(await worker.turn()).toBe(true)
      const { rows } = await db.admin.query(
        `SELECT e.actor_role, p.reference, d.created_by = p.id AS stamped FROM audit.workspace_events e
         JOIN identity.principals p ON p.id = e.actor_id JOIN tenant.departments d ON d.name = 'Made by a job'
         WHERE e.target_label = 'Made by a job'`,
      )
      expect(rows).toEqual([{ actor_role: "system:test.rename_departments", reference: "system:test.rename_departments", stamped: true }])
      expect((await db.admin.query("SELECT status FROM ops.jobs")).rows[0].status).toBe("done")
    })

    it("records a handler failure and runs the job again later", async () => {
      await enqueueJob(db.web, { type: "test.flaky" })
      const worker = new Worker(db.web, { id: "w-test", logger: silent, handlers: { "test.flaky": async () => { throw new Error("boom") } } })
      await worker.turn()
      expect((await db.admin.query("SELECT status, attempts, last_error FROM ops.jobs")).rows[0]).toEqual({ status: "queued", attempts: 1, last_error: "boom" })
    })

    it("stops claiming at shutdown, and gives back a job that does not finish in time (JOB-08)", async () => {
      await enqueueJob(db.web, { type: "test.slow" })
      let started!: () => void
      const running = new Promise<void>((r) => (started = r))
      const worker = new Worker(db.web, {
        id: "w-slow", logger: silent, idleMs: 20,
        handlers: {
          "test.slow": (_job, ctx) => new Promise<void>((_resolve, reject) => {
            started()
            ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
          }),
        },
      })
      worker.start()
      await running
      await worker.stop(200)
      expect((await db.admin.query("SELECT status, attempts, locked_by FROM ops.jobs")).rows[0]).toEqual({ status: "queued", attempts: 0, locked_by: null })
    })
  })
})

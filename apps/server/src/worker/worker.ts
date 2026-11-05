import type pg from "pg"
import type { Logger } from "pino"
import { runUnitOfWork, type Work } from "../db/unit-of-work"
import { type OutboxRoutes, relayOutbox } from "../jobs/outbox-relay"
import { claimJobs, completeJob, failJob, type Job, reapExpiredLeases, releaseJob } from "../jobs/queue"
import { enqueueDueSchedules } from "../jobs/scheduler"
import { systemPrincipal } from "../jobs/system-principal"

/**
 * The worker process loop (§5 processes, §17). Each turn it puts back expired
 * leases, enqueues due schedules, relays the outbox, then claims and runs one
 * job. Handlers must be idempotent (JOB-02): a job may run again after a crash.
 */

export interface JobContext {
  /** Aborted when the worker shuts down: long handlers stop at a safe point. */
  signal: AbortSignal
  /**
   * Tenant work of the job, in one unit of work under nx_app, in the job's
   * workspace, as system:<job type> (JOB-03): its changes and audit events
   * carry that actor.
   */
  inWorkspace<T>(command: (work: Work) => Promise<T>): Promise<T>
  /** Platform work of the job, under nx_platform, as system:<job type>. */
  onPlatform<T>(command: (work: Work) => Promise<T>): Promise<T>
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>

export interface WorkerOptions {
  id: string
  handlers: Record<string, JobHandler>
  routes?: OutboxRoutes
  logger: Logger
  /** Pause between turns when there was nothing to do. */
  idleMs?: number
  leaseSeconds?: number
}

export class Worker {
  private stopping = false
  private readonly abort = new AbortController()
  private current: { job: Job; done: Promise<void> } | null = null
  private loop: Promise<void> | null = null
  private wake: (() => void) | null = null

  constructor(private readonly pool: pg.Pool, private readonly opts: WorkerOptions) {}

  /** One turn; true when it did something. Exposed for tests. */
  async turn(): Promise<boolean> {
    const { logger } = this.opts
    let busy = false
    const reaped = await reapExpiredLeases(this.pool)
    if (reaped) logger.warn({ reaped }, "jobs put back after an expired lease")
    busy = (await enqueueDueSchedules(this.pool)) > 0 || busy
    const relayed = await relayOutbox(this.pool, this.opts.routes ?? {})
    if (relayed.failed) logger.error({ failed: relayed.failed }, "outbox events failed to relay")
    busy = relayed.published + relayed.failed > 0 || busy
    if (this.stopping) return busy
    const types = Object.keys(this.opts.handlers)
    if (!types.length) return busy
    const [job] = await claimJobs(this.pool, this.opts.id, { limit: 1, leaseSeconds: this.opts.leaseSeconds, types })
    if (!job) return busy
    const done = this.run(job)
    this.current = { job, done }
    await done
    this.current = null
    return true
  }

  private async run(job: Job) {
    const { logger } = this.opts
    const handler = this.opts.handlers[job.type]! // claimed only for registered types
    try {
      const principalId = await systemPrincipal(this.pool, job.type)
      const actor = { role: `system:${job.type}` }
      const ctx: JobContext = {
        signal: this.abort.signal,
        inWorkspace: (command) => {
          if (!job.workspaceId) throw new TypeError(`Job ${job.type} has no workspace`)
          return runUnitOfWork(this.pool, { role: "nx_app", workspaceId: job.workspaceId, principalId, actor }, command)
        },
        onPlatform: (command) => runUnitOfWork(this.pool, { role: "nx_platform", principalId, actor }, command),
      }
      await handler(job, ctx)
      if (!(await completeJob(this.pool, this.opts.id, job.id))) logger.warn({ jobId: job.id }, "job finished after its lease was lost")
    } catch (error) {
      if (this.abort.signal.aborted && (error as Error)?.name === "AbortError") return // released by stop()
      const outcome = await failJob(this.pool, this.opts.id, job.id, error)
      logger[outcome === "dead" ? "error" : "warn"]({ err: error, jobId: job.id, type: job.type, attempt: job.attempts, outcome }, "job failed")
    }
  }

  start() {
    const idleMs = this.opts.idleMs ?? 1_000
    this.loop = (async () => {
      while (!this.stopping) {
        let busy = false
        try {
          busy = await this.turn()
        } catch (err) {
          this.opts.logger.error({ err }, "worker turn failed")
        }
        if (!busy && !this.stopping) await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, idleMs)
          this.wake = () => { clearTimeout(t); resolve() }
        })
      }
    })()
  }

  /**
   * Graceful stop (JOB-08): no new claims; the running job gets until the
   * deadline to finish, then it is given back to the queue without using an attempt.
   */
  async stop(timeoutMs = 30_000) {
    this.stopping = true
    this.wake?.()
    const running = this.current
    if (running) {
      const finished = await Promise.race([running.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref())])
      if (!finished) {
        this.abort.abort()
        await releaseJob(this.pool, this.opts.id, running.job.id)
        this.opts.logger.warn({ jobId: running.job.id }, "job given back at shutdown")
      }
    }
    await this.loop?.catch(() => {})
  }
}

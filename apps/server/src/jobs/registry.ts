import type { JobHandler } from "../worker/worker"
import { AuditChainBroken, sealAuditTrails, verifyAuditTrails } from "./audit-seal"
import type { OutboxRoutes } from "./outbox-relay"

/**
 * The job handlers and outbox routes of the worker (Table 56). Modules add
 * theirs as they are built (e-mail in B1e, invoice files in B1d, summaries in
 * B2…). The schedules of the jobs below are created by migration 0007.
 */
export const jobHandlers: Record<string, JobHandler> = {
  "audit.seal": async (_job, ctx) => {
    const written = await ctx.onQueue((c) => sealAuditTrails(c))
    ctx.logger.info({ written }, "audit trails sealed")
  },
  "audit.verify": async (_job, ctx) => {
    const breaks = await ctx.onQueue((c) => verifyAuditTrails(c))
    if (breaks.length) {
      ctx.logger.error({ breaks }, "audit chain broken")
      throw new AuditChainBroken(breaks)
    }
    ctx.logger.info("audit chains verified")
  },
}

export const outboxRoutes: OutboxRoutes = {}

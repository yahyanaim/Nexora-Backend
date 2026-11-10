import type { JobHandler } from "../worker/worker"
import { AuditChainBroken, AuditSecretFound, scanAuditSecrets, sealAuditTrails, verifyAuditTrails } from "./audit-seal"
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
  // Daily: the seal chains (TRL-05) and the secret scan (TRL-04). The job fails while either finds something.
  "audit.verify": async (_job, ctx) => {
    const breaks = await ctx.onQueue((c) => verifyAuditTrails(c))
    if (breaks.length) {
      ctx.logger.error({ breaks }, "audit chain broken")
      throw new AuditChainBroken(breaks)
    }
    const secrets = await ctx.onQueue((c) => scanAuditSecrets(c))
    if (secrets.length) {
      ctx.logger.error({ secrets }, "audit trail holds secrets")
      throw new AuditSecretFound(secrets)
    }
    ctx.logger.info("audit chains verified, no secret found")
  },
}

export const outboxRoutes: OutboxRoutes = {}

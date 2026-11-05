import type { JobHandler } from "../worker/worker"
import type { OutboxRoutes } from "./outbox-relay"

/**
 * The job handlers and outbox routes of the worker (Table 56). Modules add
 * theirs as they are built (e-mail in B1e, invoice files in B1d, summaries in
 * B2…); until then the worker relays the outbox and runs the scheduler.
 */
export const jobHandlers: Record<string, JobHandler> = {}

export const outboxRoutes: OutboxRoutes = {}

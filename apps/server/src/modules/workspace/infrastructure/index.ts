import type pg from "pg"
import { workspaceService, type WorkspaceService } from "../application/workspaces"
import { pgWorkspaceTransactions } from "./pg-store"

/** Builds the workspace service on PostgreSQL. Only composition roots (main.ts) and tests call it. */
export function createWorkspaces(deps: { pool: pg.Pool; now?: () => Date }): WorkspaceService {
  return workspaceService({ tx: pgWorkspaceTransactions(deps.pool), clock: { now: deps.now ?? (() => new Date()) } })
}

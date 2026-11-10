import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { inTransaction, type DbContext } from "./session"

/**
 * The session context guard (audit L-1): ids and the role reach SQL settings and
 * SET LOCAL ROLE, so bad values are refused before any connection is taken.
 * These tests need no database.
 */
function pool() {
  const connect = vi.fn(() => Promise.reject(new Error("must not connect")))
  return { pool: { connect } as unknown as pg.Pool, connect }
}

describe("session context guard (TEN-05, audit L-1)", () => {
  it.each([
    ["workspaceId", "not-a-uuid"],
    ["workspaceId", "00000000-0000-0000-0000-000000000000'; SET ROLE nx_owner; --"],
    ["principalId", "1"],
    ["clientId", ""],
  ])("refuses a malformed %s (%j) without connecting", async (field, value) => {
    const { pool: p, connect } = pool()
    const ctx = { role: "nx_app", [field]: value } as DbContext
    await expect(inTransaction(p, ctx, async () => "ran")).rejects.toThrow(new TypeError(`${field} must be a UUID`))
    expect(connect).not.toHaveBeenCalled()
  })

  it.each(["nx_owner", "postgres", "nx_app; DROP TABLE tenant.workspaces", "NX_APP", ""])("refuses the role %j without connecting", async (role) => {
    const { pool: p, connect } = pool()
    await expect(inTransaction(p, { role } as unknown as DbContext, async () => "ran")).rejects.toThrow(/^Unknown database role/)
    expect(connect).not.toHaveBeenCalled()
  })
})

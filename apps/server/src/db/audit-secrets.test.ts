import pino from "pino"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { scanAuditSecrets } from "../jobs/audit-seal"
import { enqueueJob } from "../jobs/queue"
import { jobHandlers } from "../jobs/registry"
import { Worker } from "../worker/worker"
import { inTransaction } from "./session"
import { ADMIN_URL, createTestDb, seedTwoWorkspaces, type TestDb } from "./testing/test-db"
import { runUnitOfWork } from "./unit-of-work"
import { uuidv7 } from "./uuid"

/**
 * The audit secret scan of the B1a exit gate (TRL-04): "a scan of the audit
 * table finds no secret pattern". The unit of work masks secret fields; the scan
 * checks the trails themselves, and names where a secret is, never its value.
 */
describe.skipIf(!ADMIN_URL)("audit secret scan (TRL-04, B1a exit gate)", () => {
  let db: TestDb
  let seed: Awaited<ReturnType<typeof seedTwoWorkspaces>>

  beforeAll(async () => {
    db = await createTestDb()
    seed = await seedTwoWorkspaces(db.admin)
  }, 60_000)
  afterAll(async () => db?.drop())
  beforeEach(async () => {
    const c = await db.admin.connect()
    try {
      // Test data only: a superuser with the triggers off empties the trails between tests.
      await c.query("SET session_replication_role = replica")
      await c.query("DELETE FROM audit.workspace_events; DELETE FROM audit.console_events; DELETE FROM ops.jobs; DELETE FROM ops.schedules")
    } finally {
      await c.query("RESET session_replication_role")
      c.release()
    }
  })

  const scan = () => inTransaction(db.web, { role: "nx_jobs" }, (c) => scanAuditSecrets(c))
  const command = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    runUnitOfWork(db.web, { role: "nx_app", workspaceId: seed.a, principalId: seed.principal, actor: { role: "owner" } }, (w) =>
      w.audit({ action: "settings.updated", targetType: "settings", before, after }))
  /**
   * Fake secrets, assembled at run time so the source holds no secret-looking
   * literal for the repository's secret scan (security plan G-2).
   */
  const fake = {
    jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abc"].join("."),
    pem: ["-----BEGIN RSA", "PRIVATE KEY-----\nMIIB..."].join(" "),
    apiKey: ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
  }
  /** An event written without the unit of work, as a bug or a direct insert would. */
  const raw = async (after: Record<string, unknown>) => {
    const id = uuidv7()
    await db.admin.query(
      `INSERT INTO audit.workspace_events (id, workspace_id, actor_id, actor_role, action, target_type, after) VALUES ($1, $2, $3, 'owner', 'settings.updated', 'settings', $4)`,
      [id, seed.a, seed.principal, JSON.stringify(after)],
    )
    return id
  }

  it("finds nothing in what the unit of work writes, secrets included, at any depth", async () => {
    await command(
      { smtpPassword: "old-secret", bank: { iban: "MA64011519000001205000534921" } },
      { smtpPassword: "new-secret", apiKey: "k-123", nested: [{ token: "t-1" }, { totpSecret: "JBSWY3DPEHPK3PXP" }], name: "Atlas", phone: "+212 600 000 000" },
    )
    expect(await scan()).toEqual([])
  })

  it("finds a secret field that was not masked, and says where without the value", async () => {
    const id = await raw({ settings: { password: "hunter2" }, name: "Atlas" })
    const found = await scan()
    expect(found).toEqual([{ trail: "workspace", eventId: id, path: "after.settings.password", kind: "secret field not masked" }])
    expect(JSON.stringify(found)).not.toContain("hunter2")
  })

  it("finds secret-looking values under innocent names", async () => {
    await raw({
      note: fake.jwt,
      key: fake.pem,
      provider: fake.apiKey,
      account: "MA64 0115 1900 0001 2050 0053 4921",
      rib: "[redacted]",
      bankNumber: "011519000001205000534921",
      payment: "4111 1111 1111 1111",
    })
    const kinds = (await scan()).map((f) => `${f.path}: ${f.kind}`).sort()
    expect(kinds).toEqual([
      "after.account: IBAN",
      "after.bankNumber: bank account (RIB)",
      "after.key: private key",
      "after.note: token (JWT)",
      "after.payment: card number",
      "after.provider: API key",
    ])
  })

  it("does not take ordinary business values for secrets", async () => {
    await raw({
      createdAt: "1731200000000", invoiceNumber: "FA-2026-000123", ice: "001525487000088", phone: "0612345678",
      amount: "1234567890123456", website: "https://atlas.ma", label: "Token ring project", count: 4111111111111111,
    })
    expect(await scan()).toEqual([])
  })

  it("lets only the job role run the scan", async () => {
    await expect(inTransaction(db.web, { role: "nx_app", workspaceId: seed.a }, (c) => c.query("SELECT * FROM audit.secret_scan()"))).rejects.toThrow(/permission denied/)
    await expect(inTransaction(db.web, { role: "nx_platform" }, (c) => c.query("SELECT * FROM audit.secret_scan()"))).rejects.toThrow(/permission denied/)
  })

  it("makes the daily verify job fail while a secret is in a trail", async () => {
    await raw({ smtp: { password: "plain" } })
    await enqueueJob(db.web, { type: "audit.verify" })
    await new Worker(db.web, { id: "w-scan", logger: pino({ level: "silent" }), handlers: jobHandlers }).turn()
    const { rows } = await db.admin.query("SELECT status, last_error FROM ops.jobs WHERE type = 'audit.verify'")
    expect(rows[0].status).toBe("queued")
    expect(rows[0].last_error).toMatch(/^audit trail holds 1 secret\(s\): workspace .* after\.smtp\.password: secret field not masked$/)
    expect(rows[0].last_error).not.toContain("plain")
  })
})

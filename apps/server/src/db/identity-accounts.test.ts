import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { inTransaction } from "./session"
import { ADMIN_URL, createTestDb, type TestDb } from "./testing/test-db"
import { uuidv7 } from "./uuid"

/** The member accounts, sessions and tokens of B1b step 1 (Table 18; TEN-02, IAM-02, IAM-10). */
describe.skipIf(!ADMIN_URL)("identity accounts (B1b step 1)", () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  }, 60_000)
  afterAll(async () => db?.drop())

  const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo"
  const asApp = <T>(sql: string, params: unknown[] = []) => inTransaction(db.web, { role: "nx_app" }, (c) => c.query<T & object>(sql, params))
  async function principal() {
    const id = uuidv7()
    await asApp("INSERT INTO identity.principals (id, kind, reference, display_name) VALUES ($1, 'member', $2, 'Lina')", [id, `user:${id}`])
    return id
  }
  const sqlState = async (fn: () => Promise<unknown>) => fn().then(() => "ok", (e: { code?: string }) => e.code ?? "error")

  it("keeps no workspace or role on the account: memberships hold them (TEN-02)", async () => {
    const { rows } = await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'users'")
    const cols = rows.map((r) => r.column_name)
    expect(cols).toContain("email")
    expect(cols.filter((c) => /workspace|role/.test(c))).toEqual([])
  })

  it("stores e-mail addresses in lower case, once, whatever the case typed", async () => {
    const a = await principal()
    await asApp("INSERT INTO identity.users (id, email, name) VALUES ($1, 'lina@atlas.ma', 'Lina')", [a])
    const b = await principal()
    expect(await sqlState(() => asApp("INSERT INTO identity.users (id, email, name) VALUES ($1, 'Lina@Atlas.ma', 'Lina')", [b]))).toBe("23514")
    expect(await sqlState(() => asApp("INSERT INTO identity.users (id, email, name) VALUES ($1, 'lina@atlas.ma', 'Lina')", [b]))).toBe("23505")
  })

  it("accepts only Argon2id hashes, and no active account without a password (IAM-02)", async () => {
    const p = await principal()
    expect(await sqlState(() => asApp("INSERT INTO identity.users (id, email, name, password_hash) VALUES ($1, $2, 'X', '$2b$10$bcrypthash')", [p, `${p}@x.ma`]))).toBe("23514")
    expect(await sqlState(() => asApp("INSERT INTO identity.users (id, email, name, status) VALUES ($1, $2, 'X', 'active')", [p, `${p}@x.ma`]))).toBe("23514")
    expect(await sqlState(() => asApp("INSERT INTO identity.users (id, email, name, status, password_hash) VALUES ($1, $2, 'X', 'active', $3)", [p, `${p}@x.ma`, HASH]))).toBe("ok")
  })

  it("lets the member realm read and update accounts, never delete them; the console cannot touch them", async () => {
    expect(await sqlState(() => asApp("DELETE FROM identity.users"))).toBe("42501")
    expect(await sqlState(() => inTransaction(db.web, { role: "nx_platform" }, (c) => c.query("SELECT 1 FROM identity.users")))).toBe("42501")
    expect(await sqlState(() => inTransaction(db.web, { role: "nx_portal" }, (c) => c.query("SELECT 1 FROM identity.sessions")))).toBe("42501")
  })

  it("keeps a session's expiry and revocation consistent, and refresh tokens hashed", async () => {
    const p = await principal()
    const s = uuidv7()
    const xsrf = "a".repeat(64)
    expect(
      await sqlState(() =>
        asApp("INSERT INTO identity.sessions (id, principal_id, realm, idle_expires_at, absolute_expires_at, xsrf_hash) VALUES ($1, $2, 'member', now() + interval '13 hours', now() + interval '12 hours', $3)", [s, p, xsrf]),
      ),
    ).toBe("23514")
    await asApp("INSERT INTO identity.sessions (id, principal_id, realm, idle_expires_at, absolute_expires_at, xsrf_hash) VALUES ($1, $2, 'member', now() + interval '30 minutes', now() + interval '12 hours', $3)", [s, p, xsrf])
    expect(await sqlState(() => asApp("UPDATE identity.sessions SET revoked_at = now() WHERE id = $1", [s]))).toBe("23514") // a revocation states its reason
    expect(await sqlState(() => asApp("INSERT INTO identity.refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, 'plain-token', now())", [uuidv7(), s]))).toBe("23514")
  })

  it("refuses a single-use token that lives longer than 7 days or names nobody (IAM-10)", async () => {
    const hash = "b".repeat(64)
    expect(await sqlState(() => asApp("INSERT INTO identity.sign_in_tokens (id, purpose, email, token_hash, expires_at) VALUES ($1, 'invite', 'x@y.ma', $2, now() + interval '8 days')", [uuidv7(), hash]))).toBe("23514")
    expect(await sqlState(() => asApp("INSERT INTO identity.sign_in_tokens (id, purpose, token_hash, expires_at) VALUES ($1, 'reset', $2, now() + interval '1 day')", [uuidv7(), hash]))).toBe("23514")
    expect(await sqlState(() => asApp("INSERT INTO identity.sign_in_tokens (id, purpose, email, token_hash, expires_at) VALUES ($1, 'reset', 'x@y.ma', $2, now() + interval '1 day')", [uuidv7(), hash]))).toBe("ok")
  })
})

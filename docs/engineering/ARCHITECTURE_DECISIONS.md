# Nexora: architecture decisions

_Each decision has a status: **Accepted** (in force, often already in the code), **Proposed** (needs the owner's approval before the phase that uses it) or **Superseded**. The cahier des charges holds the full reasoning; this page is the short register. Last update: 10 November 2026: ADR-001 import-rule test built (Phase 1, step 4). 6 November 2026: ADR-003 amendment built (step 3); ADR-007 written into the API contract (step 2). Earlier: 5 November 2026, the owner accepted ADR-004, ADR-005, ADR-007 and ADR-008 (cahier des charges 2.2, decisions E1–E4)._

| # | Decision | Status | Where it lives |
|---|---|---|---|
| ADR-001 | Modular monolith | Accepted | Cahier §5 |
| ADR-002 | PostgreSQL only; isolation by RLS and a role per transaction | Accepted, built | `0001_foundation.sql`, `session.ts` |
| ADR-003 | Shared rules generated from the web repository | Accepted; amendment built (ARC-12, step 3) | `sync-core.mjs`, `packages/core/SOURCE`, `core-drift.yml` |
| ADR-004 | One error body | Accepted (E1) | Audit H-1; cahier ARC-08, ARC-13 |
| ADR-005 | Money representation | Accepted (E3) | Audit H-3; cahier §6.3 |
| ADR-006 | Queue, outbox and scheduler on PostgreSQL | Accepted, built in PR #5 | `src/jobs/*` |
| ADR-007 | Same-origin sessions, realm cookies, CSRF double-submit | Accepted (D1, E2); contract written (step 2) | Cahier D1, E2, Table 6; API contract §2; audit H-2, H-6 |
| ADR-008 | Vertical slice before module expansion | Accepted (E4) | Cahier §21.2, §21.5 |
| ADR-009 | One audit file, one execution tracker | Accepted | `CLAUDE.md` of both repositories |

---

## ADR-001 Modular monolith

**Decision.** One deployable server and one database. The same image runs as the web process and the worker process. Business modules (cahier §5.3) talk to each other only through application interfaces or the outbox. No microservices, broker, Redis or Kubernetes without a measured need.

**Why.** One developer, the capacity of cahier Table 4, and the cost of running several services.

**Consequence.** Module boundaries must be enforced in code: the import-rule test (audit M-2), built in Phase 1 step 4 (`src/architecture/import-rules.ts`; the rules are in `docs/ARCHITECTURE.md` §3.3).

## ADR-002 PostgreSQL only; isolation by RLS and a role per transaction

**Decision.**
- PostgreSQL 16 holds business data, audit, jobs, outbox and idempotency.
- Every tenant table has forced row-level security on `app.workspace_id`.
- Login users are NOINHERIT and use `SET LOCAL ROLE` per transaction.
- The console role has no privilege on tenant tables.

**Why.** A missed `WHERE workspace_id` must not leak data. Three independent barriers (cahier §9).

**Status.** Built and tested (`database.test.ts`).

## ADR-003 Shared rules generated from the web repository

**Decision.** The rules are written once, in `Nexora-Saas`. `scripts/sync-core.mjs` copies the pure ones into `packages/core`, and CI checks parity.

**Amendment (audit M-1, accepted as ARC-12; built in step 3, 6 November 2026).**
- `sync:core` writes the source commit to `packages/core/SOURCE`, and refuses a web checkout with uncommitted rule changes. ✅
- The CI parity job checks out that commit instead of `main` (`--check --at-source`). ✅
- A scheduled job (`core-drift.yml`, daily and on demand) reports drift from web `main` in its summary. ✅
- A release deploys the web application and the server from commits whose rules match: written into the release procedure with staging (B2).

**Why.** A merge in the web repository should not turn backend CI red without a backend change, and production must never run two versions of a rule.

## ADR-004 One error body (accepted, E1)

**Decision.** Every error the server returns, and the contract, use:

```json
{ "code": "err_fileTooLarge", "values": { "maxMb": 10 }, "requestId": "…", "message": "optional English fallback" }
```

- `code` is a key of the front end's catalogue (already enforced by `error-codes.test.ts`).
- `values` fills the translation.
- `requestId` equals the `X-Request-Id` header.
- `message` is optional and never shown when the code is known.
- Validation errors put the field in `values.field`.

**Changes:**

| Repository | Change |
|---|---|
| Nexora-Saas | `translate-error.ts` reads `values`, and still accepts `details` until the switch is done; `docs/API_CONTRACT.md` §2 updated |
| Nexora-Backend | Contract test of the error body shape; optional `message` |

**Why this and not `details`.** The server is already built with `values`, and the word matches the translation API (`t(key, values)`). The front-end change is one function and its test.

## ADR-005 Money representation (accepted, E3)

**Decision.**

| Where | Representation |
|---|---|
| Database | Integer minor units (`bigint` centimes); rates and quantities in `numeric` |
| Wire | Major units with two decimals (cahier DAT-05) |
| Shared rules | Keep JS numbers with `roundMoney` (round half away from zero, float error corrected) for now |

Conversion happens in **one adapter** at the repository edge (`toCents` / `fromCents`). Before B1d (invoicing):
- property tests prove that totals, VAT, withholding and payment allocations computed by the rules equal an integer recomputation for random inputs
- if they do not, the core money functions move to integer-cent signatures

**Why.** A rewrite of 22 tested rule files is not justified without a failing case. The risk is at the conversion boundary, which one adapter and the property tests close.

## ADR-006 Queue, outbox and scheduler on PostgreSQL

**Decision.**
- Jobs in `ops.jobs`, claimed with `FOR UPDATE SKIP LOCKED` under a lease, with backoff and a dead state.
- The outbox written in the command's transaction and relayed at least once into idempotent jobs.
- One scheduler at a time (advisory lock).

**Status.** Built in PR #5 (`src/jobs/*`, `src/worker/*`).

## ADR-007 Same-origin sessions, realm cookies, CSRF double-submit

**Accepted part (decision D1).**
- The API is on the same origin as the web application (`API_PROXY_TARGET`).
- `SameSite=Lax` HttpOnly cookies.
- `XSRF-TOKEN` cookie and `X-XSRF-TOKEN` header on writes.
- `Origin` check.

**Detail accepted on 5 November 2026 (E2, audit H-2), written into the API contract §2 on 6 November 2026 (step 2, audit H-6).**

| Item | Contract |
|---|---|
| Paths | Every path starts with its realm and version: `/app/v1/…` (members; workspace records under `/app/v1/workspaces/:wid/…`), `/portal/v1/…` (client contacts), `/platform/v1/…` (console host only), `/health/…` (probes). The workspace in the path is checked against the person's memberships (B11); a workspace id in a body or query is never trusted |
| Cookies | One session cookie per realm (cahier Table 6): `nx_m`, `nx_p`, `nx_s`. `HttpOnly; Secure; SameSite=Lax`, scoped to the realm's path (`/api/app`, `/api/portal`) or to the console host. A cookie of another realm gets `401` |
| Session limits | Console 15 min idle / 8 h absolute; members 30 min / 12 h; portal 2 h / 7 days. New session id at sign-in and on any change of rights; a password change ends the other sessions |
| Access and refresh | The access cookie lives 15 minutes and carries only the session id and realm; every request reloads the session. A `401` triggers one `POST <realm>/auth/refresh`, then a replay. The refresh token rotates on every use; a replaced token presented again revokes the session (reuse detection, cahier §8) |
| CSRF | The server sets a readable `XSRF-TOKEN` cookie; the web application sends `X-XSRF-TOKEN` on every write (axios `xsrfCookieName`, `xsrfHeaderName`, `withXSRFToken: true`, item F11). The server also checks `Origin` on writes. Missing or wrong: `403 err_csrf` |
| Edge guard | `src/proxy.ts` only checks that the cookie of the route's realm is present and sends a guest to the right sign-in with `?next=`. The server decides access on every request |

**Shipping.** The contract is written now; the code ships together with the first B1b endpoint, in one change on each side:

| Repository | Change |
|---|---|
| Nexora-Saas | `src/lib/myapi/client.ts` (realm base URL, workspace prefix, realm refresh, XSRF settings); `src/proxy.ts` (realm cookies); `e2e/mock-api.mjs` and `e2e/app.spec.ts` (realm paths, cookies, `XSRF-TOKEN`) |
| Nexora-Backend | Realm routers, session middleware, refresh rotation with reuse detection, CSRF and `Origin` middleware; contract tests of the cookies and the `err_csrf` body |

## ADR-008 Vertical slice before module expansion (accepted, E4)

**Decision.** After identity (B1b), the first business work is one complete flow on the real server:

1. Client.
2. Project.
3. Member.
4. Time entry.
5. Submit.
6. Approve or send back.

It uses the existing screens, React Query invalidation, optimistic locking (F5), audit and permission checks, with integration and end-to-end tests. The other modules of B1c start only after this slice passes its gate.

**Why.** It validates every architectural pattern once, on a workflow that touches people, relations, work, time and approvals.

## ADR-009 One audit file, one execution tracker

**Decision.**

| Document | Where | Rule |
|---|---|---|
| Audit | `docs/AUDIT.md`, the same report in both repositories | Replaced, never added to |
| Engineering documents (inventory, decisions, tracker) | `Nexora-Backend/docs/engineering/` | Updated with each phase |
| Screenshots | `docs/screenshots/` (audits and steps) and `documentation/screenshots/` (user manual) | — |

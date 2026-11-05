# Nexora: latest audit

_This is the only audit file, the same report in `Nexora-Saas` and `Nexora-Backend`. Each new audit, code review or report **replaces** this file in both repositories. Older versions stay in the git history._

**Last update:** 5 November 2026, **Phase 0: repository audit and baseline** of the engineering roadmap.
**Repositories and commits audited:**
- `yahyanaim/Nexora-Saas` `main` at `fdca5e7` (after #139)
- `yahyanaim/Nexora-Backend` `main` at `9d47c35` (after #4), plus the open pull request #5 (B1a step 3, not merged)

**Method:**
1. Read the README files, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/API_CONTRACT.md`, the cahier des charges v2.1 and the previous audit.
2. Compared them with the source.
3. Ran every test suite.

No application code was changed for this audit.

**Companion documents** (in `yahyanaim/Nexora-Backend`, `docs/engineering/`):
- `IMPLEMENTATION_INVENTORY.md`: status of every module
- `ARCHITECTURE_DECISIONS.md`: decisions taken and proposed
- `EXECUTION_TRACKER.md`: the roadmap mapped onto the cahier's phases, with every open item

## 1. Summary

The **front end is complete as a product prototype**: every screen, rule and workflow works, but on demonstration data stored in the browser. The **back end has a solid foundation and no business features yet**:
- Built and merged: the database, the roles and row-level security.
- Built in open PR #5: the unit of work, the audit trails, the outbox, the job queue and the worker.
- Not built: no sign-in, no permission check, no business endpoint.

The plan is sound and the code follows it. Two contract mismatches between the repositories must be fixed before the first real endpoint.

| Area | State | In one line |
|---|---|---|
| Front end (UI, rules, translations) | 🟢 Done (prototype) | 56 API modules (20 more test files), 870 tests, 9 languages, axe and Playwright in CI; all data in the browser |
| Shared rules (`packages/core`) | 🟢 Working, 🟡 not pinned | 125 generated files, CI parity check, but checked against a moving `main` |
| Database foundation | 🟢 Done | Six schemas, NOINHERIT logins, forced RLS on every tenant table, checksummed migrations, database tests on every table |
| Transactions, audit, outbox, jobs | 🟢 Done in PR #5 | Atomic unit of work, insert-only trails, SKIP LOCKED queue, scheduler, relay, worker; 27 more tests |
| Identity and permissions on the server | 🔴 Not started | No session, sign-in, membership or permission engine (phase B1b) |
| Business modules on the server | 🔴 Not started | Only `tenant.workspaces` and `tenant.departments` exist |
| Front-end ↔ back-end contract | 🟠 Two mismatches | Error body (`details` vs `values`) and session cookie names |
| Money | 🟡 Sound but float-based | Shared rules compute in JS numbers with a correcting round; the database stores integer centimes |

## 2. Baseline test results (run on 5 November 2026)

| Repository | Check | Result |
|---|---|---|
| Nexora-Saas | `tsc`, `eslint` (0 warnings), translations, `vitest` | ✅ 143 files, **870 tests** passing; no skipped or `.only` test |
| Nexora-Saas | CI on #139: build, Playwright e2e, axe (console and company pages), demo-mode guard, dependency audit | ✅ All green |
| Nexora-Backend `main` | `npm run check` with PostgreSQL 16 | ✅ 42 server + 136 core tests |
| Nexora-Backend PR #5 | `npm run check` with PostgreSQL 16, run three times | ✅ 69 server + 136 core tests, stable; CI green |
| Nexora-Backend | Database suites without `TEST_DATABASE_ADMIN_URL` | ⚠️ Skipped locally by design; **never skipped in CI** (a missing URL fails the build) |

## 3. Strengths (keep as they are)

| # | Strength | Evidence |
|---|---|---|
| S-1 | Defence in depth for tenancy: forced RLS, NOINHERIT logins, `SET LOCAL ROLE` per transaction, console role with no tenant privilege | Backend `apps/server/src/db/migrations/0001_foundation.sql`, `src/db/session.ts`; tests in `src/db/database.test.ts` (cross-workspace reads and writes, pooled connection left clean) |
| S-2 | Every tenant table checked automatically: tenant key, common columns, composite foreign keys, no float or money column | Backend `database.test.ts` "schema rules" |
| S-3 | Atomic unit of work with audit and outbox in the same transaction; audit trails insert-only even for the owner | Backend `src/db/unit-of-work.ts`, `migrations/0005_audit_trails.sql`, `unit-of-work.test.ts` (PR #5) |
| S-4 | Queue without a second store, with leases, backoff, dead state, fairness and dedupe | Backend `src/jobs/*.ts`, `jobs.test.ts` (PR #5) |
| S-5 | One source of business rules, generated into the server with a CI parity check | Backend `scripts/sync-core.mjs`, `.github/workflows/ci.yml` job `core-parity` |
| S-6 | Errors as catalogue codes, never sentences or stack traces; a test fails on an unknown code | Backend `src/http/errors.ts`, `src/error-codes.test.ts` |
| S-7 | Front end ready for a server: one API layer, React Query, demo mode isolated and blocked in production builds | Front end `src/lib/api/*`, `src/lib/auth/demo-mode.ts`, CI job "Demo mode is blocked in production builds" |
| S-8 | A specification precise enough to build from: 337 requirements with acceptance criteria | Backend `docs/CAHIER_DES_CHARGES.md` |

## 4. Findings

Severity: **Critical** blocks real use, **High** must be fixed before the phase that depends on it, **Medium** should be fixed in the planned phase, **Low** when convenient.

### 4.1 Critical

| # | Finding | Where | Why it matters | Recommendation | Phase |
|---|---|---|---|---|---|
| C-1 | **No identity or authorization on the server.** The server answers only `/health/*`. Permissions exist only as UI checks (`can()`), and sign-in works only against a mock or in demo mode. | Backend `apps/server/src/http/app.ts:43-76`; front end `src/lib/auth/*`, `src/lib/api/auth-apis.ts:112-130` | No real company can use Nexora: any rule enforced only in the browser can be bypassed | Build B1b: realm sessions, sign-in, CSRF, memberships, permission engine, IAM-01 actor rule, with negative tests | 3 |
| C-2 | **No business data on the server.** All 56 front-end API modules read and write the browser store. The server has 2 business tables. | Front end `src/lib/api/*.ts` (17 call `isDemoMode()`; the rest are store-only); backend `migrations/0003`, `0004` | Data is per browser, lost when site data is cleared, and not shared between users | Vertical slice first (phase 4), then modules (phases 5 to 7) | 4–7 |

### 4.2 High

| # | Finding | Where | Why it matters | Recommendation | Phase |
|---|---|---|---|---|---|
| H-1 | **Error body mismatch.** The contract and the front end expect `{ code, message, details? }`. The server sends `{ code, values, requestId }`. | Front end `docs/API_CONTRACT.md:74`, `src/lib/errors/translate-error.ts:18-25` (reads `details`); backend `apps/server/src/http/app.ts:62-74`, `src/http/errors.ts` | Values such as `{maxMb}` or `{min}` would be lost in every translated message, and a validation error's field would not reach the form | ADR-004: one canonical body `{ code, values, requestId, message? }`. The front end reads `values`, with `details` accepted during the switch. The contract is updated. A contract test runs on both sides | 1 |
| H-2 | **Session model mismatch.** The front end's edge guard looks for a cookie named `token` and calls `/auth/refresh`. The cahier names realm cookies `nx_m` / `nx_p` / `nx_s` with a CSRF double-submit, and the front end does not send `X-XSRF-TOKEN` yet (F11). | Front end `src/proxy.ts:58`, `src/lib/myapi/client.ts:23-40`; cahier Table 13, §5.5 step 2 | The first real sign-in would fail at the edge guard, and every write would get `err_csrf` | Decide cookie names and the refresh flow in ADR-007; change `proxy.ts`, the axios XSRF settings and the contract in the same change as B1b's first endpoint | 1 (decision), 3 (code) |
| H-3 | **Money is computed in JS numbers.** `roundMoney` corrects float error and rounds half away from zero. 22 shared rule files (tests excluded) use it and reach the server. The database stores `bigint` centimes. | Front end `src/lib/workforce/money.ts:8-30`; backend `packages/core/src/lib/workforce/money.ts`; cahier §6.3 | Results are deterministic (same IEEE arithmetic everywhere), but every conversion between centimes and numbers is a place for an off-by-one-centime error in totals, VAT or allocations | ADR-005: convert only at the repository edge (`toCents` / `fromCents` in one adapter); property tests that line sums, VAT and allocations match integer recomputation; consider integer-cent signatures for the core money functions before B1d | 6 (tests from 4) |
| H-4 | **No idempotency keys.** Commands that create numbers, money or files are not protected against double submission (TRX-04, front-end item F4). | Neither repository has `ops.idempotency_keys` or an `Idempotency-Key` header | A double click or retry could issue two invoices or record two payments | Build the table, middleware and front-end header before the first money command | 6 (before B1d) |
| H-5 | **Optimistic locking not wired end to end.** The database bumps `version` and a test proves first-save-wins. But there is no command helper returning `CONFLICT_STALE_VERSION`, and the front end does not send `version` (F5). | Backend `0001_foundation.sql` `stamp_row`, `database.test.ts` "optimistic lock"; front-end item F5 | Two editors would silently overwrite each other | A repository helper that updates `WHERE version = $n` and maps 0 rows to the error; F5 in the slice | 4 |

### 4.3 Medium

| # | Finding | Where | Recommendation | Phase |
|---|---|---|---|---|
| M-1 | **Shared rules checked against a moving `main`.** The parity job checks out `Nexora-Saas` `ref: main`, and `@nexora/core` stays at version `0.1.0` with no record of its source commit. A web merge can turn backend CI red, or the two can be deployed with different rules. | Backend `.github/workflows/ci.yml` job `core-parity`; `packages/core/package.json` | Record the source commit in `packages/core/SOURCE` (written by `sync:core`); CI checks parity against that commit; a scheduled job reports drift from web `main`; releases deploy web and server from matching commits | 1 |
| M-2 | **Architecture boundaries are documented, not enforced.** There is no test that forbids domain → HTTP or infrastructure imports, or cross-module imports (ARC-06). The server has no module folders yet. | Backend `apps/server/src` | Add an import-rule test (e.g. dependency-cruiser) with the first module folder | 1 (rule), 4 (first module) |
| M-3 | **Worker health is not visible.** `queueStats` exists, but the worker has no heartbeat, health endpoint or metrics output (QAL-08, JOB-07 alert). | Backend `src/jobs/queue.ts` `queueStats`, `src/worker/worker.ts` (PR #5) | A worker heartbeat row plus a periodic metrics log; the operations page reads both | 2 (close-out) |
| M-4 | **Audit sealing and retention not built** (TRL-05, TRL-06). | Backend `0005_audit_trails.sql` (PR #5, documented as later) | `audit.seals` + `audit.seal` and `audit.verify` jobs; the retention function as the only exception to the insert-only trigger | 2 (close-out) or 8 |
| M-5 | **No request log with workspace and principal** (QAL-07). Only errors are logged. | Backend `src/http/app.ts` | An access log line per request with request id, route, status, duration, workspace and principal once sessions exist | 3 |
| M-6 | **Front-end items the server needs**: F1–F8, F11, F12 open (F9, F10 done). | Cahier §21.4 | Each is merged before its phase (MIG-07); tracked in the execution tracker | 3–7 |

### 4.4 Low

| # | Finding | Where | Recommendation |
|---|---|---|---|
| L-1 | The session context guard (UUID check, closed role list) has no unit test | Backend `src/db/session.ts:20-31` | Add two negative tests (malformed id, unknown role) |
| L-2 | 3 low vulnerabilities in `deepmerge` inside the `shadcn` CLI (dev only) | Front end `package-lock.json` | Wait for a `shadcn` release |
| L-3 | Six front-end files over 600 lines | Front end, e.g. `work-billing-api.ts`, `platform-billing-api.ts` | Split each when its module is wired to the server |
| L-4 | The demo sign-in fallback lives in the production API module | Front end `src/lib/api/auth-apis.ts:120-130` | Keep it behind `isDemoMode()` (already guarded, and blocked in production builds); move it to a demo adapter when auth is wired |

## 5. Opinion on the engineering roadmap

The roadmap matches the cahier des charges and the code. It adds three useful things:
- an explicit **contract and boundary hardening** phase, needed because of H-1, H-2 and M-1
- a **vertical slice** before module expansion, which lowers risk by validating auth, tenancy, transactions, audit and the front-end wiring on one workflow first
- the **engineering standards and definition of done**

Phase 2 of the roadmap is already almost done (B1a steps 2 and 3); only its close-out items remain (M-3, M-4, L-1). The 20–33 week estimate agrees with the cahier's 27 weeks (34 with contingency).

Points to adjust:

| # | Point | Proposal |
|---|---|---|
| R-1 | The roadmap asks for `docs/engineering/BASELINE_AUDIT.md`, but the repositories keep **one** audit file | The baseline audit is this file; the other three documents are in `docs/engineering/` of the backend |
| R-2 | Phase 2 duplicates work already merged or in PR #5 | Phase 2 becomes "close-out": merge PR #5, then M-3, M-4 (seal), L-1 |
| R-3 | B1a step 4 (guard, privilege and audit suites) is not named in the roadmap | It is the exit gate of phases 1–2: the import-rule test (M-2), the privilege suite and the audit scan (TRL-04) |
| R-4 | The vertical slice uses employees, clients, projects, time and approvals: half of B1c | Phase 4 = the slice; phase 5 = the rest of B1c (the 12 CRM and 12 work features, settings, leave) |

The mapping of every roadmap phase onto the cahier's phases, with each open item, is in the execution tracker.

## 6. What is done and what is not

| Done | Not done |
|---|---|
| Every screen and workflow of the front end, on demo data | Any business data on the server |
| Error catalogue (432 keys) and 9 languages | One agreed error body (H-1) |
| Database: schemas, roles, RLS, migrations, stamps | Sign-in, sessions, CSRF, memberships, permissions (B1b) |
| Unit of work, audit trails, outbox, queue, scheduler, worker (PR #5, open) | Idempotency keys (H-4), optimistic-lock helper (H-5) |
| Shared rules with parity check | Pinned rule version (M-1), import-rule test (M-2) |
| CI: typecheck, tests on real PostgreSQL, dependency audit, e2e, axe | Worker health and metrics (M-3), audit seal and retention (M-4) |
| Specification, architecture, database docs, interactive diagrams | Staging, backups, monitoring, load test, penetration test (B2, B3) |

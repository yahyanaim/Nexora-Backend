# Nexora: latest audit

_This is the only audit file, the same report in `Nexora-Saas` and `Nexora-Backend`. Each new audit, code review or report **replaces** this file in both repositories. Older versions stay in the git history._

**Last update:** 10 November 2026, Phase 1 step 4 (import rules and session guard tests). The audit itself is the **Phase 0 repository audit and baseline** of 5 November 2026. Each later step is recorded in **§8 Progress log**, and the findings table marks what is closed.
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
| Shared rules (`packages/core`) | 🟢 Working and pinned (updated 6 November) | 125 generated files; CI checks them against the web commit in `packages/core/SOURCE` (step 3); a daily report shows drift from web `main` |
| Database foundation | 🟢 Done | Six schemas, NOINHERIT logins, forced RLS on every tenant table, checksummed migrations, database tests on every table |
| Transactions, audit, outbox, jobs | 🟢 Done in PR #5 | Atomic unit of work, insert-only trails, SKIP LOCKED queue, scheduler, relay, worker; 27 more tests |
| Identity and permissions on the server | 🔴 Not started | No session, sign-in, membership or permission engine (phase B1b) |
| Business modules on the server | 🔴 Not started | Only `tenant.workspaces` and `tenant.departments` exist |
| Front-end ↔ back-end contract | 🟡 Agreed, partly built (updated 6 November) | Error body agreed and tested on both sides (step 1); sessions, cookies, CSRF and realm paths written into the contract (step 2), code in B1b |
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
| H-1 | **Error body mismatch.** The contract and the front end expect `{ code, message, details? }`. The server sends `{ code, values, requestId }`. | Front end `docs/API_CONTRACT.md:74`, `src/lib/errors/translate-error.ts:18-25` (reads `details`); backend `apps/server/src/http/app.ts:62-74`, `src/http/errors.ts` | Values such as `{maxMb}` or `{min}` would be lost in every translated message, and a validation error's field would not reach the form | ADR-004: one canonical body `{ code, values, requestId, message? }`. The front end reads `values`, with `details` accepted during the switch. The contract is updated. A contract test runs on both sides | 1. **Closed (step 1)** |
| H-2 | **Session model mismatch.** The front end's edge guard looks for a cookie named `token` and calls `/auth/refresh`. The cahier names realm cookies `nx_m` / `nx_p` / `nx_s` with a CSRF double-submit, and the front end does not send `X-XSRF-TOKEN` yet (F11). | Front end `src/proxy.ts:58`, `src/lib/myapi/client.ts:23-40`; cahier Table 6, §5.5 step 2 | The first real sign-in would fail at the edge guard, and every write would get `err_csrf` | Decide cookie names and the refresh flow in ADR-007; change `proxy.ts`, the axios XSRF settings and the contract in the same change as B1b's first endpoint | 1 (decision), 3 (code). **Decision and contract done (step 2)**; code in B1b |
| H-3 | **Money is computed in JS numbers.** `roundMoney` corrects float error and rounds half away from zero. 22 shared rule files (tests excluded) use it and reach the server. The database stores `bigint` centimes. | Front end `src/lib/workforce/money.ts:8-30`; backend `packages/core/src/lib/workforce/money.ts`; cahier §6.3 | Results are deterministic (same IEEE arithmetic everywhere), but every conversion between centimes and numbers is a place for an off-by-one-centime error in totals, VAT or allocations | ADR-005: convert only at the repository edge (`toCents` / `fromCents` in one adapter); property tests that line sums, VAT and allocations match integer recomputation; consider integer-cent signatures for the core money functions before B1d | 6 (tests from 4) |
| H-4 | **No idempotency keys.** Commands that create numbers, money or files are not protected against double submission (TRX-04, front-end item F4). | Neither repository has `ops.idempotency_keys` or an `Idempotency-Key` header | A double click or retry could issue two invoices or record two payments | Build the table, middleware and front-end header before the first money command | 6 (before B1d) |
| H-5 | **Optimistic locking not wired end to end.** The database bumps `version` and a test proves first-save-wins. But there is no command helper returning `CONFLICT_STALE_VERSION`, and the front end does not send `version` (F5). | Backend `0001_foundation.sql` `stamp_row`, `database.test.ts` "optimistic lock"; front-end item F5 | Two editors would silently overwrite each other | A repository helper that updates `WHERE version = $n` and maps 0 rows to the error; F5 in the slice | 4 |
| H-6 | **Realm prefixes missing from the contract** (found in step 2). The cahier puts every path under its realm and version (`/app/v1/…`, `/app/v1/workspaces/:wid/…`, `/portal/v1/…`, `/platform/v1/…`; ARC-07, B4, Table 6). The contract only proposed `/workspaces/:wid/…`, and the front end calls bare paths. The cahier's decision E2 also pointed to Table 13 instead of Table 6. | Front end `docs/API_CONTRACT.md` §2 (Base URL, Workspace scope), `src/lib/myapi/client.ts`; cahier Table 1d E2 | The first real endpoint would not be found, and a cookie scoped to a realm path would not be sent | Write the prefixes into the contract; the client adds them in one place when B1b switches the cookies; correct the cahier's reference | 1 (contract). **Closed for the docs (step 2)**; code in B1b |

### 4.3 Medium

| # | Finding | Where | Recommendation | Phase |
|---|---|---|---|---|
| M-1 | **Shared rules checked against a moving `main`.** The parity job checks out `Nexora-Saas` `ref: main`, and `@nexora/core` stays at version `0.1.0` with no record of its source commit. A web merge can turn backend CI red, or the two can be deployed with different rules. | Backend `.github/workflows/ci.yml` job `core-parity`; `packages/core/package.json` | Record the source commit in `packages/core/SOURCE` (written by `sync:core`); CI checks parity against that commit; a scheduled job reports drift from web `main`; releases deploy web and server from matching commits | 1. **Closed (step 3)**; the release rule comes with staging (B2) |
| M-2 | **Architecture boundaries are documented, not enforced.** There is no test that forbids domain → HTTP or infrastructure imports, or cross-module imports (ARC-06). The server has no module folders yet. | Backend `apps/server/src` | Add an import-rule test (e.g. dependency-cruiser) with the first module folder | 1 (rule), 4 (first module). **Closed for the rule (step 4)**: the test runs on every file, without a new dependency; the first module folders come with the slice |
| M-3 | **Worker health is not visible.** `queueStats` exists, but the worker has no heartbeat, health endpoint or metrics output (QAL-08, JOB-07 alert). | Backend `src/jobs/queue.ts` `queueStats`, `src/worker/worker.ts` (PR #5) | A worker heartbeat row plus a periodic metrics log; the operations page reads both | 2 (close-out) |
| M-4 | **Audit sealing and retention not built** (TRL-05, TRL-06). | Backend `0005_audit_trails.sql` (PR #5, documented as later) | `audit.seals` + `audit.seal` and `audit.verify` jobs; the retention function as the only exception to the insert-only trigger | 2 (close-out) or 8 |
| M-5 | **No request log with workspace and principal** (QAL-07). Only errors are logged. | Backend `src/http/app.ts` | An access log line per request with request id, route, status, duration, workspace and principal once sessions exist | 3 |
| M-6 | **Front-end items the server needs**: F1–F8, F11, F12 open (F9, F10 done). | Cahier §21.4 | Each is merged before its phase (MIG-07); tracked in the execution tracker | 3–7 |

### 4.4 Low

| # | Finding | Where | Recommendation |
|---|---|---|---|
| L-1 | The session context guard (UUID check, closed role list) has no unit test | Backend `src/db/session.ts:20-31` | Add two negative tests (malformed id, unknown role). **Closed (step 4)** |
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
| Error catalogue (432 keys) and 9 languages; one agreed error body (H-1, step 1); session and CSRF contract (H-2, H-6, step 2) | Session code on both sides (B1b) |
| Database: schemas, roles, RLS, migrations, stamps | Sign-in, sessions, CSRF, memberships, permissions (B1b) |
| Unit of work, audit trails, outbox, queue, scheduler, worker (PR #5, open) | Idempotency keys (H-4), optimistic-lock helper (H-5) |
| Shared rules with parity check, pinned to a web commit (M-1, step 3); import-rule test (M-2) and session guard tests (L-1, step 4) | Worker heartbeat (M-3), audit seal (M-4), B1a exit gate |
| CI: typecheck, tests on real PostgreSQL, dependency audit, e2e, axe | Worker health and metrics (M-3), audit seal and retention (M-4) |
| Specification, architecture, database docs, interactive diagrams | Staging, backups, monitoring, load test, penetration test (B2, B3) |

## 7. Decisions taken after this audit (5 November 2026)

The owner approved Phase 0 and the plan. The decisions are written into the cahier des charges, **version 2.2**.

| Decision | Content | Cahier |
|---|---|---|
| E1 (ADR-004) | One error body `{ code, values, requestId, message? }` | §1.2, ARC-08, ARC-13 |
| E2 (ADR-007) | Realm cookies `nx_m`, `nx_p`, `nx_s`, rotating refresh, `X-XSRF-TOKEN` | §1.2, §8.2 |
| E3 (ADR-005) | Money: centimes in the database, one conversion adapter, property tests before invoicing | §1.2, §6.3 |
| E4 (ADR-008) | Vertical slice before the rest of B1c | §1.2, §21.2 |
| E5 | The engineering roadmap, standards and definition of done apply | §21.5 |

New requirements:
- **ARC-12**: pinned shared rules
- **ARC-13**: contract tests
- **JOB-09**: worker heartbeat

Phase B1a now includes the contract and foundation hardening (4 weeks). The plan is 28 weeks, about 35 with contingency. The next six pull requests are listed in `docs/engineering/EXECUTION_TRACKER.md` (Phase 1).

## 8. Progress log

Every step of the plan adds a row here, in both repositories, with its pull requests and the tests run before the merge. The tracker (`docs/engineering/EXECUTION_TRACKER.md`) shows what is next.

| Date | Step | Pull requests | What changed | Tests before merge | State |
|---|---|---|---|---|---|
| 5 Nov 2026 | Phase 0: audit and baseline | Nexora-Backend #5, Nexora-Saas #140 | This audit; inventory, decisions and tracker in `docs/engineering/`; B1a step 3 (unit of work, audit trails, outbox, queue, worker) merged with it | Front end 870; server 69 + core 136 on PostgreSQL 16; CI green | ✅ merged |
| 5 Nov 2026 | Cahier des charges 2.2 | Nexora-Backend #6, Nexora-Saas #141 | Decisions E1–E5; ARC-12, ARC-13, JOB-09; B1a 4 weeks; §21.5 (standards, definition of done); audit §7 and README | Docs only; CI green | ✅ merged |
| 5–6 Nov 2026 | Phase 1, step 1: one error body (E1, H-1) | Nexora-Saas #142, Nexora-Backend #7 | Server: `error-body.ts` with the body `{ code, values, requestId, message? }` and its contract test. Front end: `translateError` reads `values` (still `details` during the switch); contract §2. `packages/core` synced after the web merge | Front end 871; server 72 + core 136; CI green on both | ✅ merged |
| 6 Nov 2026 | Phase 1, step 2: session and CSRF contract (E2, H-2, H-6) | Nexora-Saas #143, Nexora-Backend #8 | Contract §2: realm and version paths, cookies `nx_m` / `nx_p` / `nx_s` with their limits, 15-minute access cookie and rotating refresh, `X-XSRF-TOKEN` and `Origin` check, edge guard, the list of files switched with B1b. ADR-007 written out; cahier E2 now points to Table 6; finding H-6 added; tracker and inventory updated | Docs only; front end 871; server 72 + core 136; CI green on both | ✅ merged |
| 6 Nov 2026 | Phase 1, step 3: pinned shared rules (ARC-12, M-1) | Nexora-Backend #9, Nexora-Saas #144 | `sync:core` records the web commit in `packages/core/SOURCE` (now `c060f5b`) and refuses uncommitted rule changes; the CI parity job checks that commit (`--check --at-source`), so a web merge no longer turns backend CI red; new daily drift report `core-drift.yml` against web `main`; 5 tests of the script; README, architecture, ADR-003, tracker and inventory updated | Server 72 + core 136 + script 5 on PostgreSQL 16; CI green on both | ✅ merged |
| 10 Nov 2026 | Phase 1, step 4: import rules and session guard tests (ARC-02, ARC-06, M-2, L-1) | Nexora-Backend and Nexora-Saas, step 4 PRs | New `src/architecture/import-rules.ts` and its test: every source file is checked on each test run; domain, ports and application cannot reach Express, `pg`, Node or infrastructure; a module reaches another only through `application/index.ts`; platform folders kept apart; production code never imports tests; an unknown folder fails. Checked by hand: a forbidden import added to `db/` fails the build. `session.test.ts`: malformed ids and unknown roles refused before any connection. `ARCHITECTURE.md` §3.3, ADR-001, tracker and inventory updated | Server 88 (16 new) + core 136 + script 5 on PostgreSQL 16; CI | 🔄 open, waits for the owner |

**Next:** step 5, worker heartbeat and audit seal (JOB-09, TRL-05, M-3, M-4), after the owner's go.

# Nexora: architecture

_How Nexora is built: the web application, the server, and how they share one set of business rules. The full requirements are in [`CAHIER_DES_CHARGES.md`](CAHIER_DES_CHARGES.md) (§5 architecture, §6 database, §15 transactions). This page says what exists today and what each part becomes._

**Interactive diagrams.** Of what is built, each box linked to its source lines: [architecture](diagrams/architecture.html), [a request step by step](diagrams/request-sequence.html), [the database](diagrams/database.html), [how a rule change reaches the server](diagrams/rule-sync.html). Of the target design, each box linked to the cahier des charges: [target layout](diagrams/target-layout.html), [layers of a module](diagrams/module-layers.html), [from an hour worked to a payment](diagrams/core-chain.html), [the three tenant barriers](diagrams/tenant-barriers.html), [issuing an invoice](diagrams/issue-invoice.html). See [`diagrams/README.md`](diagrams/README.md) for how to open and regenerate them.

**Last update:** 5 November 2026, after phase B1a step 3.

## 1. The two repositories

| Repository | What it holds | State |
|---|---|---|
| [`yahyanaim/Nexora-Saas`](https://github.com/yahyanaim/Nexora-Saas) | The web application (Next.js 16, React 19, 9 languages): every screen, the API layer (56 modules, 362 functions) and the business rules. Runs today on demonstration data stored in the browser | Complete |
| [`yahyanaim/Nexora-Backend`](https://github.com/yahyanaim/Nexora-Backend) (this one) | The server, the database, the jobs, and `packages/core`: the business rules shared with the web application | Phase B1a, step 3 of 4 |

The contract between them is `docs/API_CONTRACT.md` in the web repository: every path, shape and error code the server must answer. A test there keeps it in step with the web application's API layer.

```
 Browser
    │  HTTPS, same origin (decision D1)
    ▼
 Nexora-Saas: Next.js ──── /api/* forwarded (API_PROXY_TARGET) ────┐
   screens, API modules                                            │
   (demo mode: browser store)                                      ▼
                                              Nexora-Backend: apps/server (web process)
                                                 HTTP adapter → modules → PostgreSQL
                                              apps/server (worker process, same image)
                                                 jobs, scheduler, outbox → e-mail, files
        both import ──────────────► packages/core: rules, types, money, error codes
```

Interactive versions: [target layout](diagrams/target-layout.html) and [what is built today](diagrams/architecture.html).

## 2. Shared business rules: `packages/core`

The rules are written once, in the web repository (`src/lib/workforce`, `src/lib/platform`, `src/lib/errors`), where they were built and tested with the screens.

- `scripts/sync-core.mjs` copies every **pure** rule file, its types and its tests into `packages/core/src`, and rewrites `@/…` imports into relative ones. A file that reaches browser storage, the API layer, React, translations or an unknown package is left out, and so is every file that imports it. Today: 125 files (57 workforce and 12 platform rule files, types, the error catalogue, 25 test files).
- The rule code is type-checked **without DOM or Node types**, so a browser or Node API cannot slip in. Tests may use the DOM, for example to read generated XML.
- **CI parity check (ARC-01):** on every pull request, CI checks out the web repository's `main`, re-runs the sync with `--check`, and fails if anything differs. A rule changes in the web repository first; then `npm run sync:core -- ../Nexora-Saas` brings it here.
- Never edit a generated file. Each one starts with a header saying where it comes from. The only hand-written files are `src/lib/id.ts` and its test.

## 3. The server: `apps/server`

### 3.1 Built today (B1a steps 1 to 3)

| Part | File | What it does | Requirements |
|---|---|---|---|
| Configuration | `src/config/config.ts` | The only place that reads the environment. Production refuses to start with a missing, short or example `SESSION_SECRET`, or an `APP_ORIGIN` that is not https, and lists every problem | ARC-04 |
| HTTP application | `src/http/app.ts` | Request id (kept when well-formed), security headers, 1 MB body limit, `/health/live` and `/health/ready` (readiness checks plug in), unknown routes and errors returned as `{ code, values, requestId }` | QAL-05, SCR-04 |
| Errors | `src/http/errors.ts`, `src/http/error-body.ts` | `AppError(status, code, values)`. Every error leaves as `{ code, values, requestId, message? }` (decision E1); a contract test checks the body on every error path, and the web application tests its translation with the same body. Codes are the web catalogue's keys; a test fails if the server uses a code the catalogue lacks | ARC-08, ARC-13 |
| Entry points | `src/main.ts`, `src/worker-main.ts` | The web process: on SIGTERM stops taking requests, closes the pool and exits within 20 s. The worker process (same image, `npm run worker`): on SIGTERM stops claiming and gives back an unfinished job within 30 s | ARC-05, QAL-13, JOB-08 |
| Database | `src/db/` | Forward-only checksummed migrations under an advisory lock; six schemas and the group roles; forced row-level security on every tenant table; actor and version stamps; one transaction per unit of work with `SET LOCAL ROLE` and the request context; readiness checks the database and pending migrations. Details in [`DATABASE.md`](DATABASE.md) | DAT-01–DAT-14, TEN-05, TEN-10, QAL-05, QAL-06 |
| Ids | `src/db/uuid.ts` | UUID v7, time-ordered, generated by the server | DAT-03 |
| Unit of work | `src/db/unit-of-work.ts` | `runUnitOfWork`: one transaction holds the change, its audit events, its outbox events and the jobs it starts; if one cannot be written, nothing is. Secrets are masked in audit values. Deadlocks and serialization failures are retried three times | TRX-01, TRX-02, TRX-08, TRL-01, TRL-04 |
| Audit trails | `migrations/0005_audit_trails.sql` | Workspace, identity and console trails; insert-only for every role, the owner included; a company reads only its own events; the actor is always the request's principal | TRL-02, TRL-03, AUD-01 |
| Job queue | `src/jobs/queue.ts` | Jobs in `ops.jobs`, claimed with `SKIP LOCKED` under a lease; backoff 1, 2, 4… minutes (at most 60), then dead; expired leases put back; one job of a type per workspace at a time; depth, oldest due job, dead jobs and outbox lag measured | JOB-01, JOB-02, JOB-06, JOB-07 |
| Scheduler | `src/jobs/scheduler.ts` | Recurring jobs of `ops.schedules`; one scheduler at a time (advisory lock); each run enqueued once | JOB-04 |
| Outbox relay | `src/jobs/outbox-relay.ts` | Turns each event into the jobs its route asks for, at least once, with a dedupe key per event and job, so a second delivery adds nothing | TRX-05, NTF-01 |
| Worker | `src/worker/worker.ts` | Each turn: put back expired leases, run the scheduler, relay the outbox, run one job. Tenant work of a job runs under `nx_app` in its workspace as `system:<job>` | JOB-03, JOB-08 |

### 3.2 Target shape (cahier des charges §5)

A **modular monolith**: one deployable server, one PostgreSQL database, no microservices, broker or cache unless a measured need appears.

**Modules** (§5.3): identity, workspace, people, relations, work, time, approvals, sales, purchases, finance, analytics, files, notifications, platform, ops. A module calls another only through its application interface or the outbox (ARC-06).

**Layers inside a module** (§5.2):

```
HTTP adapter      route, Zod schema, principal from the session, error codes
Application       commands and queries, permission and record rules, unit of work, audit, outbox
Domain            entities, state machines, invariants, rules from packages/core
Ports             repositories, clock, ids, storage, mailer, payment provider
Infrastructure    PostgreSQL repositories, S3 storage, e-mail adapter, job handlers
```

Interactive version: [layers of a module](diagrams/module-layers.html).

**Request lifecycle** (§5.5), in this order for every request:
1. Request id, size limit, headers, rate limits.
2. Session cookie of the route's realm; CSRF double-submit and `Origin` check on writes.
3. The account and session are loaded and must be active.
4. The workspace in the path is checked against the person's active memberships.
5. The input is validated, and unknown fields are refused.
6. The permission check runs.
7. One transaction: tenant set for row-level security, record rules, change, audit, outbox, commit.
8. The response is shaped by role.

**Database** (§6): PostgreSQL 16, six schemas (`identity`, `tenant`, `platform`, `ops`, `audit`, `archive`), separate roles (`nx_app`, `nx_portal`, `nx_platform`, `nx_support`, `nx_dataops`…), composite tenant keys, forced row-level security, money in centimes, gap-free numbering from locked sequence rows, append-only audit.

**Processes**: the same Docker image runs as the **web** process and as the **worker** process (jobs, scheduler, outbox relay).

## 4. Delivery

| Phase | Content | State |
|---|---|---|
| — | Phase 0 audit and engineering roadmap ([`engineering/`](engineering/EXECUTION_TRACKER.md)); cahier des charges 2.2 | ✅ |
| B1a | Repository, `packages/core`, skeleton, CI | ✅ Step 1 |
| B1a | PostgreSQL schemas and roles, migrations, row-level security | ✅ Step 2 |
| B1a | Unit of work, audit, outbox, job queue, worker | ✅ Step 3 |
| B1a | **[2.2]** Contract and foundation hardening; guard, privilege and audit suites (exit gate) | Next |
| B1b–B3 | Identity, modules, money, analytics, console, operations, security tests | Planned (cahier des charges §21.2) |

## 5. Commands

| Command | What it does |
|---|---|
| `npm ci` | Install |
| `npm run check` | Type checks and every test |
| `npm run sync:core -- ../Nexora-Saas` | Copy the rules from a local web repository |
| `npm run check:core -- ../Nexora-Saas` | Check they match |
| `npm run dev -w @nexora/server` | Start the web process on port 4000 |
| `npm run worker -w @nexora/server` | Start the worker process |

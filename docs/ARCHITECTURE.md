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
- **Pinned version (ARC-12):** the sync writes the web commit it copied from into `packages/core/SOURCE`. It refuses a web checkout with uncommitted changes under `src/`, because that commit would not reproduce the package.
- **CI parity check (ARC-01, ARC-12):** on every pull request, CI checks out the web commit recorded in `SOURCE`, re-runs the sync with `--check --at-source`, and fails if anything differs. A merge in the web repository therefore never turns backend CI red on its own.
- **Drift report (ARC-12):** `.github/workflows/core-drift.yml` compares the package with the web repository's `main` every day (and on demand). A red run lists the changed files in its summary: run `npm run sync:core -- ../Nexora-Saas` and open a pull request. A web commit that changes no rule is not drift.
- **Releases:** the web application and the server are deployed from commits whose rules match (the server's `SOURCE` names the web commit); the release procedure comes with staging (B2).
- The script's own tests (`scripts/sync-core.test.mjs`, run by `npm test`) build a small web repository in a temporary folder and check the pin, the drift and the refusals.
- Never edit a generated file. Each one starts with a header saying where it comes from. The only hand-written files are `src/lib/id.ts` and its test.

## 3. The server: `apps/server`

### 3.1 Built today (B1a complete: steps 1 to 3 and Phase 1 steps 1 to 6)

| Part | File | What it does | Requirements |
|---|---|---|---|
| Configuration | `src/config/config.ts` | The only place that reads the environment. Production refuses to start with a missing, short or example `SESSION_SECRET` or `ENCRYPTION_KEY` (or the two equal), or an `APP_ORIGIN` that is not https, and lists every problem | ARC-04 |
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
| Heartbeat | `src/jobs/heartbeat.ts` | A timer, apart from the turns, writes the worker's row with the queue metrics every 30 s and logs them; a clean stop is recorded. `workerHealth()` lists live and missing workers for the operations page and the alert | JOB-07, JOB-09, QAL-08 |
| Audit seals | `migrations/0007_heartbeats_seals.sql`, `src/jobs/audit-seal.ts` | `audit.seal` every 5 minutes, `audit.verify` every day: hash chains over the three trails; any change, removal or insertion is reported, and the verify job stays failed while a chain is broken | TRL-05 |
| Import rules | `src/architecture/import-rules.ts` | The architecture test reads every source file and fails on a forbidden import: the rules are in §3.3 | ARC-02, ARC-06 |
| SQL rule | `src/architecture/sql-rules.ts` | Fails on a `query(…)` whose SQL is a template literal with `${…}` or a string joined with `+`; the one reviewed exception (`SET LOCAL ROLE` from the closed role list) is listed with its reason | SCR-02 |
| CI security jobs | `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.gitleaks.toml` | Every action pinned to a commit; a secret scan (gitleaks, release checked by SHA-256) on every pull request; weekly grouped dependency updates; the dependency audit fails on a high finding | SCR-06, SCR-10 |

### 3.1b First module: `modules/identity` (B1b step 1)

| Layer | Files | What it holds |
|---|---|---|
| Domain | `password-policy.ts`, `lockout.ts`, `session-limits.ts`, `sign-in-tokens.ts` | The 12-character rule with the leak check (IAM-03), the lock after 5 failures for 15 minutes (IAM-04), the limits of Table 6 (a workspace can only shorten them), token lifetimes per purpose (IAM-10). Pure functions, no I/O |
| Ports | `ports/index.ts` | `PasswordHasher`, `LeakedPasswordList`, `SecretTokens` |
| Infrastructure | `argon2-hasher.ts`, `breached-list.ts`, `secret-tokens.ts` | Argon2id at 19 MiB and 2 iterations (`@node-rs/argon2`, prebuilt, no install script); the list of 46,146 leaked passwords of 12+ characters (`apps/server/data`, source in its README); 256-bit random tokens stored as SHA-256 |
| Application | `passwords.ts`, `index.ts` | `passwordService`: choose (rule, then hash) and check (verify; rehash when the stored hash is weaker; a decoy verification for accounts without a password, so timing does not reveal them). `index.ts` is the module's public interface |

The import rules of §3.3 apply: the domain imports nothing, the application only its domain and ports.

**Sign-in and sessions (B1b step 2).**

| Part | File | What it does | Requirements |
|---|---|---|---|
| Use cases | `modules/identity/application/auth.ts` | `signIn`: one answer for a wrong password and an unknown e-mail, a full verification every time, failures and the 15-minute lock kept per e-mail (hashed) whether an account exists or not, failures also counted per client address; a new session, refresh token and XSRF value at each sign-in. `refresh`: rotates the token under a row lock; a used token presented again ends the session. `authenticate`: on every request, reloads the session and the account (revoked, expired or disabled stops at once) and slides the idle limit at most once a minute | IAM-01, IAM-04, IAM-07, IAM-08, IAM-16 |
| Store | `modules/identity/infrastructure/pg-store.ts` | Parameterised SQL as `nx_app`, no workspace; the identity trail stores e-mails as SHA-256; fixed-window counters in `ops.rate_limits` | IAM-09, SCR-02 |
| Access token | `modules/identity/infrastructure/access-tokens.ts` | `v1.<payload>.<HMAC-SHA256>` of `{ sid, realm, exp }` with `SESSION_SECRET`; 15 minutes, never beyond the session's end | §8.2 |
| Routes | `http/auth-routes.ts` | `POST /app/v1/auth/login`, `/refresh`, `/logout`, `GET /app/v1/auth/me` | API contract §2 |
| Guards | `http/guards.ts`, `http/cookies.ts` | `Origin` check on every write; the session of the route's realm; `X-XSRF-TOKEN` compared with the session's hash; cookies `nx_m` (path `/api/app`), `nx_m_r` (path `/api/app/v1/auth`), `XSRF-TOKEN` (readable), all `SameSite=Lax`, `Secure` over https | SCR-16, ADR-007 |
| Access log | `http/access-log.ts`, `config/logging.ts` | One line per request with request id, path without query, status, duration, principal and realm; cookies, credentials and database error details redacted in both processes | QAL-07, G-6 |
| Configuration | `config/config.ts` | `TRUST_PROXY_HOPS` (G-7), `COOKIE_PATH_PREFIX`; production refuses a database URL without `sslmode=verify-full` (G-5) | SCR-01 |

**Second factor, step-up, sessions and passcode (B1b step 4).**

| Part | File | What it does | Requirements |
|---|---|---|---|
| Rules | `modules/identity/domain/second-factor.ts` | A challenge lasts 5 minutes and takes 5 codes; ten recovery codes; a second factor is fresh for 5 minutes; a passcode has 4 to 8 digits and the fifth wrong one ends the session | IAM-05, IAM-06, IAM-18 |
| TOTP and encryption | `infrastructure/totp.ts`, `infrastructure/secret-box.ts` | RFC 6238 codes (checked against the RFC's test vectors), the step before or after accepted, a step never accepted twice; secrets sealed with AES-256-GCM under a key derived from `ENCRYPTION_KEY` (required in production, different from `SESSION_SECRET`) | IAM-05, SCR-07 |
| Sign-in | `application/auth.ts` | With a second factor, the right password opens a challenge, not a session; a code or a recovery code (once each) opens it. After the idle limit, `refresh` answers *locked* when a passcode is set; `unlock` takes the passcode with the refresh cookie until the absolute limit. Sessions list; ending one's own other sessions; an administrator ends a member's | IAM-05, IAM-07, IAM-18, §8.2 rule 5 |
| Management | `application/second-factor.ts` | Set-up (secret shown once), enabling with a first code **and the password**, turning off with the password and a code (refused when required), new recovery codes, step-up with an app code, passcode set with the password | IAM-05, IAM-06, IAM-16 |
| Gate | `modules/workspace/application/workspaces.ts` | Owners, administrators and accountants are refused every company page (`err_twoFactorRequired`) until they have a second factor; moving ownership needs a fresh one (`err_stepUpRequired`) | IAM-05, IAM-06 |
| Routes | `http/auth-routes.ts` | `POST /app/v1/auth/2fa/verify`, `GET /auth/2fa`, `POST /auth/2fa/setup`, `/enable`, `/disable`, `/recovery-codes`, `POST /auth/step-up`, `PUT`/`DELETE /auth/passcode`, `POST /auth/passcode-verify`, `GET`/`DELETE /app/v1/me/sessions[/:id]`; `DELETE /app/v1/workspaces/:wid/members/:id/sessions` | API contract §4.1 |

**Second module: `modules/workspace` (B1b step 3).** Workspaces, memberships, roles and the permission engine.

| Part | File | What it does | Requirements |
|---|---|---|---|
| Domain | `domain/permissions.ts`, `domain/owner-rules.ts` | The catalogue is `AdminPermissionsPlatform` from `packages/core`; the console's areas (staff, banned users, system issues, plans, subscriptions) are refused to company roles; `*` grants all. The four default roles come from the shared `WORK_ROLE_PERMISSIONS`. Owner rules: only owners change owners, an owner is an administrator, one active owner remains. Pure | §10.1, AUZ-02, AUZ-11 |
| Use cases | `application/workspaces.ts` | `resolve`: the workspace of the path is accepted only with an active membership, rebuilt from the database on every request (a role change applies at the next request), returned as a frozen context; a refusal is written to the identity trail. Each command and query declares its permission in `PERMISSION_OF` and checks it first; a refused write is written to the company's trail. Members (role, owner flag, status), custom roles (create, change, delete when unused), changes audited with before and after. No escalation: nobody gives, takes away or edits rights they do not hold | TEN-01, TEN-03, AUZ-01, AUZ-09, AUZ-10, AUZ-14 |
| Store | `infrastructure/pg-store.ts` | Parameterised SQL as `nx_app` with the workspace set; every query names the workspace as well (TEN-04). The list of one's companies goes through `tenant.my_memberships()`; a new company through `tenant.provision_workspace` as `nx_provision` | TEN-04, TEN-05 |
| Routes | `http/workspace-routes.ts` | `GET /app/v1/me/workspaces`, `PUT /app/v1/auth/workspace`; under `/app/v1/workspaces/:wid`: `GET /context`, `GET /members`, `PATCH /members/:id`, `GET`/`POST /roles`, `PATCH`/`DELETE /roles/:id`. Every route is listed in `WORKSPACE_ROUTES` with its command; a test fails when a mounted route is missing from it | API contract §4.1, §4.3; AUZ-01 |

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

### 3.3 Import rules (ARC-02, ARC-06)

`src/architecture/import-rules.test.ts` checks every file of `src` on each run of the tests; a forbidden import fails the build. Tests and `testing/` folders may import anything, but production code never imports them. A file outside the folders below fails too, so a new folder must be given its rules.

| Where | May import | Never |
|---|---|---|
| `config/` | `zod`, Node | any other server folder |
| `db/` | `config`, `pg`, Node | `http`, jobs, worker, Express, business modules |
| `http/` | `config`, Express, `pino`, `zod`, Node; a module only through `modules/<name>/application/index.ts` | `pg`, `db`, jobs, worker |
| `jobs/`, `worker/` | each other, `db`, `config`, `pg`, `pino`; a module only through its interface | `http`, Express |
| `main.ts`, `worker-main.ts` | anything (composition roots) | — |
| `modules/<m>/domain/` | its own domain, `@nexora/core`, `zod` | Node, Express, `pg`, every other layer and folder |
| `modules/<m>/ports/` | its domain and ports, `@nexora/core`, `zod` | the same |
| `modules/<m>/application/` | its domain, ports and application; `db/session`, `db/unit-of-work`, `db/uuid`; another module's `application/index.ts` | Node, Express, `pg`, infrastructure, `http` |
| `modules/<m>/infrastructure/` | its own layers, `db`, any package; another module's `application/index.ts` | `http` |

Another module's domain, ports or infrastructure is never imported: modules talk through application interfaces or the outbox. The first module folders arrive with the vertical slice (B1c); the rules are already enforced so they start inside them.

## 4. Delivery

| Phase | Content | State |
|---|---|---|
| — | Phase 0 audit and engineering roadmap ([`engineering/`](engineering/EXECUTION_TRACKER.md)); cahier des charges 2.2 | ✅ |
| B1a | Repository, `packages/core`, skeleton, CI | ✅ Step 1 |
| B1a | PostgreSQL schemas and roles, migrations, row-level security | ✅ Step 2 |
| B1a | Unit of work, audit, outbox, job queue, worker | ✅ Step 3 |
| B1a | **[2.2]** Contract and foundation hardening (Phase 1 steps 1–5); guard, privilege and audit suites (exit gate, step 6) | ✅ |
| B1b | Identity, sessions, CSRF, memberships, permissions | Next |
| B1b–B3 | Identity, modules, money, analytics, console, operations, security tests | Planned (cahier des charges §21.2) |

## 5. Commands

| Command | What it does |
|---|---|
| `npm ci` | Install |
| `npm run check` | Type checks and every test |
| `npm run sync:core -- ../Nexora-Saas` | Copy the rules from a local web repository and record its commit in `packages/core/SOURCE` |
| `npm run check:core -- ../Nexora-Saas` | Check they match (`--at-source`: also require the recorded commit) |
| `npm run dev -w @nexora/server` | Start the web process on port 4000 |
| `npm run worker -w @nexora/server` | Start the worker process |

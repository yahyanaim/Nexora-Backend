# Nexora: database

_How the PostgreSQL database is laid out, who may touch what, how it is created and changed. The rules come from the cahier des charges §6 (Tables 14 and 15); the tests in `apps/server/src/db/*.test.ts` prove them against a real PostgreSQL 16._

## 1. Schemas

| Schema | Holds | Row-level security |
|---|---|---|
| `identity` | Principals (one per account or job), accounts, sessions, second factors, tokens | Per table, as each realm needs |
| `tenant` | Every business table of the companies | **On every table, forced**, by workspace |
| `platform` | Console tables (customers, plans, subscriptions, Nexora invoices…) | Not needed: tenant roles have no privilege on it |
| `ops` | Migrations, jobs, outbox, idempotency keys, number sequences | On tenant-bound rows |
| `audit` | Workspace, identity and console audit trails | Insert and read only |
| `archive` | Accounting records kept after a workspace is deleted | Only `nx_dataops` |

Built so far: `ops.schema_migrations`, `identity.principals`, `tenant.workspaces`, `tenant.departments` and the helpers below (B1a step 2); the three audit trails, `ops.outbox`, `ops.jobs` and `ops.schedules` (B1a step 3, sections 8 and 9); `ops.worker_heartbeats` and `audit.seals` (Phase 1 step 5, sections 8 and 9).

Interactive diagrams: [the tables built today](diagrams/database.html), [the planned chain from an hour worked to a payment](diagrams/core-chain.html), [the three barriers between companies](diagrams/tenant-barriers.html).

## 2. Roles

**Group roles** (created by the first migration; cannot sign in, never superuser, never `BYPASSRLS`):

| Role | Used for | Can reach today |
|---|---|---|
| `nx_app` | Member requests, tenant jobs | `tenant` tables of the workspace set (read and write; not create or delete workspaces), `identity.principals` |
| `nx_portal` | Portal requests | Nothing yet: portal views come with the portal (B1e) |
| `nx_platform` | Console requests, platform jobs | `platform`; **no privilege on `tenant`** (SEC-02, TEN-10) |
| `nx_support` | Requests inside an approved support session | Nothing yet: its policy comes with support sessions (B1f) |
| `nx_dataops` | Export and deletion jobs | `tenant` read and delete, one workspace at a time |
| `nx_provision` | Owns the crossing functions (§6.2) | — |
| `nx_readonly` | Restore tests, readiness, reconciliation | `tenant` read, `ops.schema_migrations` |
| `nx_jobs` | The worker's queue work | Every row of `ops.outbox`, `ops.jobs`, `ops.schedules` and `ops.worker_heartbeats`; creates `system:<job>` principals; runs `audit.seal()` and `audit.verify()`. **No tenant table and no audit event**: tenant work in a job runs under `nx_app` |

**Login users** (created at bootstrap, one per process kind, `NOINHERIT`): a login user is a member of the group roles it may use but has **no privilege of its own**. Each transaction runs `SET LOCAL ROLE <group role>` (see `src/db/session.ts`), so a forgotten role means "permission denied", never "too much access".

| Login | Member of | Process |
|---|---|---|
| `nx_owner` | — (owns every object; `CREATEROLE`) | Migration step only |
| `nx_web` | `nx_app`, `nx_portal`, `nx_platform`, `nx_support` | Web process |
| `nx_worker` | `nx_app`, `nx_platform`, `nx_dataops`, `nx_readonly`, `nx_jobs` | Worker process |

## 3. Request context and row-level security

Every unit of work opens a transaction and sets, with `SET LOCAL`:
- the role (`SET LOCAL ROLE nx_app`…)
- `app.workspace_id`: the workspace checked against the person's memberships
- `app.principal_id`: who acts
- `app.client_id`: for the portal

They disappear at commit, so a pooled connection keeps nothing (TEN-05).

`ops.secure_tenant_table(table)` is called by each migration that creates a tenant table. It:
- enables and **forces** row-level security
- adds the `tenant_rows` policy (`workspace_id = ops.current_workspace()`, for reads and writes)
- adds the `stamp_row` trigger

The trigger takes `created_by` and `updated_by` from `app.principal_id`, refuses a change without it, bumps `version` on every update, and refuses to change `id` or `workspace_id`. **Without `app.workspace_id`, no row is visible and none can be written.**

## 4. Adding a tenant table

Every tenant table needs:
1. `id uuid PRIMARY KEY`, `workspace_id uuid NOT NULL REFERENCES tenant.workspaces (id)`, and `UNIQUE (workspace_id, id)`.
2. The common columns: `created_at`, `created_by`, `updated_at`, `updated_by` (both referencing `identity.principals`) and `version integer`.
3. Foreign keys to other tenant tables that include the workspace: `FOREIGN KEY (workspace_id, client_id) REFERENCES tenant.clients (workspace_id, id)`.
4. Money in `bigint` centimes; no `real`, `double precision` or `money` column.
5. `SELECT ops.secure_tenant_table('tenant.<table>');` at the end.

`database.test.ts` checks rules 1 to 5 on **every** table of `tenant`, so a table that misses one fails CI.

## 5. Migrations

- Files in `apps/server/src/db/migrations`, named `NNNN_lower_case.sql`, applied in order, **forward only**.
- Each runs in one transaction. A failing file leaves nothing behind and is not recorded.
- Each applied file is recorded in `ops.schema_migrations` with its SHA-256. **Editing an applied file stops the next run**: add a new migration instead.
- An advisory lock lets only one runner work at a time, so two instances can start together.
- A change that would break the running version uses expand and contract (§6.8).
- Run it as a deployment step, before the processes roll: `MIGRATION_DATABASE_URL=… npm run db:migrate -w @nexora/server`.

## 6. Bootstrap of a new environment

Run once, as an administrator of the PostgreSQL server (passwords from the secret store):

```sql
CREATE ROLE nx_owner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '…';
CREATE DATABASE nexora OWNER nx_owner;
```

Then run the migrations (they create the group roles), and create the process logins:

```sql
CREATE ROLE nx_web    LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '…';
CREATE ROLE nx_worker LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '…';
GRANT nx_app, nx_portal, nx_platform, nx_support TO nx_web;
GRANT nx_app, nx_platform, nx_dataops, nx_readonly, nx_jobs TO nx_worker;
```

`DATABASE_URL` of the web process uses `nx_web`; `MIGRATION_DATABASE_URL` uses `nx_owner`.

## 7. Running the database tests locally

The suites need a PostgreSQL 16 server and a superuser URL in `TEST_DATABASE_ADMIN_URL`. Each test file creates a throwaway database `nx_test_…`, migrates it and drops it. Without the variable the database suites are skipped locally; **in CI they always run** (a missing URL fails the build).

```bash
docker run -d --name nexora-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
TEST_DATABASE_ADMIN_URL=postgresql://postgres:dev@localhost:5432/postgres npm test
```

## 8. Audit trails (§16)

| Trail | Holds | Who writes | Who reads |
|---|---|---|---|
| `audit.workspace_events` | Every action inside a company | `nx_app`, only for the request's workspace and with the request's principal as actor | `nx_app` in that workspace (owners and administrators, checked by the application); `nx_dataops` for exports |
| `audit.identity_events` | Sign-in and account events, before a workspace is known | `nx_app`, `nx_portal`, `nx_platform` | Comes with identity (B1b) |
| `audit.console_events` | Every staff action | `nx_platform`, with the request's principal as actor | `nx_platform` |

- **Insert-only (TRL-02).** A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` for every role, the owner included, even with row-level security lifted. The retention function (TRL-06) will be the only exception.
- **Same transaction (TRL-01).** `runUnitOfWork` (`src/db/unit-of-work.ts`) writes the event with the change: if the event cannot be written, the change does not happen.
- **Seals (TRL-05).** `audit.seals` holds one chain per trail, and one per workspace for the workspace trail. Each seal covers the events after the previous seal, by id, up to its own last event, with the SHA-256 of those events in id order (each as its `jsonb` text) and the hash of the previous seal. The `audit.seal` job (every 5 minutes) seals events older than 2 minutes, so a transaction still open is not left out of a sealed range; the `audit.verify` job (daily) recomputes every chain and fails while a break exists, so the dead job is alerted (JOB-07). A changed, removed or inserted event, an altered seal and a broken link are each reported, even when done by a superuser with the triggers off. Both jobs call `SECURITY DEFINER` functions owned by `nx_owner` (with `search_path` fixed); `nx_jobs` can execute them but read no audit event, and seals are insert-only like the trails.
- **No secrets (TRL-04).** Before and after values are copied with password, token, secret, key, IBAN and card fields replaced by `[redacted]`.

## 9. Outbox, jobs and schedules (§15.1, §17)

| Table | What it is | Who writes |
|---|---|---|
| `ops.outbox` | Events written by a command, relayed after commit | `nx_app` (own workspace), `nx_platform` (no workspace), `nx_jobs` |
| `ops.jobs` | The job queue: type, payload, workspace, status, run time, attempts, lease, last error, dedupe key | `nx_app` (own workspace), `nx_platform` (no workspace), `nx_jobs` |
| `ops.schedules` | Recurring jobs: job type, interval, next run. Today: `audit.seal` (5 min), `audit.verify` (daily) | Migrations; `nx_jobs` moves the next run |
| `ops.worker_heartbeats` | One row per worker: start, last beat, clean stop, queue metrics (due, oldest due, running, dead, outbox pending and lag). A worker without a beat for 2 minutes that did not stop cleanly is missing (JOB-09) | `nx_jobs`; read by `nx_platform` (operations page) |

Company roles can add rows but never read the queue tables.

**Life of a job.**

| Status | Meaning | Next |
|---|---|---|
| `queued` | Waiting for its run time | Claimed with `FOR UPDATE SKIP LOCKED`: `running` |
| `running` | Held by one worker until its lease ends (5 minutes by default) | `done`; or failed: `queued` again after 1, 2, 4… minutes (at most 60); or `dead` after its last attempt; lease expired: `queued` again |
| `done` | Finished | — |
| `dead` | Failed every attempt; shown to the operator | `queued` again after a fix (`retryDeadJob`) |

- **Idempotent enqueue.** A job with a dedupe key is enqueued once, whoever enqueues it. The relay uses `outbox:<event>:<job type>`, the scheduler `schedule:<name>:<planned time>`.
- **Fairness.** A workspace never runs two jobs of the same type at once.
- **One scheduler.** A transaction advisory lock lets one worker enqueue the due schedules; a run missed while no worker was up is enqueued once.


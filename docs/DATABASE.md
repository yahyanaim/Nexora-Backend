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

Built so far (B1a step 2): `ops.schema_migrations`, `identity.principals`, `tenant.workspaces`, `tenant.departments`, and the helpers below.

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

**Login users** (created at bootstrap, one per process kind, `NOINHERIT`): a login user is a member of the group roles it may use but has **no privilege of its own**. Each transaction runs `SET LOCAL ROLE <group role>` (see `src/db/session.ts`), so a forgotten role means "permission denied", never "too much access".

| Login | Member of | Process |
|---|---|---|
| `nx_owner` | — (owns every object; `CREATEROLE`) | Migration step only |
| `nx_web` | `nx_app`, `nx_portal`, `nx_platform`, `nx_support` | Web process |
| `nx_worker` | `nx_app`, `nx_platform`, `nx_dataops`, `nx_readonly` | Worker process |

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
GRANT nx_app, nx_platform, nx_dataops, nx_readonly TO nx_worker;
```

`DATABASE_URL` of the web process uses `nx_web`; `MIGRATION_DATABASE_URL` uses `nx_owner`.

## 7. Running the database tests locally

The suites need a PostgreSQL 16 server and a superuser URL in `TEST_DATABASE_ADMIN_URL`. Each test file creates a throwaway database `nx_test_…`, migrates it and drops it. Without the variable the database suites are skipped locally; **in CI they always run** (a missing URL fails the build).

```bash
docker run -d --name nexora-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
TEST_DATABASE_ADMIN_URL=postgresql://postgres:dev@localhost:5432/postgres npm test
```

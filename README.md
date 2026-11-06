# Nexora Backend

Server, database, background jobs, files and security for [Nexora](https://github.com/yahyanaim/Nexora-Saas), the ERP for service companies.

The web application lives in `yahyanaim/Nexora-Saas`. This repository holds the server and the shared package of business rules (`packages/core`).

## Documents

| File | What it is |
|---|---|
| [`docs/CAHIER_DES_CHARGES.md`](docs/CAHIER_DES_CHARGES.md) | The specification of the backend and database (version 2.2): architecture, data model, every requirement with its test, security plan and delivery phases |
| [`docs/DATABASE.md`](docs/DATABASE.md) | The database: schemas, roles, row-level security, adding a tenant table, migrations, bootstrap, running the database tests |
| [`docs/diagrams/`](docs/diagrams/README.md) | Interactive diagrams: what is built (architecture, request sequence, database, rule sync) and the target design (one per figure of the docs), each box linked to its source lines |
| [`docs/engineering/`](docs/engineering/EXECUTION_TRACKER.md) | Engineering roadmap: implementation inventory, architecture decisions, execution tracker (phase by phase) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How Nexora is built: the two repositories, the shared rules, the server today and its target shape |
| [`docs/AUDIT.md`](docs/AUDIT.md) | The latest audit of the front end, the API and security: checks, status of every finding, what is still not done |

The API contract the server follows is `docs/API_CONTRACT.md` in the web repository.

## Layout

| Folder | What it holds |
|---|---|
| `packages/core` | The business rules, types and error catalogue, **generated** from the web repository by `scripts/sync-core.mjs`. Never edit them here: change the web repository, then run `npm run sync:core -- <path to Nexora-Saas>`. `packages/core/SOURCE` records the web commit they come from (ARC-12); CI fails when they differ from that commit, and a daily report (`core-drift.yml`) shows when the web repository's `main` has moved ahead |
| `apps/server` | The server: configuration (`src/config`), HTTP application (`src/http`), database (`src/db`: migrations, runner, session, pool, unit of work), jobs (`src/jobs`: queue, scheduler, outbox relay), worker (`src/worker`), entry points (`src/main.ts` web, `src/worker-main.ts` worker) |
| `docs` | The specification |

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install |
| `npm run check` | Type checks and every test |
| `npm run sync:core -- ../Nexora-Saas` | Copy the rules from a local web repository (a clean git checkout) and record its commit in `packages/core/SOURCE` |
| `npm run check:core -- ../Nexora-Saas` | Check the rules match it (add `--at-source` to also require the commit `SOURCE` records) |
| `npm run dev -w @nexora/server` | Start the web process on port 4000 (`/health/live`, `/health/ready`) |
| `npm run db:migrate -w @nexora/server` | Apply pending migrations (`MIGRATION_DATABASE_URL`, as `nx_owner`) |
| `npm run worker -w @nexora/server` | Start the worker process (`DATABASE_URL` of the `nx_worker` login): relays the outbox, runs the scheduler and the jobs |

Copy `.env.example` to `.env` for local settings. Production refuses to start without a strong `SESSION_SECRET` and an https `APP_ORIGIN`.

## Status

| Phase | Step | State |
|---|---|---|
| B1a | 1. Repository, `packages/core`, server skeleton, CI | ✅ |
| B1a | 2. PostgreSQL schemas, roles, migrations, row-level security | ✅ |
| B1a | 3. Unit of work, audit trail, outbox, job queue, worker | ✅ |
| B1a | 4. Guard, privilege and audit test suites (exit gate) | Next |

## Licence

Proprietary. Copyright © 2026 Yahia Naim, all rights reserved.

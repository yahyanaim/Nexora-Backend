# Nexora Backend

Server, database, background jobs, files and security for [Nexora](https://github.com/yahyanaim/Nexora-Saas), the ERP for service companies.

The web application lives in `yahyanaim/Nexora-Saas`. This repository holds the server and the shared package of business rules (`packages/core`).

## Documents

| File | What it is |
|---|---|
| [`docs/CAHIER_DES_CHARGES.md`](docs/CAHIER_DES_CHARGES.md) | The specification of the backend and database (version 2.1): architecture, data model, every requirement with its test, security plan and delivery phases |

The API contract the server follows is `docs/API_CONTRACT.md` in the web repository.

## Layout

| Folder | What it holds |
|---|---|
| `packages/core` | The business rules, types and error catalogue, **generated** from the web repository by `scripts/sync-core.mjs`. Never edit them here: change the web repository, then run `npm run sync:core -- <path to Nexora-Saas>`. CI fails when they differ from the web repository's `main` |
| `apps/server` | The server: configuration (`src/config`), HTTP application (`src/http`), entry point (`src/main.ts`) |
| `docs` | The specification |

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install |
| `npm run check` | Type checks and every test |
| `npm run sync:core -- ../Nexora-Saas` | Copy the rules from a local web repository |
| `npm run check:core -- ../Nexora-Saas` | Check the rules match it |
| `npm run dev -w @nexora/server` | Start the web process on port 4000 (`/health/live`, `/health/ready`) |

Copy `.env.example` to `.env` for local settings. Production refuses to start without a strong `SESSION_SECRET` and an https `APP_ORIGIN`.

## Status

| Phase | Step | State |
|---|---|---|
| B1a | 1. Repository, `packages/core`, server skeleton, CI | ✅ |
| B1a | 2. PostgreSQL schemas, roles, migrations, row-level security | Next |
| B1a | 3. Unit of work, audit trail, outbox, job queue, worker | Planned |
| B1a | 4. Guard, privilege and audit test suites (exit gate) | Planned |

## Licence

Proprietary. Copyright © 2026 Yahia Naim, all rights reserved.

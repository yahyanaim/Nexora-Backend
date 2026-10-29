# Nexora Backend

Server, database, background jobs, files and security for [Nexora](https://github.com/yahyanaim/Nexora-Saas), the ERP for service companies.

The web application lives in `yahyanaim/Nexora-Saas`. This repository holds the server and the shared package of business rules (`packages/core`).

## Documents

| File | What it is |
|---|---|
| [`docs/CAHIER_DES_CHARGES.md`](docs/CAHIER_DES_CHARGES.md) | The specification of the backend and database (version 2.1): architecture, data model, every requirement with its test, security plan and delivery phases |

The API contract the server follows is `docs/API_CONTRACT.md` in the web repository.

## Status

Specification ready for approval. Building starts with phase **B1a** (§21.2 of the specification): repository skeleton, `packages/core`, PostgreSQL schemas and roles, migrations, unit of work, audit, outbox, job queue and CI.

## Licence

Proprietary. Copyright © 2026 Yahia Naim, all rights reserved.

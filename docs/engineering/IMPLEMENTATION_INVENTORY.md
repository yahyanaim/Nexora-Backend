# Nexora: implementation inventory

_The real state of every part of Nexora, from the code, not from the plan. Updated with each phase. Audit of 5 November 2026: Nexora-Saas `fdca5e7`, Nexora-Backend `9d47c35` plus PR #5._

**Legend:**
- ✅ built and tested
- 🟡 partly built
- 🧪 prototype on demo data (browser store)
- ⬜ not started

## 1. Platform foundation (back end)

| Part | State | Where | Requirements | Tests |
|---|---|---|---|---|
| Repository, workspaces, CI (typecheck, tests on PostgreSQL 16, dependency audit, rule parity) | ✅ | `package.json`, `.github/workflows/ci.yml` | ARC-01, ARC-03 | CI |
| Configuration (refuses weak production secrets) | ✅ | `apps/server/src/config/config.ts` | ARC-04 | `config.test.ts` |
| HTTP skeleton: request id, security headers, body limit, health, catalogue errors | ✅ | `src/http/app.ts`, `src/http/errors.ts` | QAL-05, SCR-04, ARC-08 | `app.test.ts`, `error-codes.test.ts` |
| Error body agreed with the front end | 🟡 | `src/http/app.ts:62-74` sends `values`; front end reads `details` | ARC-08 | Audit H-1 |
| Shared rules `packages/core` (125 files, 25 test files) | ✅, 🟡 not pinned | `scripts/sync-core.mjs`, `packages/core` | ARC-01, ARC-03 | 136 core tests; parity job |
| Schemas, group roles, NOINHERIT logins | ✅ | `migrations/0001_foundation.sql` | DAT-01, DAT-02, TEN-10 | `database.test.ts` |
| Forced RLS, actor and version stamps, composite tenant keys | ✅ | `0001`, `0003`, `0004` | DAT-08–DAT-11, TEN-05 | `database.test.ts` |
| Migrations: forward-only, checksums, advisory lock | ✅ | `src/db/migrate.ts` | DAT-12–DAT-14 | `migrate.test.ts` |
| Unit of work (atomic change + audit + outbox + jobs, retry) | ✅ in PR #5 | `src/db/unit-of-work.ts` | TRX-01, TRX-02, TRX-08, TRL-01 | `unit-of-work.test.ts` |
| Audit trails (workspace, identity, console), insert-only | ✅ in PR #5 | `0005_audit_trails.sql` | TRL-02–TRL-04, AUD-01 | `unit-of-work.test.ts` |
| Audit seal and retention | ⬜ | — | TRL-05, TRL-06 | — |
| Outbox, job queue, scheduler, worker | ✅ in PR #5 | `0006_outbox_jobs.sql`, `src/jobs/*`, `src/worker/*` | TRX-05, JOB-01–JOB-04, JOB-06–JOB-08 | `jobs.test.ts` |
| Worker health, metrics output | ⬜ (`queueStats` only) | `src/jobs/queue.ts` | QAL-08, JOB-07 | — |
| Idempotency keys | ⬜ | — | TRX-04 | — |
| Optimistic-lock helper (`CONFLICT_STALE_VERSION`) | 🟡 (database part only) | `stamp_row` | TRX-06, DAT-11 | `database.test.ts` |
| Import-rule (architecture boundary) test | ⬜ | — | ARC-06 | — |
| Access log with workspace and principal | ⬜ | — | QAL-07 | — |

## 2. Business modules (cahier §5.3)

The front-end column counts the API modules in `Nexora-Saas/src/lib/api` (56 in all); every one runs on the browser store, and 17 of them also call a server when demo mode is off.

| Module | Front end | Back end: tables | Back end: endpoints | Cahier phase |
|---|---|---|---|---|
| identity (sign-in, sessions, 2FA, passcode, devices) | 🧪 `auth-apis`, `profile-api`, `me-api` | ⬜ only `identity.principals` | ⬜ | B1b |
| workspace (settings, memberships, roles, plans and seats) | 🧪 `settings-api`, `access-api`, `workspace-subscription-api`, `tenant-modules` | 🟡 `tenant.workspaces` | ⬜ | B1b, B1c |
| people (employees, rates, documents, org chart, reviews, leave balances) | 🧪 `employees-api`, `documents-api`, `reviews-api`, `leave-api` | 🟡 `tenant.departments` | ⬜ | B1c |
| relations (clients, contacts, leads, deals, CRM import, files, notes, satisfaction) | 🧪 `clients-api`, `crm-api`, `leads-api`, `deals-api`, `crm-import-api`, `client-files-api`, `client-requests-api`, `satisfaction-api` | ⬜ | ⬜ | B1c |
| work (projects, tasks, milestones, cycles, pages, templates, views, change orders) | 🧪 `work-projects-api`, `task-collab-api`, `task-views-api`, `cycles-api`, `project-pages-api`, `project-templates-api`, `change-orders-api`, `resource-bookings-api` | ⬜ | ⬜ | B1c |
| time (entries, timers, timesheets) | 🧪 `work-billing-api` (time part), `timer-api` | ⬜ | ⬜ | B1c |
| approvals (time, leave, expenses, quotes, invoices, bills) | 🧪 rules in `approvals.ts` (`approvals.test.ts`, `approval-rules.test.ts`) | ⬜ | ⬜ | B1c, B1d |
| sales (quotes, invoices, credit notes, payments, reminders, recurring, e-invoice) | 🧪 `quotes-api`, `work-billing-api`, `recurring-invoices-api`, `billing-apis` | ⬜ | ⬜ | B1d |
| purchases (suppliers, bills, expenses) | 🧪 `suppliers-api`, `supplier-bills-api`, `expenses-api` | ⬜ | ⬜ | B1d |
| finance (bank import, journal, VAT, period lock, revenue recognition) | 🧪 `bank-import-api`, rules `journal.ts`, `vat.ts`, `revenue-recognition.ts` | ⬜ | ⬜ | B1d |
| analytics (KPIs, reports, forecasts, dashboards, saved reports) | 🧪 `saved-reports-api`, rules `analytics.ts`, `kpis.ts`, `dashboards.ts` | ⬜ | ⬜ | B1e |
| files (uploads, documents) | 🧪 `files-api`, `upload-apis` | ⬜ | ⬜ | B1e |
| notifications (bell, inbox, e-mail) | 🧪 rules `inbox.ts` (the bell reads 15 lists) | ✅ outbox in PR #5 | ⬜ | B1e |
| portal (client portal) | 🧪 `portal-api` | ⬜ | ⬜ | B1e |
| platform (console: customers, plans, subscriptions, billing, support, health, metrics, data requests) | 🧪 `platform-*-api` (8 modules), `data-export-api`, `gdpr-apis` | ⬜ | ⬜ | B1f |
| ops (jobs, schedules, health) | — | ✅ in PR #5 | 🟡 `/health/*` | B1a |

## 3. Front-end items the server needs (cahier §21.4)

| # | Item | State | Before phase |
|---|---|---|---|
| F1 | Quotes and invoices follow the approval rule | ⬜ | B1d |
| F2 | "Bill" as an approval subject | ⬜ | B1d |
| F3 | Step-up screen before sensitive actions | ⬜ | B1b |
| F4 | `Idempotency-Key` header | ⬜ | B1d |
| F5 | Send `version`, reload on conflict | ⬜ | B1c (slice) |
| F6 | Portal sign-in link | ⬜ | B1e |
| F7 | My devices; administrator signs a member out | ⬜ | B1b |
| F8 | Transfer ownership; last-owner message | ⬜ | B1b |
| F9 | Developer page demo-only | ✅ | B1a |
| F10 | Missing error keys | ✅ | B1a |
| F11 | Send `X-XSRF-TOKEN` | ⬜ | B1b |
| F12 | The bell reads one notice feed | ⬜ | B1e |

## 4. Tests

| Suite | Count | Where it runs |
|---|---|---|
| Front-end unit and component tests | 143 files, 870 tests | Local and CI |
| Front-end end to end (Playwright, mock API) | CI job "End-to-end" | CI |
| Front-end accessibility (axe, console and company pages) | CI job | CI |
| Back-end server tests | 42 on `main`, 69 with PR #5 (database suites on real PostgreSQL 16) | Local with `TEST_DATABASE_ADMIN_URL`; always in CI |
| Back-end core rule tests | 136 | Local and CI |
| Contract tests front end ↔ back end | ⬜ none | — (audit H-1) |
| Guard, privilege and audit suites (B1a exit gate) | 🟡 privilege and isolation tests exist; import-rule test and audit secret scan missing | — |

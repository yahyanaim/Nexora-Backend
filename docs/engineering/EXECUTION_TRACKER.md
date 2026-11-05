# Nexora: execution tracker

_The engineering roadmap (phases 0–8) laid onto the delivery plan of the cahier des charges (phases B1a–B3, §21.2), with every open item. One phase is approved and worked at a time; each ends with its gate, tests and an updated inventory. Last update: 5 November 2026._

**Legend:**
- ✅ done
- 🔄 in progress or in an open pull request
- ⏳ next
- ⬜ planned
- 🔒 waits for the owner's approval

## 1. Roadmap ↔ cahier phases

| Roadmap phase | Cahier phase | Content | Estimate | State |
|---|---|---|---|---|
| 0 Audit and baseline | — | This audit, inventory, decisions, tracker | 1 day | ✅ awaiting approval |
| 1 Contract and foundation hardening | Before B1b | Error body (ADR-004), session cookies decision (ADR-007), pinned rules (ADR-003), import-rule test, contract tests | 1 week | 🔒 |
| 2 Database, transactions, audit, workers | B1a steps 2–4 | Steps 2 and 3 built; close-out and exit gate (guard, privilege and audit suites) | 1 week left | 🔄 PR #5 open |
| 3 Identity, authentication, authorization | B1b | Sessions, sign-in, CSRF, memberships, roles, permission engine, step-up, devices | 2–3 weeks | ⬜ |
| 4 First vertical slice | B1c (part) | Client → project → member → time → submit → approve, end to end | 2–3 weeks | ⬜ |
| 5 Core ERP modules | B1c (rest), B1e (reporting) | Settings, people, CRM features, work features, leave, operational reports | 5–6 weeks | ⬜ |
| 6 Financial domain | B1d | Money adapter and property tests, idempotency, quotes, invoices, numbering, payments, VAT, journal | 4–5 weeks | ⬜ |
| 7 Remaining modules and async workflows | B1e, B1f | Files, notifications and e-mail, portal, inbox, search, console, support, data requests | 5–7 weeks | ⬜ |
| 8 Hardening and release readiness | B2, B3 | Backups and restore, monitoring, staging, load test, key rotation, penetration test | 4–5 weeks | ⬜ |
| | | **Total** | **about 25–31 weeks** | |

The total agrees with the cahier (27 weeks, about 34 with 25% contingency) and with the roadmap's 20–33 weeks.

## 2. Phase items

### Phase 0: Audit and baseline ✅

| Item | State |
|---|---|
| `docs/AUDIT.md` (both repositories) | ✅ |
| `IMPLEMENTATION_INVENTORY.md`, `ARCHITECTURE_DECISIONS.md`, `EXECUTION_TRACKER.md` | ✅ |
| Baseline tests recorded (870 front end; 42 / 69 server; 136 core) | ✅ |

### Phase 1: Contract and foundation hardening 🔒

| # | Item | Source | Repository | Acceptance |
|---|---|---|---|---|
| 1.1 | Error body `{ code, values, requestId, message? }`; front end reads `values` (and `details` during the switch); contract §2 updated | H-1, ADR-004 | both | Contract test passes on both sides; translated values shown |
| 1.2 | Session cookie names, refresh flow and CSRF header decided and written into the contract | H-2, ADR-007 | both | ADR-007 accepted; contract §2 updated (code ships in phase 3) |
| 1.3 | `packages/core/SOURCE` with the web commit; CI parity against it; scheduled drift report | M-1, ADR-003 | backend | A web merge no longer turns backend CI red; drift reported |
| 1.4 | Import-rule test: domain cannot import HTTP or infrastructure; modules only through their interface | M-2, ARC-06 | backend | Test fails on a forbidden import |
| 1.5 | Two negative tests of the session context guard | L-1 | backend | Malformed id and unknown role refused |
| 1.6 | Docs reflect the code (architecture, database, contract) | Standards | both | Reviewed |

### Phase 2: Database, transactions, audit, workers 🔄

| # | Item | Source | State |
|---|---|---|---|
| 2.1 | Schemas, roles, RLS, migrations, stamps | B1a step 2 | ✅ (#3) |
| 2.2 | Unit of work, audit trails, outbox, queue, scheduler, worker | B1a step 3 | 🔄 PR #5, CI green |
| 2.3 | Worker heartbeat and metrics log (queue depth, oldest due, dead, outbox lag) | M-3, QAL-08, JOB-07 | ⬜ |
| 2.4 | Audit seal and verify jobs (`audit.seals`) | M-4, TRL-05 | ⬜ |
| 2.5 | Exit gate (B1a step 4): guard suite, privilege suite, audit secret scan (TRL-04) | Cahier B1a gate | ⬜ |

### Phase 3: Identity, authentication, authorization (B1b) ⬜

| # | Item | Source |
|---|---|---|
| 3.1 | Realm sessions (access and rotating refresh tokens, hashed), sign-in, sign-out, lockout, password rules (12+, breached check) | IAM-01–IAM-10 |
| 3.2 | CSRF double-submit and `Origin` check; front end sends `X-XSRF-TOKEN` | SCR-16, F11 |
| 3.3 | Workspaces, memberships, workspace switch, owner rules | WSP, F8 |
| 3.4 | Roles and permission engine; actor only from the session; record rules | AUZ, IAM-01 |
| 3.5 | Second factor, step-up for sensitive actions, sessions list and administrator revoke | IAM-05, IAM-06, IAM-19, F3, F7 |
| 3.6 | Access log with workspace and principal | M-5, QAL-07 |
| Gate | Isolation and permission suites green; sign-in works end to end from the existing screens | Cahier B1b |

### Phase 4: First vertical slice ⬜

| # | Item | Source |
|---|---|---|
| 4.1 | First module folders (relations, work, people, time, approvals) under the import rule | ADR-001, ADR-008 |
| 4.2 | Tables and endpoints for clients, projects, members, time entries, submit and approve | Cahier §7, §11–12 |
| 4.3 | Optimistic-lock helper and `CONFLICT_STALE_VERSION`; front end sends `version` and reloads on conflict | H-5, F5, TRX-06 |
| 4.4 | Money adapter (`toCents` / `fromCents`) for rates; first property tests | H-3, ADR-005 |
| 4.5 | Front-end API modules of the slice call the server outside demo mode; React Query invalidation; loading, error, conflict states | Roadmap 4 |
| 4.6 | Integration tests and a Playwright scenario on the real server (scenario steps 1–5) | Cahier Table 64 |
| Gate | Data survives reload and restart; two members share it; an outsider cannot read or change it; conflicts handled | Roadmap 4 |

### Phases 5–8 ⬜

Planned in the cahier (§21.2) and in the roadmap. Each is broken down into items here when the previous phase passes its gate. Items already known:

| Phase | Known items |
|---|---|
| 5 | The 12 CRM and 12 work features (REL-11–REL-22, WRK-12–WRK-22); settings and lists; leave and balances; operational reports |
| 6 | Idempotency keys (H-4, F4) before any money command; gap-free numbering; approval rule on quotes and invoices (F1, F2); concurrency and money suites |
| 7 | Files with allow-list and scanning; e-mail through the outbox; the notice feed (F12); portal sign-in link (F6); console backend; support sessions |
| 8 | Audit retention (TRL-06); restore test; monitoring and alerts; staging; load test (QAL-01); key rotation; external penetration test |

## 3. Open decisions for the owner

| # | Decision | Needed before |
|---|---|---|
| ADR-004 | Error body with `values` | Phase 1 |
| ADR-005 | Money: keep number rules with an adapter and property tests | Phase 4 |
| ADR-007 | Realm cookie names and refresh flow | Phase 1 |
| ADR-008 | Vertical slice before the rest of B1c | Phase 4 |
| OD-1 to OD-8 | Cahier open decisions (invoice cancellation, retention, region, e-mail provider, scanner, managed database, default approval rule, support write access) | The phases that use them |

# Nexora: execution tracker

_The engineering roadmap (phases 0–8) laid onto the delivery plan of the cahier des charges (phases B1a–B3, §21.2), with every open item. One phase is approved and worked at a time; each ends with its gate, tests and an updated inventory. Last update: 6 November 2026: Phase 1 steps 1 to 6 merged: **B1a complete** (10 November 2026). B1b started 11 November 2026: step 1 merged, step 2 open. Earlier: 5 November 2026, Phase 0 approved; decisions E1–E5 in the cahier des charges 2.2 (§1.2, §21.5). The step-by-step log is §8 of `docs/AUDIT.md`._

**Legend:**
- ✅ done
- 🔄 in progress or in an open pull request
- ⏳ next
- ⬜ planned
- 🔒 waits for the owner's approval

## 1. Roadmap ↔ cahier phases

| Roadmap phase | Cahier phase | Content | Estimate | State |
|---|---|---|---|---|
| 0 Audit and baseline | — | This audit, inventory, decisions, tracker | 1 day | ✅ approved, merged (#5, Nexora-Saas #140) |
| 1 Contract and foundation hardening | B1a step 4 | Error body (E1), session contract (E2), pinned rules (ARC-12), import-rule test, contract tests (ARC-13) | 1 week | ✅ steps 1–6 merged (#7–#12, Nexora-Saas #142–#147) |
| 2 Database, transactions, audit, workers | B1a steps 2–4 | Steps 2 and 3 (#3, #5); heartbeat and seals (#11); exit gate (#12) | — | ✅ B1a gate passed |
| 3 Identity, authentication, authorization | B1b | Sessions, sign-in, CSRF, memberships, roles, permission engine, step-up, devices | 2–3 weeks | 🔄 step 1 ✅ (#19), step 2 🔄 |
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

### Phase 1: Contract and foundation hardening ✅

Done in six pull requests, in this order, each with its own tests and checks; the last one closes phase B1a.

| PR | Items | State |
|---|---|---|
| 1 | 1.1 error body (both repositories) | ✅ merged (#7, Nexora-Saas #142) |
| 2 | 1.2 session and CSRF contract (docs, both repositories) | ✅ merged (#8, Nexora-Saas #143) |
| 3 | 1.3 pinned shared rules | ✅ merged (#9, Nexora-Saas #144) |
| 4 | 1.4 import-rule test and 1.5 session guard tests; security plan | ✅ merged (#10, Nexora-Saas #145) |
| 5 | 2.3 worker heartbeat and 2.4 audit seal | ✅ merged (#11, Nexora-Saas #146) |
| 6 | 2.5 B1a exit gate, 2.6 supply-chain and SQL checks, 1.6 docs | ✅ merged (#12, Nexora-Saas #147) |


| # | Item | Source | Repository | Acceptance |
|---|---|---|---|---|
| 1.1 | Error body `{ code, values, requestId, message? }`; front end reads `values` (and `details` during the switch); contract §2 updated | H-1, ADR-004 | both | Contract test passes on both sides; translated values shown (done, step 1) |
| 1.2 | Session cookie names, refresh flow and CSRF header decided and written into the contract; realm and version path prefixes added | H-2, H-6, ADR-007 | both | ADR-007 accepted; contract §2 updated (code ships in phase 3) (done, step 2) |
| 1.3 | `packages/core/SOURCE` with the web commit; CI parity against it; scheduled drift report | M-1, ARC-12 | backend | A web merge no longer turns backend CI red; drift reported (done, step 3; 5 script tests) |
| 1.4 | Import-rule test: domain cannot import HTTP or infrastructure; modules only through their interface | M-2, ARC-02, ARC-06 | backend | Test fails on a forbidden import (done, step 4: 7 tests, rules in `ARCHITECTURE.md` §3.3) |
| 1.5 | Two negative tests of the session context guard | L-1 | backend | Malformed id and unknown role refused (done, step 4: 9 cases, no connection taken) |
| 1.6 | Docs reflect the code (architecture, database, contract) | Standards | both | Reviewed (done, step 6: stale statements fixed in both READMEs, architecture, database, decisions and inventory) |

### Phase 2: Database, transactions, audit, workers ✅

| # | Item | Source | State |
|---|---|---|---|
| 2.1 | Schemas, roles, RLS, migrations, stamps | B1a step 2 | ✅ (#3) |
| 2.2 | Unit of work, audit trails, outbox, queue, scheduler, worker | B1a step 3 | ✅ (#5) |
| 2.3 | Worker heartbeat and metrics log (queue depth, oldest due, dead, outbox lag) | M-3, JOB-09 | ✅ step 5 (`ops.worker_heartbeats`, `workerHealth()`); the alert channel that reads it comes with monitoring (B2) |
| 2.4 | Audit seal and verify jobs (`audit.seals`) | M-4, TRL-05 | ✅ step 5; retention (TRL-06) stays in phase 8 |
| 2.5 | Exit gate (B1a step 4): guard suite, privilege suite, audit secret scan (TRL-04) | Cahier B1a gate | ✅ step 6: `privileges.test.ts`, `audit-secrets.test.ts` (with migration 0008), guard tests listed in the inventory |
| 2.6 | Security plan G-1 to G-4: actions pinned to a commit, secret scan in CI, Dependabot security updates, a test that refuses string-built SQL | `SECURITY_PLAN.md`; SCR-02, SCR-06, SCR-10 | ✅ step 6 (both repositories); the owner switches on GitHub secret scanning and Dependabot security updates in the settings |

### Phase 3: Identity, authentication, authorization (B1b) 🔄

Done in five pull requests, in this order, each with its tests; the last one passes the B1b gate.

| Step | Items | State |
|---|---|---|
| 1 | Identity module and tables: accounts, sessions, refresh tokens, single-use tokens; Argon2id; 12-character rule with the leaked-password list; lockout rule; session limits per realm; random tokens stored hashed (part of 3.1) | ✅ merged (#19, Nexora-Saas #154) |
| 2 | Member sign-in, sign-out, refresh with rotation and reuse detection, `me`; realm cookies; CSRF double submit and `Origin`; rate limits; identity audit events; access log with redaction; G-5 to G-7 (rest of 3.1, 3.2, 3.6, 3.7) | 🔄 open, waits for the owner |
| 3 | Workspaces and memberships, workspace in the path checked on every request, switch, owner rules; roles and the permission engine; denials audited (3.3, 3.4) | ⬜ |
| 4 | Second factor (TOTP, recovery codes), step-up for sensitive actions, sessions list and revoke, passcode lock (3.5) | ⬜ |
| 5 | Web application switched: `client.ts`, `proxy.ts`, `X-XSRF-TOKEN` (F11), mock API; sign-in end to end from the existing screens; isolation and permission suites (B1b gate) | ⬜ |


| # | Item | Source |
|---|---|---|
| 3.1 | Realm sessions (access and rotating refresh tokens, hashed), sign-in, sign-out, lockout, password rules (12+, breached check) | IAM-01–IAM-10 |
| 3.2 | CSRF double-submit and `Origin` check; front end sends `X-XSRF-TOKEN`; realm routers and cookies, `client.ts`, `proxy.ts` and the mock API switched together (contract §2, ADR-007 "Shipping") | SCR-16, F11, H-6 |
| 3.3 | Workspaces, memberships, workspace switch, owner rules | WSP, F8 |
| 3.4 | Roles and permission engine; actor only from the session; record rules | AUZ, IAM-01 |
| 3.5 | Second factor, step-up for sensitive actions, sessions list and administrator revoke | IAM-05, IAM-06, IAM-19, F3, F7 |
| 3.6 | Access log with workspace and principal; personal data redacted from logs (G-6) | M-5, QAL-07 |
| 3.7 | Security plan G-5 and G-7: TLS required for the production database; proxy hop count from configuration | `SECURITY_PLAN.md`; SCR-01 |
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
| 8 | Audit retention (TRL-06); restore test; monitoring and alerts (including the missing-worker alert of JOB-09 and the dead-job alert of JOB-07); staging; load test (QAL-01); key rotation; external penetration test; release procedure deploys web and server from commits whose rules match (ARC-12) |

## 3. Open decisions for the owner

| # | Decision | Needed before |
|---|---|---|
| ~~ADR-004, ADR-005, ADR-007, ADR-008~~ | Accepted on 5 November 2026 (E1–E4) | — |
| OD-1 to OD-8 | Cahier open decisions (invoice cancellation, retention, region, e-mail provider, scanner, managed database, default approval rule, support write access) | The phases that use them |

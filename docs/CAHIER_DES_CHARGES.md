# Nexora ERP — Cahier des charges: Backend and Database

**Technical specification of the backend and database: Server, Data and Security Platform**
_for every Nexora user: companies, their people, their clients and the Nexora team_

| | |
|---|---|
| **Version** | 2.1 |
| **Reference date** | 29 October 2026 |
| **Status** | For review and approval |
| **Scope** | Server, database, background jobs, files, security |
| **Baseline** | Nexora front end after audit fixes A1–A4 and API contract v2 (`yahyanaim/Nexora-Saas`, `docs/API_CONTRACT.md`); Architecture repository (backend part) |
| **Supersedes** | Version 2.0 of 16 October 2026 |
| **Classification** | Confidential |

> **The server decides • One transaction per action • Isolation in depth**

> **What changed in 2.1.** 24 features built in the front end after the 2.0 baseline (12 CRM, 12 projects) with their tables, requirements (REL-11 to REL-22, WRK-12 to WRK-22, IAM-18, IAM-19), jobs and state machines; the decisions D1–D8 (28 October) and B1–B13 (29 October); the security plan by OWASP area (§18.4); the front-end items the server needs (§21.4); corrected counts; a longer delivery plan; and Annex F (error codes). Every change is listed in Annex E. Paragraphs that changed carry the mark **[2.1]**.

## Table of contents

1. [Executive Summary](#1-executive-summary)
2. [Objectives and Scope](#2-objectives-and-scope)
3. [Actors and Access](#3-actors-and-access)
4. [Starting Point: Two Repositories](#4-starting-point-two-repositories)
5. [Target Architecture](#5-target-architecture)
6. [Database Design Rules](#6-database-design-rules)
7. [Data Model](#7-data-model)
8. [Identity, Sign-in and Sessions](#8-identity-sign-in-and-sessions)
9. [Multi-Tenancy and Isolation](#9-multi-tenancy-and-isolation)
10. [Authorization](#10-authorization)
11. [Business Modules I: Workspace, People, Clients and Projects](#11-business-modules-i-workspace-people-clients-and-projects)
12. [Business Modules II: Time, Approvals, Sales and Purchases](#12-business-modules-ii-time-approvals-sales-and-purchases)
13. [Business Modules III: Finance, Analytics, Files and Notifications](#13-business-modules-iii-finance-analytics-files-and-notifications)
14. [Platform Console Backend](#14-platform-console-backend)
15. [Transactions, Consistency and Critical Flows](#15-transactions-consistency-and-critical-flows)
16. [Audit Trail](#16-audit-trail)
17. [Background Jobs and Scheduling](#17-background-jobs-and-scheduling)
18. [Security](#18-security)
19. [Privacy, Retention and Compliance](#19-privacy-retention-and-compliance)
20. [Quality, Operations and Testing](#20-quality-operations-and-testing)
21. [Migration from Demonstration Mode and Delivery Plan](#21-migration-from-demonstration-mode-and-delivery-plan)
22. [Risks, Dependencies and Open Decisions](#22-risks-dependencies-and-open-decisions)
- [Annexes](#annexes): A Glossary · B State Machines · C Traceability · D Requirement Summary · E Document Control · F Error Codes

---

## 1. Executive Summary

Nexora is an ERP for companies that sell time, services or products: IT agencies, engineering and consulting firms, studios and other service companies, first in Morocco. Every screen of the product exists today and runs on demonstration data stored in the browser. This document specifies the part that does not exist yet and that every user will depend on: the server and the database. From the moment a real company signs in, the server decides who may do what, stores every record, issues every invoice number, keeps the money exact to the centime, runs the scheduled work, and proves afterwards who did what.

**Why this part is critical.** The front end can be rebuilt in a day if a screen is wrong. The data cannot. An invoice issued twice with the same number, an hour approved by the person who logged it, a salary visible to a colleague, or a client of one company visible to another would each be a legal, tax or trust failure that no screen can undo. The requirements below are therefore written to make those failures impossible by construction, not merely unlikely.

**What this document covers.** The backend and the database for all of Nexora's users: the five roles inside a customer company (administrator, manager, accountant, employee and the client's portal contact), the seven roles of the Nexora team who run the platform console, and the system itself (scheduled jobs, the bank, the tax administration and the e-mail service). It does not specify the public production API, which comes later: the server described here serves the Nexora web application, and its internal contract is designed so that a public API can be added without changing the core.

### 1.1 Current State

- **The front end is complete.** **[2.1]** 56 API modules expose **362** functions, all mapped to an endpoint in the API contract v2 (`docs/API_CONTRACT.md`, kept in step by the test `api-contract.test.ts`). They are the only callers of storage, so replacing their bodies with server calls changes no page. The business rules live in **62** pure TypeScript files (about **12,500** lines with their tests) covering billing, approvals, leave balances, VAT, the CGNC journal, the UBL e-invoice, bank matching, revenue recognition, payroll inputs, the CRM (leads, deals, client history, import), tasks (states, repetition, cycles), client requests, project pages, the inbox, and the console's billing and lifecycle. **143** test files hold **869** tests.
- **The console is specified.** The platform console cahier des charges (184 identifiers) is implemented in the front end; its server parts are listed as Lot B in the repository plan.
- **A backend foundation exists elsewhere.** The Architecture repository provides a hexagonal Express server with sessions, tenant scoping, a job queue, an outbox, idempotency keys and an audit table. Section 4 assesses it: its plumbing is reused, its storage and authorization model are replaced.
- **The front end has been audited.** **[2.1]** The full audit of October 2026 (2 high, 9 medium, 12 low findings) is fixed in the front end (A1–A4). What remains is server work, listed in §18.4 and Annex C.
- **What is missing everywhere.** Server-side identity, permissions enforced per request, a real database with integrity constraints, gap-free numbering under concurrency, atomic business actions, an append-only audit trail, scheduled jobs and the separation of the console from company data.

### 1.2 Decisions Already Taken

The owner approved the following on 16 October 2026; the rest of the document builds on them.

**Table 1: Decisions taken before this specification.**

| Decision | Choice | Main reason |
|---|---|---|
| Repository layout | **[2.1, B13]** Two repositories: the web application (`Nexora-Saas`) and the server (`Nexora-Backend`). The server repository holds the shared package of business rules (`packages/core`); the web application consumes the same package | The owner created a separate server repository on 29 October; one package of rules still keeps one rule in one place |
| Database | PostgreSQL only; SQLite and the dual-dialect SQL are dropped | Transactions, row locks, row-level security, real date and numeric types |
| Money | Integer centimes (`bigint`) with an ISO currency code; rates and percentages in `numeric` | No rounding drift between screen, PDF, journal and VAT return |
| Payroll | Payroll inputs and employer cost in version 1; official payslips later | Payslips carry legal duties and yearly rate changes |
| Payments | Bank transfer by default; card payments through CMI in a later phase behind a provider port | Decision D-01; no card data ever stored |
| Public API | Not in this scope; designed for, not built | The owner's instruction for this phase |

**[2.1]** On 28 and 29 October 2026 the owner took the decisions below, after the front-end audit and the API contract v2. They override version 2.0 where the two differ; the sections they change are named.

**Table 1b: Decisions of 28 October 2026 (D1–D8).**

| # | Question | Decision | Changes |
|---|---|---|---|
| D1 | Where the API lives | Same origin as the web application: cookies `SameSite=Lax`, the `X-XSRF-TOKEN` double-submit header and an `Origin` check | §8.2, SCR-04 |
| D2 | Who must use a second factor | Required for Nexora staff, workspace owners, administrators and accountants; optional for others. TOTP plus 10 recovery codes; passkeys later | IAM-05 |
| D3 | Session limits | Console 15 min idle, 8 h absolute; members 30 min idle (the lock screen shows first when a passcode is set), 12 h absolute | Table 6, IAM-07 |
| D4 | What each plan includes | Starter: projects, time, approvals, quotes, invoices, portal. Business adds DGI e-invoice, VAT return and journal, suppliers and bills, resource planning, deals and forecast. Enterprise adds several workspaces, single sign-on, audit export | WSP-09, WSP-10 |
| D5 | Password length | 12 characters minimum, any characters, checked against breached passwords, no forced periodic change | IAM-03 |
| D6 | Personal data rights | Keep personal data export and account deletion (Law 09-08); notification preferences come with server notifications | RET, NTF |
| D7 | File size limits | Documents and receipts 10 MB, client and task files 20 MB, logo and avatar 2 MB; total storage per plan | DOC-02 |
| D8 | Deleting a project with history | Refused; the project is closed instead | WRK-22 |

**Table 1c: Decisions of 29 October 2026 (B1–B13), settling where 2.0 and the API contract v2 differed.**

| # | Topic | Decision | Changes |
|---|---|---|---|
| B1 | Session limits | D3 for members and staff; the portal keeps 2 h idle, 7 days absolute | Table 6, IAM-07 |
| B2 | Who must use a second factor | D2 (adds administrators and accountants) | IAM-05 |
| B3 | Password length | 12 characters (D5) | IAM-03 |
| B4 | Routes, hosts and cookies | The three realms stay, merged with the contract: `/app/v1/workspaces/:wid/…` and `/portal/v1/…` on the application's domain, `/platform/v1/…` on the console host. The workspace in the path is accepted only after the membership check | ARC-07, ARC-09, TEN-01, Table 6 |
| B5 | Error codes | The front end's catalogue of `err_…` keys is the single source; Annex F maps each code this document names to its key | ARC-08, Annex F |
| B6 | Money on the wire | Stored in centimes; JSON in major units with 2 decimals, converted at the HTTP adapter (half-up), with a property test both ways | DAT-05 |
| B7 | When a quote gets its number | When it is sent, like an invoice at issue; drafts stay unnumbered | SAL-01, Annex B |
| B8 | Upload limits | D7 limits with the 2.0 type list; SVG and HTML refused; XML only for the server's own UBL files | DOC-02 |
| B9 | API keys and webhooks | Out of v1; the front end's Developer page is hidden in production | §2.3 |
| B10 | Portal sign-in | Single-use e-mail link (IAM-12); the front end adds a "send me a sign-in link" screen | IAM-12, §21.4 |
| B11 | Workspace of a request | Named in the path, checked against an active membership; refused otherwise (403 and an audit event) | TEN-01 |
| B12 | Priority of notices | NTF-05 and NTF-07 are Must: one feed replaces the inbox's many lists | NTF-05, NTF-07 |
| B13 | Repository layout | Two repositories (see Table 1); `packages/core` lives in the server repository and is published for the web application | Table 1, §4, §5.1, ARC-01 |

### 1.3 Design Principles

When two requirements conflict, the earlier principle wins.

1. **Data correctness first.** A record that breaks a business rule must be impossible to store, not just rejected by a screen. Rules are enforced in the database where they can be (constraints, keys, triggers) and in the domain layer for the rest.
2. **Isolation in depth.** A company's data is protected three times: by the server's scoping, by row-level security in the database, and by separate database roles for the console. Any one layer failing must not expose data.
3. **The server decides.** Identity, permissions, the acting person, dates, numbers and totals come from the server. The client sends intentions, never facts it could forge.
4. **One business action, one transaction.** Every change that must happen together (a number, the lines, the locked hours, the audit event, the follow-up message) commits together or not at all.
5. **Everything is recorded.** Every state-changing action writes an append-only audit event with actor, time, before and after.
6. **Reuse what is proven.** The tested rules of the front end become the server's rules unchanged; the Architecture repository's tested plumbing is kept where it fits.
7. **Simple and proportionate.** One deployable server, one database, no microservices, no message broker, no cache unless measured need appears. Every technology must answer "what problem does it solve here".

### 1.4 How to Read This Document

Requirements use the MoSCoW priorities: **M** (Must, needed before the first paying company uses the server), **S** (Should, before general availability), **C** (Could) and **W** (Won't in this scope). Each requirement has a stable identifier made of a prefix and a number, and an acceptance criterion that a test can check. Identifiers from the platform console cahier des charges (CUS, SUB, INV, PAY, SUP, AUD, BR, SEC, NFR…) and from the ERP functional specification (TIM, BIL, PRJ, CRM, HR, PLT, KPI…) are referenced, never redefined. The functional specification's business rules are written FBR-n to tell them apart from the console's BR-nn. **[2.1]** Error codes are written in `UPPER_SNAKE` for readability; Annex F gives the catalogue key the server actually returns.

**Table 2: Requirement identifier prefixes used in this document.**

| Prefix | Area | Prefix | Area |
|---|---|---|---|
| ARC | Architecture and code organisation | SAL | Quotes, invoices, payments, receivables |
| DAT | Database rules and conventions | PUR | Suppliers, bills and expenses |
| IAM | Identity, sign-in and sessions | FIN | Bank, journal, VAT, e-invoicing |
| TEN | Multi-tenancy and isolation | ANL | Analytics, KPIs and reports |
| AUZ | Authorization | DOC | Files and documents |
| WSP | Workspace, settings and subscription | NTF | Notifications, e-mail and inbox |
| PPL | People and HR | PLF | Platform console backend |
| REL | Clients, CRM and portal | TRX | Transactions and concurrency |
| WRK | Projects, tasks and planning | TRL | Audit trail |
| TME | Time entries and timers | JOB | Background jobs and scheduling |
| APR | Approvals | SCR | Security |
| RET | Privacy and retention | QAL | Quality, performance, operations |
| TST | Testing and acceptance | MIG | Migration from demonstration mode |

---

## 2. Objectives and Scope

The backend exists so that a company can trust Nexora with its hours, its invoices and its people, and so that the Nexora team can run the platform without ever reaching into that data uninvited. Each objective below has a measure that will show, three months after the first paying company, whether it was met.

### 2.1 Objective Register

**Table 3: Objectives of the backend and their measures.**

| ID | Objective | Measure |
|---|---|---|
| OBJ-B1 | No company ever sees another company's data | Zero cross-tenant reads in the isolation test suite and in production audit sampling |
| OBJ-B2 | Every invoice number is unique and gap-free per series and year | Zero duplicates and zero gaps, checked nightly by a reconciliation job |
| OBJ-B3 | Money is exact to the centime everywhere | Invoice, journal and VAT return totals agree to the centime in property tests and nightly checks |
| OBJ-B4 | Nobody acts beyond their role | 100% of endpoints covered by the permission test matrix; zero self-approvals stored |
| OBJ-B5 | Every change is traceable | 100% of state-changing actions have an audit event; audit tables reject update and delete |
| OBJ-B6 | Scheduled work happens once and on time | Renewals, reminders and recurring invoices run on their date; replays never duplicate |
| OBJ-B7 | The screens stay fast with real data | Lists under 300 ms and reports under 2 s at the 95th percentile with the capacity of Table 4 |
| OBJ-B8 | Data survives incidents | Daily backup, monthly restore test, point-in-time recovery within 15 minutes of data loss |

### 2.2 In Scope

- The server for every module of the web application: workspace and settings, people and HR, clients and CRM **[2.1]** (leads, contacts, follow-ups, sales stages, client history, deleted-clients bin, merge, import, shared list views), the client portal **[2.1]** (with client requests), projects and planning **[2.1]** (task states, keys, watchers, relations, views, cycles, repeating tasks, task bin, project pages), time and timers, approvals, quotes, invoices, payments and receivables, suppliers, bills and expenses, bank import, the CGNC journal, the VAT return, the DGI e-invoice file, analytics and reports, files, notifications and the inbox.
- The server side of the platform console: customers, plans, subscriptions, Nexora's own invoices, payments, dunning, staff, support sessions, incidents, data requests and the console audit trail, as specified by the console cahier des charges.
- The PostgreSQL database: schemas, tables, constraints, row-level security, roles, migrations, seed data and retention.
- Identity and sessions for the three kinds of people who sign in, and the authorization of every action.
- Background jobs, scheduling, the outbox, e-mail sending and file storage.
- Security, privacy, observability, backups and the test strategy.
- The internal application interface the web application calls, as far as needed to replace the demonstration storage. **[2.1]** Its paths, shapes and error codes are those of the API contract v2, with the routes of decision B4.

### 2.3 Out of Scope

- A public, documented production API for third parties, API keys, OAuth applications and outbound customer webhooks. They come in a later phase; Section 5 keeps the seams for them. **[2.1, B9]** The front end's Developer page (keys and webhooks) is hidden in production until then.
- Card payments and the CMI integration (phase B2). Only the provider port and the webhook ledger pattern are specified.
- Official payslips, CNSS and income-tax declarations. Payroll inputs and employer cost are in scope.
- Sending e-invoices to the DGI platform, which depends on the national calendar and the platform's technical specification. Generating, storing and tracking the UBL file is in scope.
- A dedicated database per Enterprise customer (decision D-10, later); the design keeps it possible.
- The visual design of the web application, already delivered.

### 2.4 Assumptions and Constraints

1. **Team.** One full-stack developer builds and runs the backend during the first year. The design must stay understandable and operable by one person: one server image, one database, no infrastructure that needs a dedicated operator.
2. **Hosting.** The server runs in Docker (the owner's choice) behind a reverse proxy with TLS, on a host in Morocco or the European Union (open decision OD-3). PostgreSQL 16 or later, managed or self-hosted with point-in-time recovery.
3. **Runtime.** Node.js 22 LTS and TypeScript in strict mode, the language of the existing rules, so they run unchanged.
4. **Country.** Moroccan companies first: MAD, Moroccan VAT, ICE and IF identifiers, the CGNC chart of accounts, Law 09-08 on personal data and Law 69-21 on payment terms. Other countries keep free-text identifiers and no Moroccan-only checks.
5. **Languages.** Nine interface languages. The server returns error codes, never translated sentences; e-mails are rendered in the recipient's language.
6. **Front end.** The web application is a Next.js application; its API modules keep their names and signatures, and their bodies become calls to the server. **[2.1]** It lives in its own repository and calls the server on the same origin (D1).

### 2.5 Capacity Assumptions

The design targets the following volume after three years. Performance requirements (Section 20) are measured against it, with a load-test data set of this size.

**Table 4: Capacity assumptions after three years.**

| Quantity | Target | Note |
|---|---|---|
| Customer companies (workspaces) | 1,000 | Console requirement NFR-03 |
| People with a sign-in | 25,000 | 25 per company on average |
| Largest company | 500 people | Enterprise plan, no seat limit |
| Time entries | 15 million | About 5 per person per working day |
| Client invoices | 600,000 | With about 3 million lines |
| Files | 2 million, 2 TB | Receipts, contracts, PDFs, UBL files |
| Requests at peak | 50 per second | Friday afternoon timesheet submission |
| Audit events | 60 million | Kept at least 5 years |

### 2.6 Success Criteria

The backend is ready when the reference scenario of Section 20.3 runs end to end against the server with the expected amounts and numbers; the isolation, permission, concurrency and audit test suites pass; the demonstration mode can be switched off for every API module; a restore from backup has been carried out and timed; and an external reviewer confirms that neither another company nor a console operator can read a company's business data without an approved support session.

---

## 3. Actors and Access

Nexora has three kinds of people who sign in, plus actors that are not people. They differ in where they sign in, what they may change and which records they may see. The server knows them as *principals*: every request carries exactly one principal, and every rule of this document is expressed in terms of it.

### 3.1 Actor Catalogue

**Table 5: Actors of Nexora and what the server must guarantee for each.**

| Actor | Uses Nexora to | The server guarantees |
|---|---|---|
| **Inside a customer company (tenant)** | | |
| Owner / Administrator | Configure the company, roles, approval rules, period locks, subscription; do any business action | Full rights inside their workspace only; at least one active owner always remains; sensitive actions need a fresh second factor |
| Manager | Run projects and clients, approve the hours, expenses and leave of their team, follow analytics | Approves only people under them, never their own requests; sees no cost or salary data without the cost permission |
| Accountant | Quotes, invoices, credit notes, payments, bank import, suppliers and bills, journal, VAT, profitability | Gap-free numbering, locked periods, exact money; issued documents cannot be altered |
| Employee | Log time, run the timer, submit expenses and leave, follow tasks, complete reviews | Sees and changes only their own records and the projects they belong to; never sees rates, costs or other people's pay |
| Client contact (portal) | See their projects, invoices and documents; accept quotes; sign off milestones; answer surveys; **[2.1]** send requests and decide change orders | Sees only the records of the one client they belong to, in one workspace; has no ERP right |
| **The Nexora team (platform console)** | | |
| Staff: owner, admin, support, finance, engineering, sales, read-only | Run customers, plans, subscriptions, Nexora's invoices, payments, support, incidents, staff and audit | Separate sign-in and sessions, mandatory second factor, step-up and two-person approval per Table 23 of the console specification; no access to company business data outside an approved support session |
| **Non-human actors** | | |
| Scheduler and workers | Renewals, dunning, trial end, recurring invoices, reminders, reconciliation, purges, summaries | Each job is idempotent, runs under a named system principal, and is audited |
| Bank | Statement files imported by an accountant | Each line is imported once; matching is suggested, allocation is confirmed by a person |
| Payment provider (later) | Card payments and settlements | Signed, idempotent webhooks; no card data stored |
| DGI e-invoicing platform (later) | Receives UBL files | Files stored with a hash; status tracked per invoice |
| E-mail service | Sends invitations, invoices, reminders, notices | Sent from the outbox after commit; retried; never inside a business transaction |

### 3.2 Principals and Sign-in Realms

Three realms are kept apart in the data model, the cookies and the sessions. A person may have accounts in more than one realm (an accountant who is also a client contact of another company), but the accounts are separate and never merged.

**Table 6: Sign-in realms.** **[2.1: B1, B2, B4]**

| | Member | Portal contact | Staff |
|---|---|---|---|
| Who | People of a customer company | Contacts of a company's client | The Nexora team |
| Account table | `identity.users` | `identity.portal_users` | `platform.staff` |
| Scope | One or more workspaces through memberships | One client of one workspace | The platform; no workspace membership allowed |
| Routes | `/app/v1/…`, workspace records under `/app/v1/workspaces/:wid/…` (application domain) | `/portal/v1/…` (application domain) | `/platform/v1/…` (console host only) |
| Session cookie | `nx_m` | `nx_p` | `nx_s` (console host only) |
| Session limits | **30 min idle** (the lock screen shows first when a passcode is set), **12 h absolute** | 2 h idle, 7 days absolute | **15 min idle, 8 h absolute** (SEC-06) |
| Second factor | Optional; **required for owners, administrators and accountants**, and for everyone when the workspace demands it | Not offered in v1 (e-mail link sign-in) | Mandatory (SEC-03) |
| Data reached | Tenant tables under row-level security | Tenant tables through portal views only | Platform tables only (SEC-02) |

The system principal (`system:<job>`) is used by jobs. It never has a session, it is recorded as the actor of what it does, and it reaches only the tables its job needs.

### 3.3 Work Roles and Default Permissions

Each membership carries one role and an owner flag. Four member roles exist by default (administrator, manager, accountant, employee); an administrator can create custom roles from the same permission catalogue (Section 10). An owner is an administrator whose membership carries the owner flag; the owner-only actions of this document (moving the lock date back, transferring ownership, deleting the workspace, signing in while suspended) check that flag. The Client column describes the portal contact, whose rights are fixed by the portal realm and are not a membership role. Table 7 gives what each default role may do. "Own" means records the person created or is the subject of; "Team" means people who report to them directly or through the chain; "Client" means records of the portal contact's client only.

**Table 7: Default rights of the company roles (C = create, R = read, U = update, A = approve, D = delete).**

| Capability | Admin | Manager | Accountant | Employee | Client |
|---|---|---|---|---|---|
| Company settings, approval rules, period lock | CRU | – | – | – | – |
| Roles, team access, invitations | CRU | – | – | – | – |
| Subscription and seats | owner | – | – | – | – |
| Employees: profile | CRU | RU | R | R own | – |
| Employees: cost, rates, salary | CRU | – | R | – | – |
| Employees: CIN, CNSS, bank account | CRU | – | – | R own | – |
| Employee documents | CRU | RU team, not medical | – | R own | – |
| Leave requests | CRUA | C own, A team | C own | C own | – |
| Performance reviews | CRU | CRU team | own | own | – |
| Clients, contacts, contracts, notes, follow-ups **[2.1]** | CRU | CRU | RU | – | – |
| Deleting, restoring and merging clients **[2.1]** | D | D | – | – | – |
| Importing clients, contacts and deals (`clients:import`) **[2.1]** | C | C | – | – | – |
| Exporting clients (`clients:export`) **[2.1]** | R | R | R | – | – |
| Deals pipeline and sales stages **[2.1]** | CRU | CRU | RU | – | – |
| Portal access for client contacts | CRU | CRU | CRU | – | – |
| Projects, milestones, change orders | CRU | CRU | R | R member | R client, decide |
| Deleting a project without history (`projects:delete`) **[2.1]** | D | – | – | – | – |
| Tasks and comments | CRU | CRU | – | RU assigned | – |
| Project pages and meeting notes **[2.1]** | CRU | CRU | – | RU member | – |
| Client requests **[2.1]** | CRUA | CRUA | R | – | C, R client |
| Time entries and timer | CRU | C own, A team | C own, R approved | C own | – |
| Expenses | CRUA | C own, A team | C own, R approved, reimburse | C own | – |
| Quotes | CRUA | – | CRUA | – | R client, accept |
| Client invoices, credit notes | CRUA | – | CRUA | – | R client |
| Payments, reminders, bank import | CRU | – | CRU | – | – |
| Suppliers and supplier bills | CRUA | – | CRUA | – | – |
| Profitability and costs | R | – | R | – | – |
| KPIs, overview, reports | R | R | R | R own | – |
| Journal, VAT return, e-invoice files | R | – | R | – | – |
| Files | CRU | CR | CR own | CR | R client |
| Milestone sign-off, satisfaction survey | – | – | – | – | A client |
| Workspace audit log | R | – | – | – | – |
| Data export, workspace deletion | owner, step-up | – | – | – | – |

**How to read this table.** The matrix is the default the server enforces. It mirrors `WORK_ROLE_PERMISSIONS` in the front end, which keeps driving what the screens show. Where the two disagree, the server wins and the front end is corrected.

### 3.4 Record-Level Rules

A permission says what kind of action a role may take; record rules say on which records. The server applies them on every read and write, after the permission check.

1. **Own records.** An employee reads and changes only their own time entries, timer, expenses, leave requests, review forms and profile fields; they read projects and tasks only where they are a member or assignee.
2. **Team.** A manager's team is everyone whose manager chain leads to them. A manager approves for their team only, and the approver of a request is resolved by the server (direct manager, then the next manager up, then an active administrator), never chosen by the submitter (rule FBR-3 of the functional specification).
3. **No self-approval.** Nobody approves their own hours, expenses, leave, quotes, invoices or supplier bills, whatever their role, administrators included, and nobody approves a request they entered for someone else. Every approvable record and decision row stores the submitter (`submitted_by`) and the subject (`subject_principal`: the employee's principal for hours, expenses and leave, the author for documents), and a check constraint rejects a row whose approver equals either.
4. **Locked periods.** Nothing dated on or before the workspace's lock date can be created, changed or deleted, except by the documented correction paths (credit note, reversing payment).
5. **Issued documents.** Issued invoices, credit notes, accepted quotes, approved hours on an invoice, and closed projects are frozen; the only changes allowed are those their state machine lists (Annex B).
6. **Client scope.** A portal contact reaches only the records linked to their client and only the kinds the portal shows: projects, milestones, change orders sent to the client, issued invoices, accepted or sent quotes, shared documents and surveys, **[2.1]** and the requests their client sent.
7. **[2.1] Shared views.** A saved list or task view is visible to its owner, or to the workspace (list views) or the project team (task views) when shared; only its owner or an administrator removes it.

### 3.5 Field-Level Visibility

Some fields are more sensitive than the records that hold them. The server removes them from responses when the caller lacks the permission; the front end never receives them to hide.

**Table 8: Sensitive fields and who receives them.**

| Fields | Received by | Storage rule |
|---|---|---|
| Hourly cost, billable rate, rate history, gross salary, employer cost | Admin, accountant (`costs:read`) | Plain columns; reads go through a view that nulls them for other callers |
| CIN, CNSS number, bank account of an employee | Admin; the employee for their own record | Encrypted at the application level (SCR-07) |
| Medical documents | Admin; the employee for their own | Separate file prefix; access audited as a sensitive read |
| Project profit, margin, labour cost | Admin, accountant | Computed on the server, never sent raw to other roles |
| Individual KPIs of another person | Per the workspace KPI visibility setting (self, manager, everyone) | Computed on the server for the allowed people only |
| Company bank account (RIB) | Admin, accountant; printed on invoices | Change needs a fresh second factor and notifies the owners |

---

## 4. Starting Point: Two Repositories

The backend is not written from nothing. Two repositories already hold most of its parts: the Nexora repository holds the business rules, and the Architecture repository holds a tested server foundation. This section states what each brings, what is kept, and what must change. Every finding was checked in the code on 16 October 2026. **[2.1, B13]** The server itself is written in a third repository, `Nexora-Backend`, created for it on 29 October 2026; the two repositories above are its sources, not its home.

### 4.1 What the Server Inherits from the Nexora Front End

The rules below are pure functions with tests. They move to the shared package `packages/core` and run unchanged on the server; the server adds storage, locking and authorization around them.

**Table 9: Rule files reused by the server.** **[2.1]**

| Files (`src/lib`) | Rules | Server use |
|---|---|---|
| `workforce/approvals.ts` | Approver resolution, no self-approval, one or two steps, amount thresholds | Called by every approve and decide command (APR) |
| `workforce/billing.ts`, `invoice-builders.ts` | Rates at a date, unbilled hours, invoice lines, totals, withholding, balances, aging, fixed-price, milestone, retainer and advance lines | Invoice drafting, issue and receivables (SAL) |
| `workforce/money.ts`, `currency.ts` | Half-up rounding, sums, centimes, currencies | Every amount (DAT-06) |
| `workforce/vat.ts`, `journal.ts` | VAT regimes and periods, VAT return with credit carried forward, balanced CGNC entries | Finance module (FIN) |
| `workforce/e-invoice.ts`, `tax-ids.ts` | UBL 2.1 file, ICE, IF, patente and CNSS checks | Issue checks and e-invoice files (FIN) |
| `workforce/bank-import.ts` | CSV parsing, column guessing, matching and allocation | Bank import (FIN) |
| `workforce/leave-balances.ts`, `scheduling.ts`, `planning.ts` | Working days, holidays, half days, balances, carry-over, capacity | Leave and planning (PPL, WRK) |
| `workforce/revenue-recognition.ts`, `profitability.ts`, `kpis.ts`, `reports.ts` | Recognition schedules, profit, KPIs and reports | Read models (ANL) |
| `workforce/payroll.ts`, `employer-cost.ts` | Payroll inputs, Moroccan employer contributions, cost per hour | Payroll inputs export (PPL) |
| **[2.1]** `workforce/leads.ts`, `contacts.ts`, `follow-ups.ts`, `deals.ts` | Lead conversion and drop, contact e-mails and phones, follow-up states and due dates, sales stages, days in stage, stale deals, weighted pipeline | Relations module (REL-11 to REL-15) |
| **[2.1]** `workforce/client-history.ts`, `client-filters.ts`, `crm-import.ts` | Field-by-field change history, merge values and conflicts, bin days left, list filters, import parsing, column guessing and row checks | Relations module (REL-16 to REL-22) |
| **[2.1]** `workforce/task-states.ts`, `task-extras.ts`, `task-repeat.ts`, `task-grouping.ts`, `cycles.ts` | Task states inside fixed groups, task keys, assignees and watchers, relations, repetition, grouping, cycle state, burn-down, capacity and carry-over | Work module (WRK-12 to WRK-20) |
| **[2.1]** `workforce/client-requests.ts`, `project-pages.ts` | Client request states and decisions, meeting action items and their conversion to tasks | Work module (WRK-17, WRK-21) |
| **[2.1]** `workforce/inbox.ts` | Which notices each person must see, and when | Notifications (NTF-05, NTF-07) |
| `platform/billing.ts`, `customer-lifecycle.ts`, `reconciliation.ts`, `session-policy.ts`, `console-roles.ts` | Nexora's invoicing, proration, dunning, trial rules, reconciliation, staff sessions, console permission matrix | Platform console backend (PLF) |
| `lib/errors/error-catalog.ts` | **[2.1]** 441 error keys in nine languages | The server returns the same codes (Annex F) |

**Key point.** Rules that the front end only displayed must now be enforced. The pre-backend audit (October 2026) listed them: approver identity taken from the session, approval modes read from settings, field shaping per role, and numbering under concurrency. **[2.1]** The full audit that followed added CSRF, file uploads, second factor, revoked sessions and plan limits (§18.4). Each one has a requirement below.

### 4.2 Assessment of the Architecture Repository

The Architecture repository (backend part: `server/`, `server.ts`, 15 migrations) is a hexagonal Express server: domain services depend on ports, infrastructure adapters implement them, and one composition root wires them. It has about 11,500 lines of server code and 40 server test files. Table 10 gives the decision for each part.

**Table 10: Decision for each part of the Architecture repository.**

| Part | Decision | Reason and change |
|---|---|---|
| Layering: domain, ports, infrastructure, composition root | Keep, reorganise | Sound. Reorganised by business module instead of one global `entities/` folder (ARC-02) |
| Configuration read in one module | Keep | Only `config/` reads the environment; boot fails on missing or weak secrets |
| Access token plus rotating refresh token, stored hashed, reuse detection | Keep | Extended to three realms with their own limits (IAM) |
| Lockout and per-account and per-IP rate limits | Keep | Same thresholds; Redis optional, Postgres fallback (IAM-09) |
| TOTP second factor with hashed recovery codes | Keep | **[2.1]** Mandatory for staff, owners, administrators and accountants (IAM-05) |
| bcrypt password hashing | Replace | Argon2id; existing bcrypt hashes upgraded at next sign-in (IAM-02) |
| Tenancy guard test (SQL scanned for the tenant column, route chain order) | Keep, extend | Best idea of the repository; extended to `workspace_id`, row-level security and every module (TEN-07) |
| Membership model (`users.org_id` plus memberships, roles admin/user) | Replace | Two sources of truth and a two-value role; replaced by memberships with role and employee link (TEN-02, AUZ) |
| `authorizeAdmin` yes/no gate | Replace | Permission catalogue, record rules and field shaping (AUZ) |
| Job queue with leases, backoff, dead state | Keep, rebuild | Logic kept; storage moved to Postgres with `FOR UPDATE SKIP LOCKED` (JOB) |
| Outbox table and relay | Keep, fix | Becomes truly transactional: written in the business transaction (TRX-05) |
| Idempotency keys | Keep | Required on every command that creates money or numbers (TRX-04) |
| Audit table and file | Replace | Written after the change, errors swallowed, editable, details printed to the console log; replaced by append-only audit in the same transaction (TRL) |
| Storage port (local, S3) | Keep | Private bucket, signed URLs, hashes for issued documents (DOC) |
| Observability: JSON logs, request IDs, metrics, error hook | Keep | Logs must not carry personal data (QAL-07) |
| SQLite adapters, in-memory adapters, dual-dialect SQL | Drop | PostgreSQL only (DAT-01) |
| Stripe billing | Drop | Nexora bills in MAD by transfer; the signed-webhook ledger pattern is kept for the provider port (PLF-08) |
| React front end, Vite, legacy API shim, Neon driver | Drop | Not needed by the Nexora server |
| OAuth sign-in, passkeys, API keys, outbound webhooks, Swagger | Postpone | Public-API phase |

### 4.3 Defects Found in the Architecture Repository

These defects would have reached Nexora had the repository been used as it is. Each is closed by a requirement.

1. **Split storage.** When `DATABASE_URL` is set, repositories switch to Postgres but `audit.ts`, `emitOutboxEvent` and `queue.ts` keep writing to the SQLite file. Users would live in one database and their audit trail, jobs and events in another. Closed by DAT-01.
2. **No business transactions.** No domain service opens a transaction; the only `BEGIN` is in the migration runner. The "transactional outbox" is therefore not transactional. Closed by TRX-01 and TRX-05.
3. **Best-effort audit.** The audit entry is written after the change, its errors are swallowed, nothing prevents update or delete, and its details (including e-mail addresses) are printed to standard output. Closed by TRL-01 to TRL-04 and QAL-07.
4. **Text types.** Identifiers, timestamps and money are `TEXT`; nothing describes an amount. Closed by DAT-03 to DAT-07.
5. **Documentation drift.** The audit document states that queries are scoped by `organization_id = ?`; the column is `org_id`. The repository's 9.5/10 scores are self-assessed. Closed by TST-01, which makes the tests, not documents, the evidence.
6. **Role override in the tenant resolver.** The multi-workspace header replaces `account.role` on the shared request object, so a later middleware cannot tell the membership role from the account role. Closed by TEN-03.

### 4.4 What Neither Repository Has

- Gap-free numbering per workspace, series and fiscal year under concurrent issue.
- Optimistic locking on editable records.
- Row-level security and separate database roles for the console.
- State machines enforced by the server for invoices, quotes, time, leave, expenses, bills, projects, subscriptions and support sessions **[2.1]**, and for clients, follow-ups, client requests, cycles and tasks.
- A scheduler for time-based business work (renewals, reminders, recurring invoices, purges).
- Server-side read models for KPIs, profitability, reports and the inbox.
- Encryption of the most sensitive personal fields.

---

## 5. Target Architecture

The backend is a modular monolith: one deployable server, split inside into business modules with strict boundaries, backed by one PostgreSQL database. This is the simplest shape that meets the requirements. Microservices, a message broker or a separate cache would add operations a single developer cannot carry, and nothing in the capacity of Table 4 needs them.

### 5.1 Repository and Runtime Layout

**[2.1, B13]** Two repositories, one package of rules.

```
 Nexora-Saas (web repository)                Nexora-Backend (server repository)
 ┌──────────────────────────┐   HTTPS,       ┌──────────────────────────────┐     ┌────────────────────────────┐
 │ Next.js application      │   same origin, │ apps/server                  │────▶│ PostgreSQL                 │
 │ (existing screens,       │──────────────▶ │ HTTP adapter, modules,       │     │ identity, tenant, platform,│
 │  API modules)            │   cookies      │ worker, migrations           │     │ ops, audit, archive        │
 └────────────┬─────────────┘                └──────────────┬───────────────┘     └────────────────────────────┘
              │ imports (published package)                 │ imports
              ▼                                              ▼                    ┌────────────────────────────┐
        ┌──────────────────────────────────────────────────────────┐              │ Object storage             │
        │ packages/core (in Nexora-Backend): pure rules, types,    │              │ S3-compatible, private     │
        │ money, error codes                                       │              └────────────────────────────┘
        └──────────────────────────────────────────────────────────┘              E-mail service (via outbox)
```

_Figure 1: Repository and runtime layout. The same server image runs as the web process and as the worker process._

- **`packages/core`** holds the rules of Table 9, the shared types, the money functions and the error codes. It has no dependency on React, Next.js, Node-only APIs or storage, so both the web application and the server import it. **[2.1]** It lives in the server repository and is published as a versioned package that the web application depends on. Until the web application switches to the package, a CI check compares the rule files of both repositories and fails when they differ.
- **`apps/server`** holds the modules, the database migrations, the composition root and two entry points: web (HTTP) and worker (jobs and scheduler). Both are the same Docker image started with a different command.
- **The web application** (`Nexora-Saas`) keeps its API modules; in demonstration mode they read the browser store, in server mode they call the server. **[2.1, D1]** It reaches the server on its own origin through `API_PROXY_TARGET`, so cookies stay first-party.

### 5.2 Layers Inside a Module

Each business module follows the hexagonal layering of the Architecture repository, scoped to the module.

```
HTTP adapter: route, schema validation (Zod), principal from session, error codes
        │
Application: commands and queries, permission and record rules, unit of work, audit, outbox
        │
Domain: entities, state machines, invariants, rules from packages/core
        │
Ports: repositories, clock, id generator, storage, mailer, payment provider
        ▲ implements
Infrastructure: Postgres repositories, S3 storage, e-mail adapter, job handlers
```

_Figure 2: Layers of one module. Arrows point from a layer to what it may depend on._

### 5.3 Modules

**Table 11: Server modules, the data they own and their dependencies.**

| Module | Owns | Uses |
|---|---|---|
| identity | users, portal users, sessions, second factors, **[2.1]** passcodes, invitations, sign-in tokens | – |
| workspace | workspaces, memberships, roles, settings, approval rules, holidays, custom fields, sequences, subscription state seen by the tenant | identity |
| people | departments, employees, rate history, employee documents, leave, reviews, payroll inputs | workspace |
| relations | clients, contacts, rate cards, contracts, notes, deals, portal access, satisfaction, **[2.1]** follow-ups, sales stages, client history, import runs, shared list views | workspace, people |
| work | projects, templates, milestones, tasks, comments, activity, change orders, resource bookings, **[2.1]** task states, assignees, watchers, links and relations, task views, client requests, cycles, project pages | relations, people |
| time | time entries, timers | work, people |
| approvals | approval requests and decisions for time, expenses, leave, quotes, invoices, bills | people, workspace |
| sales | quotes, client invoices, lines, payments, allocations, reminders, recurring schedules, deliveries | relations, work, time |
| purchases | suppliers, supplier bills, bill payments, expenses | people, work |
| finance | bank statements and lines, mappings, journal exports, VAT periods, e-invoice files, exchange rates, period locks | sales, purchases |
| analytics | KPI and profitability summaries, saved reports, inbox | all, read only |
| files | file objects, links to records | – |
| notifications | outbox, e-mail messages, templates, in-app notices | – |
| platform | customers, plans, subscriptions, Nexora invoices, payments, dunning, staff, support, incidents, data requests, configuration | identity; tenant data only through support sessions |
| ops | jobs, schedules, idempotency keys, audit trails | – |

### 5.4 Communication Between Modules

1. A module calls another module only through that module's application interface (exported commands and queries), never through its tables or repositories.
2. A change that must happen in the same instant (issuing an invoice marks its hours as invoiced) is one command of the owning module that calls the other module's command inside the same unit of work.
3. A follow-up that may happen later (send the invoice e-mail, refresh a KPI summary) is written to the outbox in the same transaction and handled by the worker after commit.
4. No module reads another module's tables in SQL, except the analytics module, which reads through read-only views created for it.

### 5.5 Request Lifecycle

Every request to the server goes through the same chain, in this order. A route that skips a step fails the architecture test (TEN-07).

1. Request identifier, body size limit, security headers, rate limits.
2. Authentication: the session cookie of the realm the route belongs to; a cookie of another realm is refused. **[2.1, D1]** For a state-changing request, the `X-XSRF-TOKEN` header must match the token cookie and the `Origin` header must be the application's origin.
3. Liveness: the account and the session are loaded from the database and must be active.
4. Tenant resolution (member and portal realms): **[2.1, B11]** the workspace named in the path (`/app/v1/workspaces/:wid/…`), accepted only if the person holds an active membership in it (refused with 403 and an audit event otherwise); routes without a workspace in the path use the session's active membership; the workspace must not be suspended or deleted.
5. Validation of the input against its schema; unknown fields are rejected.
6. Permission check of the command or query (AUZ).
7. Unit of work: a transaction opens, the workspace and principal are set for row-level security, record rules run, the domain changes, audit and outbox rows are written, and the transaction commits.
8. Response shaped per role; errors returned as codes with values.

### 5.6 Technology Decisions

**Table 12: Technology decision log.**

| Need | Choice | Why | Alternative not taken |
|---|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript strict | The rules are TypeScript; one language for one developer | Go or Java: rewrite the rules |
| HTTP | Express 4, kept from the Architecture repository | Tested middleware chain already exists | NestJS: more framework than needed |
| Database access | `pg` with a typed query builder (Kysely) and hand-written SQL migrations | Full control of transactions, locks and session variables for row-level security; types without an ORM | Prisma: weak control of `SET LOCAL`, locks and SQL features |
| Validation | Zod | Already used by both repositories | – |
| Jobs | Postgres table with `SKIP LOCKED`, kept design | No extra infrastructure; jobs commit with business data | Redis with BullMQ: a second store to run and back up |
| Rate limits | Postgres counters; Redis when present | Works without Redis | – |
| Passwords | Argon2id | Current OWASP recommendation | bcrypt: kept only to upgrade old hashes |
| Files | S3-compatible storage (MinIO locally) | Kept port; cheap, durable | Database blobs: bloats backups |
| Tests | Vitest; real Postgres in containers for integration | Same runner as the rules; real constraints tested | Mocked database: misses constraint bugs |

### 5.7 Architecture Requirements

**Table 13: Architecture requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| ARC-01 | **[2.1, B13]** The server repository holds the server and `packages/core`; it builds and tests from its root. The web application consumes `packages/core` as a versioned package | M | A clean clone of the server repository builds the server and runs all its tests with one command; a CI check fails when the rule files of the two repositories differ |
| ARC-02 | The server is organised by module; each module has domain, application, ports and infrastructure folders | M | An architecture test fails if a domain file imports infrastructure, Express, `pg` or another module's internals |
| ARC-03 | The rules of Table 9 move to `packages/core` without behaviour change and keep their tests | M | The moved tests pass unchanged; the web application imports them from the package |
| ARC-04 | Only `config/` reads environment variables; boot fails on a missing, default or short secret in production | M | Starting production with a missing session secret exits with a clear message |
| ARC-05 | The same image starts as web or worker; the worker runs jobs and the scheduler; the web process never runs jobs | M | Stopping the worker leaves the web application working and jobs queued |
| ARC-06 | Modules communicate only through application interfaces and the outbox (Section 5.4) | M | An architecture test lists cross-module imports; only application interfaces appear |
| ARC-07 | **[2.1, B4]** Every route belongs to one realm prefix: `/app` (members, workspace records under `/app/v1/workspaces/:wid`), `/portal` (client contacts), `/platform` (staff, console host only), `/health` | M | A request with a cookie of another realm receives 401 on every route of the matrix test |
| ARC-08 | **[2.1, B5]** Errors are returned as stable codes with values, never as sentences; the code returned is the front end's catalogue key (Annex F) | M | A guard test lists every code thrown by the server and finds each in the catalogue |
| ARC-09 | The internal interface is versioned (`/app/v1`, `/portal/v1`, `/platform/v1`) so that a public API can be added later without changing the modules | S | The route table contains no unversioned business route |
| ARC-10 | External services (e-mail, storage, payment provider, DGI, clock, random) are behind ports with a fake for tests | M | The full test suite runs offline |
| ARC-11 | No new infrastructure component (cache, broker, search engine) is added without a measured need recorded in the decision log | S | The decision log lists the measurement for every component |

---

## 6. Database Design Rules

The database is the last line of defence for every rule that must never break. It is designed so that a bug in the server, a missed check in a new endpoint or a hand-written query cannot store a record that violates the rules below.

### 6.1 Engine, Schemas and Roles

One PostgreSQL 16 database holds six schemas. Separate schemas let the database itself refuse the console access to company data (rule SEC-02 of the console specification), instead of relying on the code.

**Table 14: Database schemas.**

| Schema | Content | Row-level security |
|---|---|---|
| `identity` | Principals, member and portal accounts, sessions, second factors, **[2.1]** passcodes, sign-in and invitation tokens | On portal accounts, by workspace |
| `tenant` | Every business table of the companies (Section 7) | On every table, forced, by workspace |
| `platform` | Console tables: customers, plans, subscriptions, Nexora invoices, payments, staff, support, incidents, data requests | None needed: tenant roles have no privilege on it |
| `ops` | Jobs, schedules, outbox, idempotency keys, number sequences, rate-limit counters | On tenant-bound rows, by workspace |
| `audit` | Workspace, identity and console audit events; seals | On workspace events; no role can update; only the retention function deletes, after 5 years; each realm reads only its own trail |
| `archive` | Accounting records kept after a workspace is deleted (Section 19) | No tenant or platform role has any privilege; only `nx_dataops` |

**Table 15: Database roles and privileges. No application role has `BYPASSRLS`.**

| Role | Used by | Privileges |
|---|---|---|
| `nx_owner` | Migrations only | Owns all objects; never used by a running process |
| `nx_app` | Web process for member requests; worker for tenant jobs | Read and write on `tenant` and on tenant rows of `ops` under row-level security, and on member-realm rows of `identity`; insert and read on `audit.workspace_events`; insert on `audit.identity_events` and read of the caller's own rows; insert on `audit.seals` for workspace and identity seals; read on the view `platform.workspace_access`; execute on the crossing functions of Section 6.2 |
| `nx_portal` | Web process for portal requests | Read on portal views of `tenant`; update of the decision columns only of quotes, milestones and change orders; insert of survey answers **[2.1]** and of client requests; insert on `audit.workspace_events`, `audit.identity_events` and `ops.outbox`; read and write on portal-realm rows of `identity`; policies also filter by client |
| `nx_platform` | Web process for console requests; worker for platform jobs | Read and write on `platform`, on staff-realm rows of `identity` and on platform rows of `ops` (jobs, outbox, idempotency keys, NX number sequences); insert and read on `audit.console_events`, on staff-realm rows of `audit.identity_events`, and on console seals; read on the seat-usage view; no privilege on `tenant` |
| `nx_support` | Requests made inside an approved support session | Read only on `tenant`, through a policy that requires a row of the view `platform.active_support_sessions` for that workspace and agent (SEC-10); insert on both audit trails; no write in this release (OD-8) |
| `nx_dataops` | Tenant export and deletion jobs | Read and delete on `tenant` for one workspace at a time; insert into `archive`, and read on it for legal requests; insert on `audit.workspace_events`, so that every run is audited |
| `nx_provision` | Nobody: it cannot sign in (`NOLOGIN`) | Owns the crossing functions of Section 6.2, with the few privileges they need on both sides |
| `nx_readonly` | Restore tests and reconciliation checks | Read only, under row-level security |

### 6.2 Crossing Points Between Tenant and Platform

The tenant roles and the console role cannot reach each other's tables. The few actions that must touch both sides go through `SECURITY DEFINER` functions owned by `nx_provision`, each with a fixed `search_path`, checked inputs, one purpose and its own audit event. They are the only grants that cross the line:

- **`provision_workspace`**: trial creation from the console (PLF-02) and self sign-up (Section 8). In one transaction it creates the platform customer, workspace reference and trial subscription, and the tenant workspace, default roles, settings, owner account and owner membership. Executable by `nx_platform` and `nx_app`.
- **`choose_plan` and `record_payment_intent`**: a company owner chooses a plan or pays a Nexora invoice from the workspace, including in the read-only state (Table 31). Executable by `nx_app`.
- **`decide_support_session`**: a company administrator approves or refuses a support session (PLF-13). Executable by `nx_app`.
- **Read side**: the view `platform.workspace_access` (access state, plan, plan features, seat limit) is readable by `nx_app`; the view `platform.seat_usage` (invited and active memberships per workspace) by `nx_platform`; the view `platform.active_support_sessions` by `nx_support`.

### 6.3 Naming and Types

- **Names.** Tables in plural snake case (`client_invoices`); columns in snake case; foreign keys named after the table they reference (`client_id`); amounts end with `_minor`; dates are `date`, instants end with `_at`.
- **Identifiers.** `uuid`, version 7 (time-ordered) generated by the server, so inserts stay index-friendly and identifiers never reveal counts.
- **Instants.** `timestamptz` stored in UTC. Business dates (a time entry's day, an invoice's issue date, a leave day) are `date`, interpreted in the workspace time zone; "today" is computed in that time zone.
- **Money.** `bigint` amounts in minor units (centimes) with a `char(3)` ISO currency on the record. Totals are stored next to the lines they come from and checked against them. **[2.1, B6]** On the wire, amounts travel in major units with two decimals (see DAT-05).
- **Rates and quantities.** VAT and withholding rates `numeric(5,2)`; exchange rates `numeric(18,6)` (BIL-7); hours `numeric(6,2)` in quarter-hour steps (TIM-1); quantities `numeric(12,3)`; hourly rates `bigint` minor units per hour.
- **Statuses.** `text` with a `CHECK` listing the allowed values; transitions are enforced by the domain and, for money documents, by triggers.
- **E-mail addresses.** `citext`, unique where the realm requires it.
- **Free structure.** `jsonb` only for data that is genuinely open: custom field values, audit before and after, job payloads, user-interface preferences **[2.1]** (saved view state, repeat rules). Never for amounts, statuses, dates or foreign keys.

### 6.4 Common Columns and Principals

Every tenant table carries `id`, `workspace_id`, `created_at`, `created_by`, `updated_at`, `updated_by` and `version`. Actor columns reference `identity.principals`, one row per member, portal contact, staff member or system job, so that every "who did it" points to one table whatever the realm.

### 6.5 Keys and Integrity

1. **Composite tenant keys.** Every tenant table has `UNIQUE (workspace_id, id)`; every foreign key between tenant tables includes `workspace_id`. An invoice therefore cannot reference a client, project or time entry of another workspace, even through a bug.
2. **Natural uniqueness.** Invoice numbers are unique per workspace; client codes and project codes are unique per workspace; one membership per person and workspace; one portal access per contact; **[2.1]** task numbers are unique per project; one primary contact per client.
3. **Checks.** Amounts and hours have sign and range checks; a time entry's hours are positive, at most 24 and a multiple of 0.25; an approver differs from the submitter and the subject (`submitted_by` and `subject_principal`, stored on every approvable record and decision row); a document's due date is on or after its issue date.
4. **Exclusion constraints** (extension `btree_gist`). No two pending or approved leave requests of one person overlap; no two active bookings of one person on one project overlap; **[2.1]** no two cycles of one project overlap.
5. **Partial unique indexes.** One running timer per person; one active subscription per customer; one open bank-import mapping per bank account format; **[2.1]** one next task per repeating task; one project per won deal.
6. **Frozen rows.** Triggers reject updates and deletes of issued invoices and credit notes, payments, filed VAT periods, journal exports, close snapshots and audit events **[2.1]** and client history rows, except the columns of Table 16. Deletes are allowed only in two functions: the archive step of the workspace deletion job (RET-02) and the retention function, after the periods of Table 61 (TRL-06); both are audited.

**Table 16: Columns that stay writable on frozen records. Every other column is refused by the trigger.**

| Record | Writable columns and condition |
|---|---|
| Issued invoice, credit note | `status`, only along Annex B; `sent_at`; `paid_at`; `voided_at` and `void_reason`, on void only; PDF and UBL file keys and hashes, written once from null; e-invoice status, reference and reason |
| Payment | None; a correction is a new reversing row (SAL-32) |
| Approved or invoiced time entry, approved expense | `status`, only along Annex B (invoiced, released, reopened when not invoiced and the period is open); `reimbursed_at` and `reimbursed_by` of an expense, on reimbursement only |
| Filed VAT period | `status`, back to open only by an owner with a fresh second factor and a reason |
| Journal export, close snapshot, audit event, **[2.1]** client history row, closed cycle summary | None |

### 6.6 Row-Level Security

Every table of the `tenant` schema has row-level security enabled and forced. The policy compares `workspace_id` with the session setting `app.workspace_id`, which the unit of work sets with `SET LOCAL` at the start of each transaction. When the setting is missing, no row is visible and no row can be written. The portal role's policies also compare `client_id` with `app.client_id`. Row-level security is a second barrier: the server still scopes every query explicitly, and the tenancy tests check both.

### 6.7 Indexes and Performance Rules

- Every foreign key is indexed, with `workspace_id` as the first column.
- List screens have a matching index on (`workspace_id`, filter columns, sort column); pagination uses keyset cursors, never large offsets.
- Partial indexes serve the hot sets: open invoices, submitted time entries, pending approvals, queued jobs **[2.1]**, open follow-ups, deleted clients and tasks waiting in a bin, client requests waiting for a decision.
- Audit tables use BRIN indexes on time and B-tree indexes on (`workspace_id`, target).
- Text search on names (clients, projects, employees **[2.1]**, contacts, tasks, project pages) uses `pg_trgm` indexes.
- Queries slower than 200 ms are logged with their plan in staging.

### 6.8 Migrations and Seed Data

Migrations are numbered SQL files, applied forward only, recorded with a checksum in `ops.schema_migrations`. They run as a separate step of each deployment under `nx_owner`, holding an advisory lock so two instances never migrate at once. Changes that would break the running version use expand and contract: add the new column, deploy code that writes both, backfill, switch reads, then drop the old one in a later release. Demonstration data is loaded by a seed command into workspaces flagged `is_demo`, never into real ones.

### 6.9 Database Requirements

**Table 17: Database requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| DAT-01 | PostgreSQL is the only store for business data, sessions, jobs, outbox, idempotency and audit; no SQLite or file store remains | M | A code search finds no SQLite import; stopping Postgres stops every write path |
| DAT-02 | The six schemas and the roles of Table 15 exist; no application role owns objects or bypasses row-level security | M | A privilege test connects as each role and checks the allowed and refused operations of the table |
| DAT-03 | Identifiers are UUID v7 generated by the server | M | Two records created one after the other have increasing identifiers |
| DAT-04 | Instants are `timestamptz` in UTC; business dates are `date` interpreted in the workspace time zone | M | A time entry logged at 00:30 Casablanca time on 1 November 2026 (23:30 UTC on 31 October) is dated 1 November |
| DAT-05 | Amounts are `bigint` minor units with a currency on the record; no `float`, `real` or `double` column exists. **[2.1, B6]** The HTTP adapter converts them to major units with two decimals in JSON and back, with the half-up rule of `packages/core/money` | M | A schema test finds no floating-point column; a property test converts 10,000 random amounts to JSON and back without a centime of difference |
| DAT-06 | All rounding uses the half-up rule of `packages/core/money`; totals are rounded once, at the level the rules define (line, rate group, document) | M | Property test: for 10,000 random invoices, stored totals equal totals recomputed from lines to the centime |
| DAT-07 | Statuses are checked values; status changes follow the state machines of Annex B | M | Writing a status outside the list fails at the database; skipping a transition fails in the domain |
| DAT-08 | Every tenant table has `workspace_id`, `UNIQUE (workspace_id, id)` and composite foreign keys | M | A schema test lists tenant tables without the column or with a single-column foreign key to another tenant table: the list is empty |
| DAT-09 | Row-level security is enabled and forced on every tenant table; without `app.workspace_id` no row is visible | M | Connected as `nx_app` without the setting, `SELECT count(*)` returns 0 on every tenant table |
| DAT-10 | Every tenant table has the common columns and actor references to `identity.principals` | M | Schema test passes; an update without `updated_by` is refused |
| DAT-11 | Editable records carry a version incremented on every update | M | Two updates based on the same version: the second fails with `CONFLICT_STALE_VERSION` |
| DAT-12 | Frozen-row triggers protect the records of Table 16 and allow only the columns it lists | M | An `UPDATE` of an issued invoice's total as `nx_app` fails with a trigger error |
| DAT-13 | Overlap and uniqueness rules of Section 6.5 are database constraints | M | Inserting an overlapping approved leave fails at the database, not only in the domain |
| DAT-14 | Migrations are forward-only, checksummed, applied under an advisory lock as a deployment step | M | Editing an applied migration makes the next deployment stop with a checksum error |
| DAT-15 | Each migration is tested on an empty database and on a seeded copy before release | M | The CI job applies all migrations to both and runs the test suite |
| DAT-16 | Lists use keyset pagination and indexes matching their filters | S | No list endpoint uses `OFFSET` above 1,000 in the query log |
| DAT-17 | Demonstration data is loaded only into workspaces flagged `is_demo` | M | The seed command refuses a workspace without the flag |
| DAT-18 | The database is restorable to any point in the last 7 days (write-ahead log archiving) | S | A restore to a chosen minute is carried out and timed in the monthly test |
| DAT-19 | Tenant and platform roles cross only through the functions of Section 6.2; each is `SECURITY DEFINER` with a fixed `search_path`, owned by `nx_provision`, and audited | M | Privilege test: `nx_app` cannot insert into any platform table and `nx_platform` into any tenant table; `provision_workspace` interrupted at its last step leaves nothing |

---

## 7. Data Model

This section lists every table of the database, grouped by module, with the columns that carry meaning and the rules the table enforces. The common columns of Section 6.4 (identifier, workspace, created and updated by and at, version) are not repeated. The exact column list, types and indexes are produced in the first migration from this catalogue and reviewed against it. **[2.1]** Tables and columns added in version 2.1 are marked **new** or **[2.1]**.

```
employees ──by──▶ time_entries ──on──▶ projects ◀── milestones, tasks
employee_rates                              │
                 invoice_line_time_entries  │for
                          │                 ▼
                 client_invoice_lines ──▶ client_invoices ──to──▶ clients ◀── client_contacts
                                               ▲      ┊ numbered by
                                       settles │      ┊
bank_lines ──from──▶ payments ──▶ payment_allocations  ┊
                                                ops.document_sequences
```

_Figure 3: The core chain from an hour worked to a payment received. Every solid arrow is a composite foreign key that includes the workspace; the dotted arrow is the numbering lock of Section 15.2._

### 7.1 Identity

**Table 18: Schema `identity`.**

| Table | Main columns | Rules |
|---|---|---|
| `principals` | kind (member, portal, staff, system), reference, display name | One row per account or job; target of every actor column |
| `users` | e-mail (`citext`, unique), name, password hash, status, failed attempts, locked until, e-mail verified at, locale | Global identity of a member; no workspace column; never hard-deleted while memberships exist |
| `portal_users` | workspace, client, contact, e-mail, status (invited, active, expired, revoked), invited at, activated at, last seen at | One per contact; set to expired by a job after the workspace's inactivity days (CRM-12) |
| `sessions` | principal, realm, created at, last activity at, idle and absolute expiry, revoked at and reason, IP, user agent, country | Limits per realm (Table 6); revocable one by one or all |
| `refresh_tokens` | session, token hash (SHA-256), expires at, revoked at, replaced by | Rotation; reuse of a replaced token revokes the whole session |
| `second_factors` | principal, kind (TOTP), encrypted secret, enabled at, hashed recovery codes | Secret encrypted at application level (SCR-07) |
| **new** `passcodes` **[2.1]** | user, passcode hash (Argon2id), set at, failed attempts, locked until | One per user; 4 to 8 digits; rate-limited like a password (IAM-18) |
| `sign_in_tokens` | e-mail or principal, purpose (verify, reset, e-mail change, second-factor reset, invite, portal link, staff invite), token hash, expires at, used at, context | Single use; hashed; 15 min for portal links; 24 h for verify, reset, e-mail change and second-factor reset; 7 days for member invitations; 72 h for staff invitations |

### 7.2 Workspace and Settings

**Table 19: Schema `tenant`: workspace.**

| Table | Main columns | Rules |
|---|---|---|
| `workspaces` | name, slug, country, base currency, time zone, locale, `is_demo`, deleted at | One per company workspace; its access state (trial, read-only, suspended) is read from the platform view |
| `memberships` | user, role, owner flag, employee (optional), status (invited, active, disabled), invited at, activated at, last seen at | Unique per user and workspace; unique per employee; an owner holds the administrator role; at least one active owner (trigger) |
| `roles` | key, name, `is_default`, status | Four default member roles seeded (administrator, manager, accountant, employee); custom roles allowed; the portal contact's rights are fixed by the portal realm, not stored here |
| `role_permissions` | role, permission | Permission values from the catalogue only (check) |
| `company_settings` | legal and trade name, ICE, IF, RC, patente, CNSS number, VAT regime and period, address, fiscal-year start month, week start, numbering formats, document style, bank details, invoice footer, brand colour, logo file, lock date, receipt threshold, portal inactivity days, reminder settings, automatic issue of recurring drafts, **[2.1]** `stale_days` for deals, auto-archive of done tasks | One row per workspace; identifier formats checked for Moroccan companies (`tax-ids.ts`); lock date can only move forward except by an owner with a reason |
| `approval_rules` | subject (timesheet, leave, expense, quote, invoice, bill), mode (none, one step, two steps), second-step threshold | One per subject; threshold only for amount subjects |
| `leave_type_settings` | type, enabled, yearly days, carry-over maximum | One per type |
| `expense_category_settings` | category, enabled | – |
| `holidays` | date, name | Unique per date; religious dates editable (HR-4) |
| `task_labels`, `overhead_items` | name; monthly amount for overheads | – |
| `custom_field_defs` | entity (client, project, employee), label, type, options, required | Values stored in the record's custom fields; removed fields keep their values (PLT-12) |
| `kpi_settings` | KPI key, target, visibility (self, manager, everyone) | One per KPI |
| `gl_accounts` | account key, number | Number 4 to 8 digits (CGNC); defaults from `journal.ts` |

### 7.3 People and HR

**Table 20: Schema `tenant`: people.**

| Table | Main columns | Rules |
|---|---|---|
| `departments` | name | Unique name per workspace |
| `employees` | name, e-mail, phone, job title, department, manager, employment type, status, hire date, end date, weekly capacity, working days, skills, encrypted CIN and CNSS number, gross monthly salary, custom fields | Manager chain without cycles (trigger); an inactive employee keeps history and gets no new work (HR-5) |
| `employee_rates` | effective from, hourly cost, billable rate, reason | Unique per employee and date; rates in force on a date come from here (HR-3, FBR-4) |
| `employee_documents` | kind, title, contract type, start, expiry, file, notes, sensitive flag | Medical documents flagged sensitive (Table 8) |
| `leave_requests` | employee, type, start, end, half day, counted days, note, status, submitted by, subject principal, steps required, decision note, first approver, approver, decided at | No overlap of pending or approved requests (exclusion constraint); balance checked on submit and approve |
| `leave_adjustments` | employee, year, type, days, reason | Carry-over and manual corrections; append-only |
| `performance_reviews` | employee, reviewer, period, from, to, status, self part, manager part, KPI snapshot, acknowledged at | Self part only by the employee; manager part only by the reviewer (HR-9) |
| `payroll_runs` | month, status (draft, final), generated at, file | One final run per month; final runs frozen |
| `payroll_lines` | employee, worked hours, leave days by type, reimbursed expenses, gross salary, employer cost | Computed by `payroll.ts` and `employer-cost.ts` |

### 7.4 Clients, CRM and Portal

**Table 21: Schema `tenant`: relations.** **[2.1: 5 new tables, 14 new columns]**

| Table | Main columns | Rules |
|---|---|---|
| `clients` | code, name, legal name, client type, ICE, IF, country, industry, e-mail, phone, website, address, billing address, currency, language, status **[2.1]** (lead, active, archived), hourly rate, payment terms, account manager, credit limit, reminders off, notes, custom fields, **[2.1]** `lead_source`, `tags text[]`, `converted_at`, `lost_reason`, `deleted_at`, `deleted_by` | ICE required for business clients in Morocco before an invoice is issued; code unique; **[2.1]** website http/https only; `converted_at` set once; a deleted client is hidden from every list and purged after 30 days (REL-17) |
| `client_contacts` | client, name, e-mail, phone, job title, billing flag, primary flag, **[2.1]** `other_emails text[]`, `other_phones text[]`, `linkedin`, `role` | At most one primary contact per client; **[2.1]** `linkedin` http/https only |
| `client_rate_cards` | client, job title or employee, rate | Overrides the employee's rate for this client (FBR-4) |
| `client_contracts` | client, title, type, start, end, value, currency, renewal date, file | End on or after start |
| `client_notes` | client, kind (note, meeting, call), date, text, author, **[2.1]** `mention_ids uuid[]` | **[2.1]** Mentions resolve to employees of the workspace, never the author (REL-20) |
| **new** `client_follow_ups` **[2.1]** | client, title, due date, owner, contact, deal, status (to do, in progress, done), note, done at, done by | Owner is an active employee; done stamps who and when (REL-13) |
| **new** `pipeline_stages` **[2.1]** | key, name, probability, position, kind (open, won, lost) | At most 10 open stages plus one won and one lost; key unique per workspace (REL-14) |
| `deals` | title, client, amount, currency, stage, probability, expected close, owner, quote, lost reason, closed at, **[2.1]** `stage_since`, `contact_id`, `project_id` | Lost needs a reason; won or lost sets closed at; **[2.1]** stage from `pipeline_stages`; `stage_since` set by the server on every stage change; `project_id` unique (REL-15) |
| **new** `client_history` **[2.1]** | client, kind (created, updated, deleted, restored, merged), field, before, after, note, actor, at | Append-only: insert and read only, frozen-row trigger (REL-16) |
| **new** `import_runs` **[2.1]** | kind (clients, contacts, deals), file SHA-256, rows read, created, updated, skipped, errors (`jsonb` per row), actor, at | One row per import; never updated (REL-21) |
| **new** `table_views` **[2.1]** | list key, name, state (`jsonb`: filters, sort, columns, grouping), owner, shared | Name unique per owner and list; only the owner or an administrator removes it (REL-22) |
| `satisfaction_responses` | client, project, milestone, rating (1–5), NPS (0–10), comment, respondent, answered at | One answer per survey link |

### 7.5 Projects and Planning

**Table 22: Schema `tenant`: work.** **[2.1: 9 new tables, 9 new columns]**

| Table | Main columns | Rules |
|---|---|---|
| `projects` | code, name, description, client, manager, status, priority, start, due, budget type, budget amount, retainer amount, included hours and overage rate, recognition method, health override with reason, closed at and by, custom fields, **[2.1]** `cycles_enabled` | Code unique; retainer fields only for retainer projects; closed projects frozen (PRJ-13); **[2.1]** a project with history cannot be deleted (WRK-22) |
| `project_members` | project, employee | Members may log time on the project |
| `project_close_snapshots` | revenue, labour cost, expenses, overhead, profit, margin, hours, currency, closed by and at | Written once at closing; never updated |
| `project_templates` | name, description, budget type, duration, definition (milestones and tasks with offsets and dependencies) | Definition validated: offsets in range, dependencies inside the template, no cycle |
| **new** `project_task_states` **[2.1]** | project, name, group (to do, in progress, review, done, cancelled), colour, position | Name unique per project; each group keeps at least one state; deleting a used state moves its tasks to another state of the same group (WRK-15) |
| `milestones` | project, title, due date, requires approval, budget hours and amount, revenue share, approved at, rejected at, decision comment, decided by | Revenue shares of a project total 100 when set |
| `tasks` | project, milestone, title, description, status, priority, assignee, start, due, estimated hours, position, completed at, labels, **[2.1]** `number`, `state_id`, `cycle_id`, `repeat jsonb`, `next_task_id`, `deleted_at`, `deleted_by` | Assignee must be a project member; **[2.1]** number unique per project and never reused (WRK-12); `status` follows the group of `state_id`; `next_task_id` unique (WRK-19); deleted tasks wait 30 days in the bin (WRK-20) |
| **new** `task_assignees` **[2.1]** | task, employee | Collaborators besides the main assignee; project members only (WRK-13) |
| **new** `task_watchers` **[2.1]** | task, employee | Project members only; unique per task and employee |
| **new** `task_links` **[2.1]** | task, title, url | `url` http/https only (WRK-14) |
| **new** `task_relations` **[2.1]** | task, related task, kind (waits for, duplicate of, related) | Same workspace; not to itself; read from both sides (WRK-14) |
| `task_dependencies` | task, depends on | Same project; no cycle (PRJ-6) |
| `subtasks`, `task_comments` | title and done; body and **[2.1]** `mention_ids` | Mentions resolve to employees; **[2.1]** each creates a notice (WRK-05) |
| `task_activity` | task, actor, kind, from, to | Append-only history (PRJ-7) |
| **new** `task_views` **[2.1]** | project, owner, name, shared, tab (board, list, table, calendar), filters, grouping (`jsonb`) | Shared views visible to project members only (WRK-16) |
| **new** `client_requests` **[2.1]** | number, client, project, kind (bug, change, question, other), title, body, urgent, status (new, accepted, rejected, duplicate, snoozed), snoozed until, reason, duplicate of, task, change order, sent by (member or portal contact), decided at and by | Number unique per workspace; accepting links exactly one task or one draft change order (WRK-17) |
| **new** `cycles` **[2.1]** | project, number, name, start, end, goal, closed at, closed by, summary (`jsonb`, frozen) | 1 day to 4 weeks; no overlap per project (exclusion constraint); summary frozen once closed (WRK-18) |
| **new** `project_pages` **[2.1]** | project, kind (page, meeting), title, body, meeting date, attendees, pinned, updated by | Action items converted to tasks keep a link to their task (WRK-21) |
| `change_orders` | project, milestone, number, title, description, amount (signed), hours (signed), status, sent, decided at and by (member or portal contact), rejection reason, **[2.1]** client request | Number unique per project; approved orders change the budget |
| `resource_bookings` | project, employee or role title, start, end, hours per week, tentative, note | End on or after start; hours per week between 0.25 and 80 |

### 7.6 Time and Approvals

**Table 23: Schema `tenant`: time and approvals.**

| Table | Main columns | Rules |
|---|---|---|
| `time_entries` | employee, project, task, date, hours, note, billable, status, rejection reason, submitted by, subject principal, submitted at, steps required, approved at, approver, first approver, bill rate, cost rate | Hours positive, at most 24, quarter steps; billable false on non-billable projects; rates set at approval and frozen; on an issued invoice the entry is frozen |
| `timers` | employee, project, task, note, started at, stopped at | One running timer per employee (partial unique index) |
| `approval_decisions` | subject type, subject, step (1 or 2), decision (approve, reject, reopen), approver, submitted by, subject principal, reason, decided at | Append-only; approver differs from `submitted_by` and `subject_principal` (check); at step 2 the approver differs from the step-1 approver |

### 7.7 Sales and Receivables

**Table 24: Schema `tenant`: sales.**

| Table | Main columns | Rules |
|---|---|---|
| `quotes` | number, client, contact, currency, issue date, valid until, delivery date, subject, tax rate, discount rate, notes, status, submitted by, subject principal, steps required, approver, approved at, sent at, decided at and by, decline reason, invoice, project, subtotal, discount, tax, total | **[2.1, B7]** Number null in draft, taken from the quote series when the quote is sent; accepted quotes frozen |
| `quote_lines` | position, description, quantity, unit, unit price, tax rate | Totals recomputed from lines |
| `client_invoices` | series, fiscal year, number, kind, client, currency, exchange rate and date, issue date, due date, status, subject, notes, default tax rate, withholding rate, corrected invoice (credit notes), quote, recurring schedule, retainer period, submitted by, subject principal, steps required, approver, approved at, issued at and by, sent at, paid at, voided at and reason, subtotal, tax, withholding, total, total in base currency, client and seller snapshots, PDF and UBL files with SHA-256, e-invoice status, reference and reason | Number null in draft, set once at issue; snapshot of both parties' identity at issue; frozen after issue except the columns of Table 16; one non-void retainer invoice per project and period (partial unique index) |
| `client_invoice_lines` | position, description, quantity, unit, unit price, tax rate, line total, project, budget line, deducted advance invoice | Frozen with the invoice |
| `invoice_line_time_entries` | line, time entry, active | The only link between hours and invoices; partial unique index on (workspace, time entry) where active; void and credit with release clear active in the same transaction |
| `invoice_line_expenses` | line, expense, active | Same rule: an expense is on at most one active invoice line |
| `payments` | client, date, amount, currency, method, reference, bank line, recorded by, reverses payment, reason | Append-only; a correction is a new row reversing one payment (unique), with a reason |
| `payment_allocations` | payment, invoice, amount | Sum per payment at most the payment, the remainder being client credit; sum per invoice at most its total after credit notes |
| `invoice_reminders` | invoice, level (1–3), sent to, sent at | One per level and invoice (BIL-15) |
| `invoice_deliveries` | invoice, recipient, sent at, message | Every e-mail of an invoice (BIL-11) |
| `recurring_invoices` | client, project, title, frequency, start, next run, end, tax rate, notes, active | Next run advanced in the same transaction as the generated draft |
| `recurring_lines` | position, description, quantity, unit, unit price | – |
| `recurring_runs` | schedule, period start, generated invoice | Unique per schedule and period: a period is never generated twice |

### 7.8 Purchases and Expenses

**Table 25: Schema `tenant`: purchases.**

| Table | Main columns | Rules |
|---|---|---|
| `suppliers` | name, legal name, category, status, ICE, IF, country, e-mail, phone, address, payment terms, bank name, encrypted bank account, notes | ICE checked for Moroccan suppliers |
| `supplier_bills` | supplier, supplier's number, issue date, due date, project, milestone, tax rate, status, submitted by, subject principal, steps required, approver, rejection reason, file, notes, subtotal, tax, total | Unique per supplier and supplier's number (no double entry); approver differs from submitter |
| `supplier_bill_lines` | description, quantity, unit price, tax rate | Totals recomputed |
| `supplier_bill_payments` | bill, date, amount, method, reference | Sum at most the bill total; bill becomes paid when settled |
| `expenses` | employee, project, milestone, date, category, description, amount, VAT amount, currency, billable, receipt file, status, submitted by, subject principal, steps required, rejection reason, first approver, approver, reimbursed at and by | Receipt required above the workspace threshold (EXP-2); approver differs from employee |

### 7.9 Finance and Compliance

**Table 26: Schema `tenant`: finance.**

| Table | Main columns | Rules |
|---|---|---|
| `bank_accounts` | name, bank, RIB or IBAN, currency, ledger account | The company's own accounts |
| `bank_imports` | bank account, file, file SHA-256, imported by and at, lines read, lines skipped | The same file cannot be imported twice (unique hash) |
| `bank_lines` | import, bank account, date, amount, label, line key, status (unmatched, matched, ignored) | Unique per account and line key: a line is imported once even from overlapping statements |
| `bank_mappings` | header signature, column mapping | Remembers the columns of each bank's file format |
| `vat_periods` | period key, regime, collected, deductible, credit brought forward, payable, credit carried forward, status (open, filed), filed at and by | Filed periods frozen; computed by `vat.ts` |
| `journal_exports` | from, to, file, SHA-256, generated by and at | The journal is computed from frozen documents; each export is kept with its hash |
| `period_locks` | locked through, set by, reason | History of the lock date; the current value lives in settings |

### 7.10 Analytics, Files and Notifications

**Table 27: Schemas `tenant` and `ops`: read models, files and messages.**

| Table | Main columns | Rules |
|---|---|---|
| `kpi_daily` | employee, date, logged, billable and capacity hours, on-time tasks, estimate accuracy inputs | Refreshed by jobs from source tables; never edited |
| `project_financials` | project, as of, revenue, labour cost, expenses, overhead, profit, recognised revenue | Refreshed after each relevant change |
| `saved_reports` | owner, name, definition, shared | Definition validated against the report catalogue; **[2.1]** a client named in the definition follows a client merge (REL-18) |
| `files` | storage key, name, media type, size, SHA-256, sensitivity, scan status, uploaded by and at, retain until | Private objects; read through short signed links |
| `file_links` | file, record type, record, **[2.1]** `category` (contract, proposal, brief, invoice, other — client files only) | A file attached to a record of another workspace is refused (composite key) |
| `notifications` | recipient, kind, payload, read at, **[2.1]** source record type and id, dedupe key | In-app notices; **[2.1]** unique per recipient and dedupe key, so a job never creates the same notice twice (NTF-07) |
| `email_messages` | recipient, template, locale, payload, status, provider reference, attempts, sent at | Created from the outbox; never sent inside a business transaction |

### 7.11 Operations and Audit

**Table 28: Schemas `ops`, `audit` and `archive`.**

| Table | Main columns | Rules |
|---|---|---|
| `ops.document_sequences` | workspace (null for Nexora's own series), series, fiscal year, next value | Unique (workspace, series, fiscal year) with nulls not distinct; locked `FOR UPDATE` while a number is taken (TRX-03); **[2.1]** also holds the task series `task:<project>` and the request series `request` |
| `ops.idempotency_keys` | key, principal, workspace, route, request hash, response, created at, expires at | Same key and same request returns the stored response; same key and different request is refused |
| `ops.outbox` | aggregate type and id, event type, payload, status, attempts, last error, created at, published at | Written in the business transaction (TRX-05) |
| `ops.jobs` | type, payload, workspace, status, run at, attempts, maximum attempts, locked by and at, last error | Claimed with `FOR UPDATE SKIP LOCKED` (JOB-01) |
| `ops.schedules` | name, rule, time zone, last run, next run | One scheduler at a time (advisory lock) |
| `ops.rate_limits` | key, window, count | Fallback when Redis is absent |
| `audit.workspace_events` | workspace, at, actor, actor role, action, target type and id, before, after, reason, IP, user agent, request, session | Insert and read only (TRL-02); read under row-level security by owners and administrators |
| `audit.identity_events` | principal or hashed e-mail, realm, at, action (sign-in, failure, lockout, sign-out, second factor, reset, **[2.1]** passcode), IP, user agent | No workspace (none is known at sign-in); a person reads their own; staff read staff events |
| `audit.console_events` | at, staff, role, action, customer, target, before, after, reason, IP, session | Insert and read only; 5 years at least (AUD-06) |
| `audit.seals` | trail, workspace (if any), first and last event, events hash, previous seal hash, sealed at | Written every 5 minutes by the sealing job; verified daily (TRL-05) |
| `archive.records` | workspace, record type, original identifier, document date, frozen content, files with SHA-256, keep until | Written only by the deletion job; read only by `nx_dataops` on a legal request; removed at keep until |

### 7.12 Platform

The `platform` schema implements the nineteen entities of the console specification (Table 22 there): customers, workspace references, plans, plan versions, subscriptions, subscription changes, Nexora invoices, credit notes, payments, refunds, tax rates, dunning runs, staff, staff sessions, suspensions, support requests, support sessions, incidents and console audit events. This document adds the tables those requirements imply but did not name:

**Table 29: Additional platform tables.**

| Table | Main columns | Rules |
|---|---|---|
| `platform.nx_invoice_lines` | invoice, description, quantity, unit price, VAT rate, line total | Frozen with the invoice; VAT rounded per rate (BR-06) |
| `platform.settlements`, `reconciliation_runs`, `proformas` | Provider settlements, nightly reconciliation results, pro-forma invoices | Pro-formas never take a number of the NX series |
| `platform.two_person_approvals` | action, requested by, approved by, expires at, payload hash | Approver differs from requester; used for large refunds and customer deletion (SEC-05) |
| `platform.data_requests` | customer, kind (export, deletion), status, steps, due at, fulfilled at | Export within 7 days (AUD-04); deletion after retention (AUD-05) |
| `platform.retention_policy`, `announcements`, `feature_flags`, `seller_identity` | Retention periods, notices, flags, Nexora's legal identity | Changes audited |
| `platform.seat_usage` (view) | workspace, active and invited memberships | The only tenant-derived data the console reads (BR-01) |
| `platform.workspace_access` (view) | workspace, access state, read-only since, suspended since, plan, plan features, seat limit | The only platform data the tenant role reads (WSP-09, WSP-10) |
| `platform.active_support_sessions` (view) | workspace, agent, scope, expires at | Rows only for approved, unexpired sessions; read by `nx_support` policies |

---

## 8. Identity, Sign-in and Sessions

Identity answers one question for every request: who is acting. The answer comes only from a server-side session, never from a field of the request. The session design of the Architecture repository is kept (short access token, rotating refresh token stored hashed, reuse detection) and applied to the three realms of Table 6.

### 8.1 Flows

- **Company sign-up.** A new company is created by the platform (trial creation, CUS requirements) or by self sign-up when enabled. Both call the provisioning function of Section 6.2, which creates in one transaction the user, the workspace, the owner membership, the default roles and settings, and the platform customer and trial subscription.
- **Invitation of a member.** An administrator invites by e-mail with a role and, optionally, an employee record. The invitee sets a password through a single-use link valid 7 days; accepting activates the membership. An invitation takes a seat as soon as it is sent, as the seat-usage view counts it, and frees it when it expires or is withdrawn (BR-01).
- **Portal access.** A user with the client permission grants portal access to a client contact. The contact receives a sign-in link by e-mail; each sign-in sends a new single-use link (no password in version 1). Access expires after the workspace's inactivity days (default 90). **[2.1, B10]** The contact asks for a link on the sign-in page (`POST /portal/v1/auth/link`, always answered the same way so that it reveals no address) and opens it (`GET /portal/v1/auth/callback`).
- **Staff.** Staff are invited by an owner or admin of the console (STF requirements), must enrol a second factor before their first session, and sign in on the console host only.
- **Password reset and e-mail change.** Both use single-use links, revoke all other sessions, and notify the previous address.
- **[2.1] Lock screen.** A member may set a numeric passcode. After the idle limit the screen locks instead of signing out; the passcode unlocks it (`POST /app/v1/auth/passcode-verify`) until the absolute limit (IAM-18).

### 8.2 Session Rules

1. An access token lives 15 minutes; it carries only the session identifier and realm. Every request reloads the session and the account from the database (liveness), so a disabled account or revoked session stops working at the next request.
2. The refresh token rotates on every use; using a replaced token revokes the session and alerts the owner of the account.
3. Idle and absolute limits depend on the realm (Table 6). A workspace may shorten the member limits.
4. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to the realm's path or host. **[2.1, D1]** State-changing requests also carry the `X-XSRF-TOKEN` header, which must equal the readable `XSRF-TOKEN` cookie of the session (double submit), and an `Origin` header equal to the application's origin.
5. A person sees and can revoke their own sessions; an administrator can revoke the sessions of the workspace's members; a staff owner can revoke staff sessions. **[2.1]** A revoked session is told to the open browser at once over the socket (IAM-19).

### 8.3 Identity Requirements

**Table 30: Identity, sign-in and session requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| IAM-01 | The acting principal comes only from the server-side session; no endpoint accepts an actor, approver, viewer or author identifier in its input | M | A test sends `approverId` or `viewer` in every command body: each is rejected as an unknown field |
| IAM-02 | Passwords are hashed with Argon2id (memory at least 19 MiB, 2 iterations); bcrypt hashes from earlier imports are re-hashed at the next successful sign-in | M | After sign-in, the stored hash starts with `$argon2id$` |
| IAM-03 | **[2.1, B3]** Passwords have at least **12** characters, any characters allowed, and are checked against a list of common and breached passwords; no composition rules and no forced periodic change | M | An 11-character password is refused; "Password1234" is refused as breached; a 12-character passphrase is accepted |
| IAM-04 | Sign-in failures lock the account for 15 minutes after 5 attempts; per-account and per-IP rate limits apply; the response never reveals whether the e-mail exists | M | Six wrong passwords lock the account; the error is identical for unknown e-mails |
| IAM-05 | **[2.1, B2]** TOTP second factor with 10 hashed recovery codes; mandatory for staff, workspace owners, administrators and accountants; a workspace may require it for all members | M | An accountant without a second factor is asked to enrol before reaching any page |
| IAM-06 | Sensitive actions ask for a fresh second factor less than 5 minutes old: changing the company bank account, exporting all data, deleting the workspace, transferring ownership, disabling the second-factor requirement | M | Without a fresh factor the command returns `STEP_UP_REQUIRED` and nothing changes |
| IAM-07 | **[2.1, B1]** Sessions follow the limits of Table 6 (members 30 min idle and 12 h absolute, staff 15 min and 8 h, portal 2 h and 7 days); refresh tokens rotate; reuse revokes the session | M | Replaying an old refresh token ends the session and writes an audit event; a member idle for 31 minutes must unlock or sign in again |
| IAM-08 | A disabled account, removed membership or revoked session is refused at the next request | M | Disabling Lina while she is signed in returns 401 on her next click |
| IAM-09 | Rate limits use Redis when configured and Postgres counters otherwise, with the same thresholds | S | With Redis stopped, the sixth sign-in attempt in 15 minutes is still refused |
| IAM-10 | Single-use tokens are random (at least 256 bits), stored hashed, expire by purpose (15 min for portal links; 24 h for verification, reset, e-mail change and second-factor reset; 7 days for member invitations; 72 h for staff invitations) and are consumed atomically | M | Using an invitation link twice fails the second time, even when both requests arrive together |
| IAM-11 | One person may hold memberships in several workspaces; the active workspace is chosen per session and checked on every request | M | Switching to a workspace without an active membership returns 403 |
| IAM-12 | **[2.1, B10]** Portal contacts sign in with a single-use e-mail link (`POST /portal/v1/auth/link`, `GET /portal/v1/auth/callback`); their session is limited to their client and expires after 2 h idle and 7 days absolute | M | A portal session cannot call any `/app` route; asking a link for an unknown address returns the same answer as for a known one |
| IAM-13 | Sign-in from a new device or country notifies the account owner by e-mail and in the bell | S | A sign-in with a new user agent creates one notice |
| IAM-14 | A workspace always keeps at least one active owner with a verified e-mail; removing or demoting the last owner is refused | M | Demoting the only owner returns `LAST_OWNER` |
| IAM-15 | Password reset, e-mail change and second-factor reset revoke all other sessions and notify the previous address | M | After a reset, the other browser is signed out |
| IAM-16 | Sign-in, failures, lockouts, second-factor changes, session revocations and invitation events are audited in `audit.identity_events`, since no workspace is known at sign-in; events after a workspace is chosen also go to its trail | M | A failed sign-in for an unknown e-mail and a successful one each write one identity event with IP and user agent |
| IAM-17 | The console can be limited to an IP allow-list (decision D-08), off at launch; a change of the list needs an owner with a fresh second factor | C | With the list on, a staff sign-in from another address is refused and audited |
| **IAM-18** **[2.1]** | A member may set a numeric passcode of 4 to 8 digits, hashed with Argon2id and rate-limited like a password (5 failures sign the person out); it only unlocks an existing session after the idle limit and never replaces sign-in | C | Six wrong passcodes end the session; a passcode is refused after the 12 h absolute limit |
| **IAM-19** **[2.1]** | A revoked session (by the person, an administrator, a password reset or token reuse) is pushed to the browsers that hold it over the socket, which sign out at once | S | Revoking Lina's session from the administrator screen signs her browser out within 5 seconds without a click |

---

## 9. Multi-Tenancy and Isolation

Every company's data lives in the same database, in the same tables, separated by `workspace_id`. This shared-schema model is the right one for the volume of Table 4; its risk is a single missed filter. The design answers that risk with three independent barriers, so that a failure of one is caught by the others.

```
Request with a session: the workspace is named in the path and checked
against the person's active memberships, never trusted from the client
        │
Barrier 1, server: every query of a tenant repository filters by the workspace;
tested by the tenancy guard
        │
Barrier 2, row-level security: app.workspace_id set per transaction;
other rows invisible and unwritable
        │
Barrier 3, database roles: the console role has no privilege on tenant tables;
support uses a separate role
        │
Tenant tables with composite keys: a record can only reference records of its own workspace
```

_Figure 4: Three barriers between a request and another company's data._

### 9.1 Workspace Access States

The platform decides whether a workspace may be used (trial, active, overdue, read-only, suspended, cancelled, deleted; console requirements CUS-06 to CUS-09 and decisions D-02, D-03). The tenant side reads only the resulting access state from the view `platform.workspace_access` and applies it to every request.

**Table 31: Effect of the access state on company users.**

| Access state | Comes from | Effect on requests |
|---|---|---|
| Full | Trial, active, payment overdue within grace | All actions allowed by roles |
| Read-only | Ended trial without a plan (7 days), dunning step, owner's own choice before deletion | Reads and exports allowed; writes refused with `WORKSPACE_READ_ONLY`, except paying Nexora, choosing a plan and exporting data |
| Suspended | End of read-only period, suspension by staff with a reason | Only the owner can sign in, to pay, choose a plan or export data; portal access closed |
| Deleted | Data deletion completed | No access; the workspace record keeps only what retention requires |

### 9.2 Support Sessions

The console reaches a company's data only through a support session approved by that company's administrator (console requirements SUP-03 to SUP-09, BR-11, BR-12). On the server, a support session is a separate realm: the agent's requests to the tenant area run under the `nx_support` role, whose row-level security policy requires an active, unexpired session row for that workspace. The scope is read-only in this release (decision OD-8); each request made in the session is recorded in both the console and the workspace audit trails, and the session ends automatically at its expiry.

### 9.3 Tenancy Requirements

**Table 32: Multi-tenancy and isolation requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| TEN-01 | **[2.1, B11]** The workspace of a request is named in the path (`/app/v1/workspaces/:wid/…`) and accepted only after checking that the person holds an active membership in it; otherwise the request is refused with 403 and an audit event. Routes without a workspace in the path use the session's active membership | M | Calling another workspace's path returns 403 and an audit event, and reads nothing |
| TEN-02 | Memberships are the single source of a person's workspaces and roles; the user record has no workspace or role column | M | Schema test: `identity.users` has no `workspace_id` or role |
| TEN-03 | The resolved tenant context (workspace, membership, role, employee) is an immutable object passed to the application layer; middleware cannot overwrite the account's own fields | M | A unit test attempts to change the context after resolution and fails |
| TEN-04 | Every tenant repository query filters by the workspace explicitly, in addition to row-level security | M | The tenancy guard parses every repository SQL statement and finds the filter, except allowlisted statements with a written reason |
| TEN-05 | Each unit of work sets `app.workspace_id` (and `app.client_id` for the portal) with `SET LOCAL`; a connection returned to the pool keeps no tenant setting | M | Two consecutive transactions on the same pooled connection for two workspaces each see only their own rows |
| TEN-06 | Cross-tenant references are impossible: composite foreign keys include the workspace | M | Creating an invoice line pointing at a time entry of another workspace fails at the database |
| TEN-07 | The tenancy guard (from the Architecture repository) is extended: route chain order per realm, repository SQL filters, row-level security present on every tenant table, new route files denied until classified | M | Adding a route file without a policy fails CI |
| TEN-08 | An isolation test suite creates two workspaces with identical data and checks every query and command of every module from one against the other | M | 100% of application queries and commands covered; zero leaks |
| TEN-09 | Access states of Table 31 are enforced on every request from the platform view; a state change takes effect at the next request | M | Setting a workspace read-only makes the next write return `WORKSPACE_READ_ONLY` |
| TEN-10 | Console requests never run under a role that can read tenant tables; support-session requests run under `nx_support` with an active session | M | Database privilege test: `nx_platform` gets a permission error on every tenant table |
| TEN-11 | Background jobs that touch tenant data run one workspace at a time with the workspace set, under the system principal | M | A job handler that forgets the workspace reads zero rows |
| TEN-12 | Files are stored under a key that includes the workspace; a signed link is issued only after checking the record the file is attached to | M | A file identifier from another workspace returns 404 |
| TEN-13 | Caches, if added later, include the workspace in every key | S | Code review checklist; cache key test |
| TEN-14 | The design keeps a single workspace movable to its own database (decision D-10): no sequence, file key or reference is shared between workspaces | C | A dry-run export and import of one workspace into an empty database passes the isolation suite |

---

## 10. Authorization

Authorization decides, for an authenticated principal in a resolved workspace, whether a command or query is allowed and on which records. It replaces the Architecture repository's yes-or-no `authorizeAdmin` gate with three checks applied in order: the permission, the record rules, and the field shaping of the response. Denial is the default.

### 10.1 Permission Catalogue

Permissions are the values of `AdminPermissionsPlatform` already used by the front end (`users:create`, `invoices:read`, `time:approve`, `costs:read`…), grouped by module. The server holds the catalogue; roles hold sets of permissions; a membership holds one role. Each command and query of the application layer declares the permission it needs in one place, and the permission test matrix is generated from those declarations. **[2.1]** The catalogue includes `clients:import`, `clients:export` and `projects:delete`, already in the front end's catalogue (Table 7).

### 10.2 Record Rules

Record rules are pure functions in the domain layer, one per subject, called with the tenant context and the record. They implement Section 3.4: own records, team, client scope, no self-approval, locked periods and frozen documents **[2.1]**, and shared views. A rule that refuses returns a code (`NOT_YOUR_RECORD`, `NOT_IN_TEAM`, `SELF_APPROVAL`, `PERIOD_LOCKED`, `DOCUMENT_FROZEN`); the application layer turns a refused read into "not found" so that existence is not revealed.

### 10.3 Response Shaping

Each query returns a typed view per audience (for example `EmployeeView` without cost fields and `EmployeeCostView` with them). The view is chosen from the caller's permissions before the database is read, so that sensitive columns are not even selected when the caller may not receive them.

### 10.4 Approver Resolution

For time, expenses and leave, the approver is resolved by the server from the employee hierarchy (`resolveApprover`): the submitter's direct manager, otherwise the next manager up the chain, otherwise an active administrator, never the submitter. The number of steps comes from the workspace's approval rules and the amount (`stepsRequired`); a two-step request needs two different approvers. For money documents (quotes, invoices, supplier bills), the approvers are the members who hold the subject's approve permission, excluding the author; a manager's position in the hierarchy gives no right on them. The decision is recorded on the record (`first_approved_by`, `approved_by`, `submitted_by`) and in `approval_decisions`.

### 10.5 Authorization Requirements

**Table 33: Authorization requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| AUZ-01 | Every command and query declares its permission; a route without a declaration does not start | M | Boot fails when a handler has no permission declaration |
| AUZ-02 | The default roles enforce Table 7; custom roles use the same catalogue | M | The permission matrix test runs every command and query for each default role and compares with the table |
| AUZ-03 | Record rules of Section 3.4 run on every read and write after the permission check | M | An employee reading another employee's time entry receives 404 |
| AUZ-04 | No self-approval for time, expenses, leave, supplier bills, quotes and invoices under approval rules, whatever the role | M | An administrator approving their own expense receives `SELF_APPROVAL`; the database check refuses the same row |
| AUZ-05 | The approver is resolved by the server; two-step rules need two different approvers; the second step applies only above the configured amount | M | With a two-step rule above 5,000 MAD, a 6,000 MAD expense stays pending after the first approval and is approved by a second person |
| AUZ-06 | Approval rules set to "none" approve automatically with the system as approver, recorded as such | M | The record shows the approver auto and an audit event |
| AUZ-07 | Responses are shaped per permission; cost, rate and salary fields are never selected for callers without `costs:read` | M | A manager's employee list response contains no `hourly_cost` key |
| AUZ-08 | Individual KPIs follow the workspace visibility setting (self, manager, everyone) | M | With "self", a manager cannot read a team member's utilisation figure |
| AUZ-09 | Denied actions return 403 (permission) or 404 (record rule), write an audit event for writes, and never reveal the existence of the record | M | Repeated denied writes appear in the audit trail with the code |
| AUZ-10 | A role change, membership disablement or permission removal takes effect at the next request | M | Removing `invoices:create` from a role refuses the next draft immediately |
| AUZ-11 | The last owner cannot remove their own owner role; owners only can change owners | M | Test of the two cases |
| AUZ-12 | Portal contacts reach only portal views of their client's records; no `/app` permission can be granted to them | M | A portal session requesting a project of another client receives 404 |
| AUZ-13 | Staff permissions follow Table 23 of the console specification, with step-up ("2FA") and two-person ("2P") actions enforced by the server | M | The console permission matrix test passes for the seven staff roles |
| AUZ-14 | Changes to roles and permissions are audited with before and after | M | Audit test |

---

## 11. Business Modules I: Workspace, People, Clients and Projects

Sections 11 to 13 give, module by module, what the server must own: the rules it enforces, the state it keeps and the side effects it produces. The screens and their behaviour are those of the existing front end; where a rule already exists in `packages/core`, the requirement names the function the server calls.

### 11.1 Workspace, Settings and Subscription

The workspace module holds the company's identity, its configuration and the rules that other modules read: numbering formats, VAT regime, lock date, approval rules, holidays, leave types, expense categories, KPI targets and custom fields.

**Table 34: Workspace and settings requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| WSP-01 | Company settings are validated on the server: ICE 15 digits, IF 6 to 8 digits, patente 8 digits, CNSS 7 digits for Moroccan companies (`assertCompanyIds`); free text elsewhere | M | Saving an ICE of 14 digits for a Moroccan company returns `INVALID_ICE` |
| WSP-02 | The base currency, country and time zone drive dates, totals and reports; changing the base currency is refused once a document has been issued | M | After the first issued invoice, a base-currency change returns `BASE_CURRENCY_LOCKED` |
| WSP-03 | Numbering formats contain `{YYYY}` and `{SEQ}`; `{YYYY}` prints the year in which the series' fiscal year starts, so two fiscal years never print the same number; a format change applies to the next number and never renumbers issued documents | M | Changing `INV-{YYYY}-{SEQ}` to `F{YYYY}/{SEQ}` leaves issued numbers unchanged; with a fiscal year starting in July, an invoice issued in January 2027 is numbered `INV-2026-…` |
| WSP-04 | The lock date (FBR-7) moves forward freely; moving it backward needs an owner, a reason and a fresh second factor, and is audited | M | An accountant moving the lock date back receives 403 |
| WSP-05 | Approval rules (none, one step, two steps with threshold) are read by every approval command at the time of the decision | M | Changing a rule to two steps makes the next expense need two approvers |
| WSP-06 | Holidays, working days and leave types are the inputs of leave balances and capacity; editing a holiday recomputes affected pending requests' day counts | S | Adding a holiday inside a pending request reduces its counted days by one |
| WSP-07 | Custom fields are validated by type and required flag on the server; removing a field keeps stored values (PLT-12) | M | A required custom field missing on create returns `CUSTOM_FIELD_REQUIRED` |
| WSP-08 | Settings changes are audited with before and after, per field | M | Audit event lists the changed fields only |
| WSP-09 | The workspace's plan, features and seat limit are read from the view `platform.workspace_access`; invited and active memberships both take a seat; an invitation beyond the limit is refused under the lock of Table 50 (BR-01). **[2.1]** `GET /app/v1/me/workspaces` returns, for each of the person's workspaces, its plan, feature keys and seats, so the menu hides what the plan does not include | M | On Starter with 5 seats used, a sixth invitation returns `SEAT_LIMIT` |
| WSP-10 | Plan features gate commands on the server. **[2.1, D4]** Starter: projects, time, approvals, quotes, invoices, portal. Business adds the DGI e-invoice file, VAT return and CGNC journal, suppliers and bills, resource planning, deals and forecast. Enterprise adds several workspaces, single sign-on and audit export | M | A Starter workspace calling the VAT return query receives `PLAN_FEATURE`; creating a deal on Starter receives `PLAN_FEATURE` |
| WSP-11 | An owner can export all workspace data (PLT-14, AUD-04) as a background job; the archive is available 7 days through a signed link. **[2.1]** The export reads the list of tables from the database catalogue, not from a hand-kept list, so new tables are never missed | M | Export completes, the link works for 7 days, then returns 410; a test adds a tenant table and finds it in the next export |
| WSP-12 | An owner can request deletion of the workspace; it becomes read-only, then deleted after the retention rules of Section 19, with the accounting records of Table 61 archived 10 years (BR-13) | M | The deletion job archives every accounting record of Table 61 (invoices, credit notes, payments, bills, receipts, VAT periods, journal exports) and removes everything else |

### 11.2 People and HR

**Table 35: People and HR requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| PPL-01 | Employees have a lifecycle (starting, active, on leave, notice, inactive); an inactive employee keeps history, cannot log new time and is removed from new assignments (HR-5) | M | Logging time for an inactive employee returns `EMPLOYEE_INACTIVE` |
| PPL-02 | The manager chain never forms a loop (HR-8) | M | Setting A's manager to B when B reports to A returns `MANAGER_CYCLE`; the trigger refuses it as well |
| PPL-03 | Rates are effective-dated (HR-3, FBR-4): a rate change creates a row from a date; the rate on a date is the latest row on or before it; past approved hours keep their frozen rates | M | A rate raised from 1 November does not change October hours approved earlier |
| PPL-04 | Gross salary and employer cost (`employerCost`) give the hourly cost when no manual cost is set; Moroccan employer contributions apply only to Moroccan companies | S | A Moroccan employee with a gross salary gets the computed cost per hour |
| PPL-05 | CIN, CNSS number and the employee's bank account are encrypted at the application level and returned only to administrators and the employee | M | Database dump shows ciphertext; a manager's response omits the fields |
| PPL-06 | Employee documents warn 30 days before expiry and mark expired documents; medical documents are sensitive files (Table 8) | M | A contract expiring in 20 days appears in the owner's inbox |
| PPL-07 | Leave requests count working days of the person, excluding holidays, halved for half days (`requestDays`); a request beyond the balance of a counted type is refused (`balanceProblem`), checked under the lock of Table 50 | M | A 3-day request with 2 days left returns `LEAVE_BALANCE` |
| PPL-08 | Pending and approved leave of a person never overlap (database exclusion constraint) | M | Two overlapping requests: the second fails even when submitted at the same instant |
| PPL-09 | Leave follows the approval engine (APR); cancelling approved leave in the future is allowed to the employee, in the past only to an administrator | M | Employee cancels next week's leave; cannot cancel last week's |
| PPL-10 | Yearly allowances are prorated for people hired during the year; carry-over is capped by the type's maximum and recorded as an adjustment at year end | S | An employee hired 1 July receives half the yearly days |
| PPL-11 | Performance reviews follow self, manager, done; each part can be written only by its owner; the KPI snapshot is frozen when the manager submits (HR-9) | M | A manager cannot edit the self-assessment |
| PPL-12 | Payroll inputs for a month (hours, leave by type, reimbursed expenses, salary, employer cost) are generated as a run; a final run is frozen and exportable | S | Re-generating a final month is refused; a draft can be regenerated |
| PPL-13 | Employee accounts (Team access) link a membership to an employee; disabling the account ends the person's sessions and keeps their records | M | Disabled employee's open timer is stopped and saved; their next request returns 401 |

### 11.3 Clients, CRM and Portal

**Table 36: Clients, CRM and portal requirements.** **[2.1: REL-11 to REL-22 added]**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| REL-01 | Client identifiers are checked: a business client in Morocco must have a 15-digit ICE before an invoice is issued (`clientNeedsIce`, `assertClientIds`) | M | Issuing to a Moroccan company client without ICE returns `CLIENT_ICE_REQUIRED` |
| REL-02 | Client codes are unique per workspace; archiving a client keeps its history and refuses new projects, quotes and invoices | M | New project for an archived client returns `CLIENT_ARCHIVED` |
| REL-03 | The billing rate for a person and client is: the client's rate card for that person or job title, then the client's flat rate, then the person's billable rate on the date (`hourlyRate`) | M | Unit test of the four cases against stored data |
| REL-04 | Credit limit (CRM-8): issuing an invoice that brings the client's open balance above the limit needs an administrator's confirmation, recorded with a reason | S | An accountant issuing above the limit receives `CREDIT_LIMIT`; an administrator can confirm |
| REL-05 | Contracts warn before renewal; deals move through stages (REL-14); a lost deal needs a reason; a won deal can create a quote or project (REL-15) | S | Lost without reason returns `REASON_REQUIRED` |
| REL-06 | The client activity timeline is built on the server from projects, quotes, invoices, payments, contracts and notes (CRM-7) **[2.1]**, follow-ups and history | S | Timeline query returns items from six sources in date order |
| REL-07 | Portal access is granted per contact, sends a sign-in link, expires after inactivity (CRM-12), and is revoked when the contact or client is archived **[2.1]** or deleted | M | A contact unused for 91 days with a 90-day setting cannot sign in |
| REL-08 | Portal contacts see only: their client's projects and milestones, change orders sent to the client, issued invoices with balance, sent and decided quotes, documents shared with the client, and surveys addressed to them **[2.1]**, and the requests their client sent (WRK-17) | M | The portal isolation suite finds no other record kind |
| REL-09 | From the portal a contact can accept or decline a sent quote, approve or reject a change order sent to the client, approve a milestone or ask for changes with a comment, and answer a satisfaction survey **[2.1]**, and send a request; each decision records the contact as actor | M | Accepting an expired quote returns `QUOTE_EXPIRED`; a decision appears in the workspace audit |
| REL-10 | Satisfaction answers are validated (rating 1–5, NPS 0–10) and accepted once per survey link | S | A second answer to the same link returns `ALREADY_ANSWERED` |
| **REL-11** **[2.1]** | A lead becomes a client by *convert* (optionally with a first deal) or is *dropped* with a reason; the lead source is kept for conversion figures (`leads.ts`) | M | Dropping without a reason returns `REASON_REQUIRED`; converting sets `converted_at` once |
| **REL-12** **[2.1]** | A contact may hold several e-mails and phones; `linkedin` and the client `website` accept http/https only; one primary contact per client (`contacts.ts`) | S | A `javascript:` LinkedIn returns `BAD_URL`; a second primary is refused |
| **REL-13** **[2.1]** | Follow-ups have an owner, a due date and a status (to do, in progress, done); done stamps who and when; due and late follow-ups reach their owner's inbox (`follow-ups.ts`) | M | A follow-up due today appears once in the owner's inbox at 08:00 local time |
| **REL-14** **[2.1]** | A workspace has up to 10 open sales stages plus won and lost, each with a chance %; removing a stage moves its deals to a chosen stage in the same transaction (`deals.ts`) | M | Removing a stage that holds 3 deals leaves 0 deals on an unknown stage |
| **REL-15** **[2.1]** | The server sets `stage_since` on every stage change; a deal is stale after the workspace's `stale_days`; a won deal creates one project | S | A second "create project" returns `DEAL_HAS_PROJECT`; a lost deal returns `DEAL_NOT_WON` |
| **REL-16** **[2.1]** | Every change to a client writes one history row per changed field (contacts and custom fields one by one), with the actor; rows are never updated (`client-history.ts`) | M | Renaming a client and changing its manager writes 2 rows; an `UPDATE` on the table fails |
| **REL-17** **[2.1]** | Deleting a client without invoices moves it to a bin for 30 days with its contacts, deals and follow-ups; it can be restored, purged, or is purged by a job; a client with invoices can only be archived | M | A purged client is gone with its files; one with an invoice returns `CLIENT_HAS_INVOICES` |
| **REL-18** **[2.1]** | Two clients merge in one transaction: values chosen field by field, every linked record moves (projects, deals, follow-ups, quotes, invoices, contacts, files, requests, bank matches, saved reports and views that name the client), the other client is removed, history and audit record it | M | After merging, no row of any table references the removed client |
| **REL-19** **[2.1]** | Files attach to a client with a category, follow §13.3, and move with a merge | S | A file of another workspace cannot be attached (composite key) |
| **REL-20** **[2.1]** | The server resolves @mentions in client notes to employees (never the author) and creates a notice for each | S | Mentioning Karim creates one notice for him and none for the author |
| **REL-21** **[2.1]** | Clients, contacts and deals can be imported from CSV or Excel; the server re-validates every row, upserts on ICE or e-mail, reports per row, and needs `clients:import`; exports need `clients:export` (`crm-import.ts`) | M | An import of 500 clients with 3 bad rows creates 497 and lists the 3 with their codes |
| **REL-22** **[2.1]** | A member can save a list view (filters, sort, columns, grouping) and share it with the workspace; only its owner or an administrator removes it | S | A shared view is visible to every member; deleting another's view returns 403 |

### 11.4 Projects and Planning

**Table 37: Projects and planning requirements.** **[2.1: WRK-12 to WRK-22 added]**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| WRK-01 | Project codes are unique per workspace; budget fields match the budget type (fixed, hourly, non-billable, retainer) | M | A retainer project without included hours returns `RETAINER_TERMS` |
| WRK-02 | Only project members log time on a project; removing a member keeps their past hours | M | A non-member logging time receives `NOT_PROJECT_MEMBER` |
| WRK-03 | Templates create a project with milestones and tasks dated from the start date, dependencies included (PRJ-2); **[2.1]** a template can be deleted by a member with `projects:update` | S | Creating from a template with 12 tasks creates 12 tasks with correct dates |
| WRK-04 | Task dependencies stay inside the project and never form a cycle (PRJ-6) | M | A dependency creating a loop returns `DEPENDENCY_CYCLE` |
| WRK-05 | Task changes write the task activity history automatically (PRJ-7); mentions notify the mentioned people; **[2.1]** each mention in a task comment creates one notice (NTF-07) | S | Changing status writes one activity row and no duplicate |
| WRK-06 | Milestones that need client approval count as reached only after the portal approval (or on their date when no approval is needed) | M | Revenue recognition ignores an unapproved milestone |
| WRK-07 | Change orders are numbered per project; approved orders add their hours and amount to the budget; rejected or draft orders do not | M | Budget usage after approval includes the change |
| WRK-08 | Health is computed on the server; a manager's override needs a reason and is recorded with author and time (PRJ-10) | S | Override without reason returns `REASON_REQUIRED` |
| WRK-09 | Closing a project (PRJ-13) freezes a profitability snapshot, refuses new time and expenses, and is refused while drafts reference it | M | Logging time on a closed project returns `PROJECT_CLOSED` |
| WRK-10 | Budget usage (PRJ-11) compares logged or billed amounts with the budget including approved changes, computed on the server | M | Usage figure equals the core function's result on the same data |
| WRK-11 | Resource bookings feed workload and capacity; bookings above a person's weekly capacity are allowed but flagged | S | Overbooking returns a warning flag, not an error |
| **WRK-12** **[2.1]** | Each task gets the next number of its project (key `CODE#N`), from the series `task:<project>`, never reused even after deletion | M | Two tasks created at the same instant get different numbers |
| **WRK-13** **[2.1]** | A task has one main assignee, collaborators and watchers, all project members | S | Adding a non-member returns `NOT_PROJECT_MEMBER` |
| **WRK-14** **[2.1]** | Task links accept http/https only; task relations (waits for, duplicate of, related) are read from both sides; attachments follow §13.3 | S | A relation shows on both tasks; a `data:` link returns `BAD_URL` |
| **WRK-15** **[2.1]** | A project names its task states inside the fixed groups (to do, in progress, review, done, cancelled); progress counts the groups; cancelled tasks are closed and leave progress (`task-states.ts`) | M | Renaming a state keeps every task's group; deleting a used state moves its tasks |
| **WRK-16** **[2.1]** | Task views (board, list, table, calendar with filters and grouping) are personal or shared with the project team | S | A shared view is visible to members only |
| **WRK-17** **[2.1]** | A portal contact or the team logs a client request; the team accepts it (creating a task, or a draft change order when out of scope, in one transaction), snoozes it until a date, marks it duplicate, rejects it with a reason, or reopens it (`client-requests.ts`) | M | Accepting creates exactly one task; the portal sees only its own client's requests |
| **WRK-18** **[2.1]** | Cycles are optional per project, last 1 day to 4 weeks and never overlap; closing moves unfinished tasks to the next cycle or the backlog and freezes a summary (`cycles.ts`) | S | An overlapping cycle fails at the database; a closed cycle's summary never changes |
| **WRK-19** **[2.1]** | When a repeating task is done, the next one is created exactly once, dates moved on and checklist unticked (`task-repeat.ts`) | S | Marking it done twice creates one next task |
| **WRK-20** **[2.1]** | Deleted tasks wait 30 days in the project's bin (restore, purge, or purged by a job); tasks done more than 30 days ago are hidden unless asked | S | A task purged by the job loses its comments and files |
| **WRK-21** **[2.1]** | Project pages (wiki pages and meeting notes) belong to a project; an action item becomes a task given to the person mentioned, and the line links to it, in one transaction (`project-pages.ts`) | S | Converting the same line twice creates one task |
| **WRK-22** **[2.1, D8]** | A project with hours, invoices, quotes, expenses, bills, change orders or feedback cannot be deleted (it is closed instead); deleting an empty project removes its tasks, pages, views, requests and bookings in one transaction and needs `projects:delete` | M | Deleting a project with hours returns `PROJECT_HAS_HISTORY` and changes nothing |

---

## 12. Business Modules II: Time, Approvals, Sales and Purchases

These modules turn work into money. They carry the rules whose failure would cost a company revenue, a client dispute or a tax correction, so most of their requirements are Must.

### 12.1 Time Entries and Timers

A time entry moves through draft, submitted, approved or rejected; an approved entry becomes invoiced when an issued invoice line references it (Annex B).

**Table 38: Time entry and timer requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| TME-01 | Hours are positive, at most 24 per entry, in quarter-hour steps (TIM-1); the total of one person on one day never exceeds 24 hours | M | A third entry bringing a day to 24.25 hours returns `DAY_OVER_24H`, also when two entries are saved at the same time |
| TME-02 | An entry can be created only by its employee (or an administrator on their behalf, recorded as such), on a project where they are a member, not closed, for an active employee, outside the locked period | M | Each refusal returns its own code; an administrator's entry records both the employee and the author |
| TME-03 | Entries on non-billable projects are never billable | M | Setting billable on such an entry is ignored and stored as false |
| TME-04 | Submitting a week moves the person's draft entries of that week to submitted in one transaction; submitted entries are read-only to the employee | M | Editing a submitted entry returns `ENTRY_LOCKED` |
| TME-05 | Copying last week fills only empty cells (TIM-13) and never duplicates an entry | S | Copy twice in a row: the second copy adds nothing |
| TME-06 | Approval freezes the bill rate and cost rate in force on the entry's date (TIM-9); later rate changes never alter them | M | After a rate change, the approved entry keeps its stored rates |
| TME-07 | Rejection needs a reason and returns the entry to the employee as editable; reopening an approved entry (TIM-7) is allowed only if it is not on a non-void invoice and the period is open | M | Reopening an invoiced entry returns `ENTRY_INVOICED` |
| TME-08 | An invoiced entry is frozen; it becomes billable again only when its invoice is voided or a credit note releases it | M | Updating an invoiced entry is refused by the database trigger |
| TME-09 | One running timer per person (database partial unique index); stopping a timer creates a draft entry dated on the start day in the workspace time zone, rounded up to the next quarter hour | M | Starting a second timer returns `TIMER_RUNNING`; a 50-minute timer creates a 1.00-hour entry |
| TME-10 | A timer running more than 12 hours is stopped by a job, saved as a draft entry flagged for review, and the person is notified | S | A timer started yesterday morning is stopped overnight and flagged |
| TME-11 | Time on a day of approved leave or a holiday is allowed but returns a warning flag | C | Response contains `warnings: [ON_LEAVE]` |
| TME-12 | Unbilled approved hours per client and project are computed on the server (`unbilledEntries`) for the Ready to bill list | M | Value equals the core function on the same data |

### 12.2 Approvals

One approval engine serves time, expenses, leave, quotes, invoices and supplier bills. It calls the core functions `resolveApprover`, `stepsRequired` and `approvalDecision`, and records every decision.

**Table 39: Approval engine requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| APR-01 | The engine computes the steps required from the workspace rule and the amount at the time of submission, and stores it on the request | M | A rule changed after submission does not change the steps of pending requests |
| APR-02 | For time, expenses and leave, only the resolved approver, an approver above them in the chain, or an administrator may decide; for money documents, only a member holding the approve permission (Section 10); never the submitter or the subject | M | A colleague at the same level receives 403 |
| APR-03 | Two-step requests need two different people; the second decision completes the request | M | The same person approving twice receives `SAME_APPROVER` |
| APR-04 | Bulk approval applies the rules to each item and reports per item; one refused item does not block the others | M | Approving 10 entries where 1 is the approver's own: 9 approved, 1 refused with its code |
| APR-05 | Every decision writes a row in `approval_decisions` and an audit event, in the same transaction as the status change | M | Approval count equals decision rows in a consistency check |
| APR-06 | Pending approvals of a person whose manager leaves are reassigned to the next approver up the chain | S | Disabling a manager moves their pending approvals |
| APR-07 | The inbox shows each approver their pending items, computed on the server with one query per subject | M | Inbox count equals the number of pending items the person may decide |

### 12.3 Quotes

**Table 40: Quote requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| SAL-01 | **[2.1, B7]** A quote takes a number from the quote series (`DEV-{YYYY}-{SEQ}` by default) when it is **sent**, inside the send transaction; drafts stay unnumbered, so deleted drafts leave no gap; numbers are unique per workspace | M | Two quotes sent at the same instant get different numbers; a deleted draft consumes no number |
| SAL-02 | A quote is draft, pending approval and approved (when the workspace rule requires approval), sent, accepted or declined; expired is derived from the validity date; accepted and declined quotes are frozen | M | Editing an accepted quote returns `DOCUMENT_FROZEN` |
| SAL-03 | Totals (lines, discount, VAT per rate) are computed on the server from the lines and stored | M | Stored totals equal the recomputation in the consistency check |
| SAL-04 | Accepting a quote can create the project and an advance or first invoice draft: in the same transaction when a member accepts; through an outbox event handled by an `nx_app` job when the contact accepts from the portal | S | After acceptance from either side, the project and draft exist once and both reference the quote |
| SAL-05 | Declining needs a reason; a declined or expired quote cannot be accepted | M | Accepting an expired quote returns `QUOTE_EXPIRED` |
| SAL-06 | When the workspace's approval rule for quotes is one or two steps, a quote is sent only after approval; the author cannot approve it | M | Sending an unapproved quote returns `APPROVAL_REQUIRED` |

### 12.4 Client Invoices

**Table 41: Client invoice requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| SAL-10 | Drafts can be built from approved unbilled hours (grouped by project, task or day; never mixing rates on one line), fixed-price shares, milestones, retainer months, advances, re-billed expenses or free lines (BIL-3, BIL-4) | M | Each builder's output equals the core builder on the same data |
| SAL-11 | Hours and expenses put on a draft are reserved for it; another draft cannot take them | M | Two accountants drafting from the same hours at the same time: the second receives `ALREADY_ON_INVOICE` |
| SAL-12 | Fixed-price billing never exceeds the project price plus approved change orders (BIL-18), checked with the project row locked | M | A share bringing billing above the price returns `OVER_PROJECT_PRICE` |
| SAL-13 | Advances (deposits) are deducted on later invoices of the same client in proportion to their VAT rate | M | The deduction line reverses the advance's VAT at its rate |
| SAL-14 | Retainer invoices bill the monthly amount plus hours beyond the included ones at the overage rate; one non-void retainer invoice per project and month (partial unique index on the retainer period) | M | A second retainer draft for the same month returns `ALREADY_INVOICED` |
| SAL-15 | Totals: VAT per line at the line rate (or the invoice rate), withholding at source on the total when the client must withhold (BIL-6), computed by `invoiceTotals` | M | Property test against the core function |
| SAL-16 | Invoices in another currency need an exchange rate with 6 decimals and its date; the amount in base currency is stored at issue and never recomputed (BIL-7) | M | Issuing a EUR invoice without a rate returns `EXCHANGE_RATE_REQUIRED` |
| SAL-17 | Issue checks: at least one line, period open on the issue date, company identifiers complete, client ICE when required (`invoiceIdProblems`), totals positive except credit notes | M | Each failing check returns its own code and no number is consumed |
| SAL-18 | Issue takes the next number of the series for the fiscal year (`fiscalYearOf`) inside the issue transaction (TRX-03); invoice and credit-note series are separate (`INV-…`, `CN-…`) | M | 50 concurrent issues produce 50 consecutive numbers, no gap, no duplicate |
| SAL-19 | At issue the server stores a snapshot of the seller's and the client's identity (names, addresses, ICE, IF, RC) as printed; later changes to the client do not change issued invoices | M | Renaming the client leaves the issued invoice's client name unchanged |
| SAL-20 | An issued invoice is frozen except the columns of Table 16; reminders and deliveries are separate rows; deletion is impossible (FBR-5) | M | Database trigger refuses any other update |
| SAL-21 | PDF and UBL files are generated after issue by jobs, stored with their SHA-256, and never regenerated differently; a regeneration must produce the same hash | M | After the stored PDF object is deleted, regenerating it from the invoice gives a file with the stored hash |
| SAL-22 | Cancelling (void) is allowed only for an issued or sent invoice with no payment, not sent to the DGI, whose issue date is after the lock date and outside a filed VAT period (otherwise `PERIOD_LOCKED`: a credit note is used); the number stays used and visible as cancelled; its hours and expenses become billable again | M | Voiding an invoice with a payment returns `HAS_PAYMENTS` |
| SAL-23 | Credit notes (BIL-10) reference an issued invoice, credit chosen lines once only, take a number of the credit-note series, may release the credited hours, and cannot themselves be credited or paid | M | Crediting the same line twice returns `ALREADY_CREDITED` |
| SAL-24 | Sending records the recipient and time (BIL-11) and queues the e-mail with the PDF and XML through the outbox | M | The e-mail is sent once even if the request is retried with the same idempotency key |
| SAL-25 | Draft deletion releases its hours and expenses; issued documents are never deleted | M | Deleting an issued invoice returns `DOCUMENT_FROZEN` |
| SAL-26 | When the workspace's approval rule for invoices is one or two steps (with its amount threshold), a draft goes to pending approval and is issued only after approval; the author cannot approve it | M | Issuing an unapproved draft above the threshold returns `APPROVAL_REQUIRED` |

> **[2.1] Note.** The front end lets a workspace set approval rules for quotes, invoices and supplier bills but does not yet apply them to quotes and invoices (no "pending approval" state); SAL-06 and SAL-26 need the front-end item F1 of §21.4 before phase B1d.

### 12.5 Payments, Reminders and Recurring Invoices

**Table 42: Payment, reminder and recurring invoice requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| SAL-30 | A payment records money received (date, amount, method, reference, optional bank line) and its allocation to one or more invoices; allocations never exceed an invoice's balance after credit notes nor, in total, the payment; an unallocated remainder is client credit, shown on the client and allocatable later | M | Allocating 10.01 MAD more than the balance returns `OVER_BALANCE` |
| SAL-31 | An invoice becomes paid when its balance reaches zero and returns to issued or sent if a payment is reversed; "partly paid" is derived from the balance, not stored | M | Reversing the only payment of a paid, never-sent invoice returns it to issued |
| SAL-32 | Payments are never edited or deleted; a mistake is corrected by a reversing payment row that references the original (once only) with a reason, both audited | M | Database refuses update of a payment row |
| SAL-33 | Payment dates in a locked period are refused | M | Returns `PERIOD_LOCKED` |
| SAL-34 | Overdue reminders (BIL-15) go out at the workspace's three day offsets, each level once, only while a balance remains and the client has not opted out | M | Running the reminder job twice sends each level once |
| SAL-35 | Receivables aging (BIL-16) is computed on the server in five buckets from the due date in the workspace time zone | M | Bucket totals equal the open balances |
| SAL-36 | Recurring schedules (BIL-14) generate a draft for each due period exactly once, advance the next run date in the same transaction, and stop after the end date | M | The job running twice on the same day creates one draft |
| SAL-37 | Recurring drafts are sent for review, never issued automatically, unless the workspace enables automatic issue | S | With the default, generated invoices stay drafts |

### 12.6 Suppliers, Bills and Expenses

**Table 43: Purchase and expense requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| PUR-01 | Suppliers have checked identifiers for Moroccan companies; their bank account is encrypted | M | Invalid supplier ICE returns `INVALID_ICE` |
| PUR-02 | A supplier bill is unique per supplier and supplier's number; it follows submitted, approved, rejected, paid; the approver differs from the submitter; **[2.1]** the workspace's approval rule for bills (one or two steps, threshold) applies | M | Entering the same bill twice returns `DUPLICATE_BILL` |
| PUR-03 | Bill payments never exceed the bill total; the bill becomes paid when settled | M | Over-payment returns `OVER_BALANCE` |
| PUR-04 | Expenses need a receipt above the workspace threshold (EXP-2), follow the approval engine, and are reimbursed by an administrator or accountant after approval | M | Approving an expense of 600 MAD without receipt with a 500 MAD threshold returns `RECEIPT_REQUIRED` |
| PUR-05 | Billable expenses can be re-billed once on a client invoice; the link is released if that invoice is voided or credited with release | M | Re-billing twice returns `ALREADY_ON_INVOICE` |
| PUR-06 | Bills and expenses linked to a project count in its costs and profitability | M | Project cost includes the approved bill |
| PUR-07 | Deductible VAT from bills and expenses feeds the VAT return according to the regime (`billVatLines`, `deductibleVatLines`) | M | VAT return test with both regimes |

---

## 13. Business Modules III: Finance, Analytics, Files and Notifications

### 13.1 Bank Import, Journal, VAT and E-invoicing

These features give the accountant figures they can file. They are computed from frozen documents, so the same period always gives the same result, and every export is kept with its hash.

**Table 44: Finance and compliance requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| FIN-01 | A bank statement file (CSV) is parsed on the server with the core parser (separator, quotes, French, English and Arabic headers, local number and date formats) | M | The sample files of three Moroccan banks import with the expected line count |
| FIN-02 | The same file cannot be imported twice (file hash); the same line is imported once even from overlapping statements (line key per account) | M | Importing an overlapping statement adds only the new lines |
| FIN-03 | The column mapping of each bank format is remembered and suggested next time | S | Second import of a format needs no mapping |
| FIN-04 | Incoming lines get ranked invoice suggestions (`matchCandidates`); a person confirms; confirmation creates the payment and allocations in one transaction (`allocate`) | M | Confirming a line paying three invoices creates one payment and three allocations |
| FIN-05 | A matched line cannot be matched again; unmatching reverses the payment with a reason | M | Matching an already matched line returns `LINE_MATCHED` |
| FIN-06 | The CGNC journal for a period is computed from issued invoices, credit notes, payments, approved bills and reimbursed expenses (`buildJournal`); every document's entries balance | M | For any period, total debit equals total credit to the centime |
| FIN-07 | Account numbers come from the workspace's ledger mapping (4 to 8 digits); missing mappings use CGNC defaults; a mapping change applies to exports of open periods only | M | After changing the sales account, an open month's export uses it and a locked month's export is unchanged |
| FIN-08 | Each journal export is stored as a file with its SHA-256, period and author; the export of a locked period is built once and the stored file is returned afterwards | M | Two exports of a locked month return the same file and hash |
| FIN-09 | The VAT return is computed per period (monthly or quarterly) with the workspace's regime: on invoices or on payments (encaissement), carrying credit forward (`vatReturn`) | M | Test with both regimes on the same data gives the expected collected, deductible and payable amounts |
| FIN-10 | Filing a VAT period freezes its figures; the lock date must cover the period's end before filing | M | Filing a period that ends after the lock date returns `LOCK_PERIOD_FIRST` |
| FIN-11 | For Moroccan companies, each issued invoice and credit note gets a UBL 2.1 file built by `buildUblXml`, with ICE, IF, RC, patente and CNSS identifiers; problems are listed before issue (`eInvoiceProblems`) | M | The file of a credit note is a UBL CreditNote referencing the corrected invoice |
| FIN-12 | The e-invoice status (to send, sent, accepted, rejected) is tracked per invoice; once sent, the invoice can only be corrected by a credit note | M | Voiding an invoice sent to the DGI returns `SENT_TO_DGI` |
| FIN-13 | Sending to the DGI platform goes through a port with a fake adapter until the platform's specification is published; signing uses a key held in the secret store | W | Out of scope for this release; the port and fake exist |
| FIN-14 | The lock date blocks creation, change and deletion of dated records in every module (time, expenses, invoices, payments, bills, leave) on or before it | M | An integration test tries each module's write in a locked period: all refused |
| FIN-15 | Exchange rates used on invoices are stored on the invoice; a table of reference rates may be imported for suggestions | C | Importing new reference rates leaves the rate of every issued invoice unchanged |

### 13.2 Analytics, KPIs and Reports

Today every chart and KPI is computed in the browser from full collections. On the server the same core functions run on summaries, and only the figures the caller may see are returned (audit finding H3, M3).

**Table 45: Analytics requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| ANL-01 | KPIs (utilisation, on-time delivery, estimate accuracy, revenue per person), profitability, budget usage, revenue recognition, forecasts and the overview are computed on the server with the core functions | M | For the reference data set, every figure equals the front end's demonstration result |
| ANL-02 | Summary tables (`kpi_daily`, `project_financials`) are refreshed by jobs from outbox events and nightly; a figure is never more than 5 minutes behind its source during working hours | S | After approving hours, the utilisation figure updates within 5 minutes |
| ANL-03 | Reports read through read-only views; they never write; heavy reports run as jobs and return a file | M | A 12-month profitability report for the largest workspace returns in under 2 s or is offered as a file |
| ANL-04 | Individual figures respect KPI visibility and cost permissions (AUZ-07, AUZ-08) | M | A manager's team KPI query returns only the people they may see |
| ANL-05 | Saved reports store a validated definition and an owner; shared reports are visible to members who hold the report's permission | S | Sharing a cost report with a manager without `costs:read` hides it from them |
| ANL-06 | Nightly consistency checks recompute invoice totals, balances, journal balance and summary tables, and report differences on the operations page | S | A deliberately corrupted total is reported the next morning |
| ANL-07 | The inbox is one server query per user returning pending approvals, overdue items, expiring documents and mentions **[2.1]**, and every notice kind of NTF-07 | M | Inbox responds in under 300 ms for a manager of 50 people |
| **ANL-08** **[2.1]** | Global search (`GET /app/v1/workspaces/:wid/search?q=`) returns, in one call, the matching clients, leads, contacts, deals, projects, tasks, project pages, client requests, invoices, quotes, suppliers, supplier bills, follow-ups, employees and expenses, each kind only to the members allowed to read it | S | An employee's search returns no expense of a colleague and no supplier; results come back in under 300 ms |

### 13.3 Files and Documents

**Table 46: File requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| DOC-01 | Files are stored in a private S3-compatible bucket under a key that includes the workspace; the database holds name, type, size, SHA-256 and sensitivity | M | Listing the bucket publicly is impossible; every file row has a hash |
| DOC-02 | **[2.1, B8, D7]** Uploads go through one upload endpoint and are limited by type (PDF, images, office documents, CSV; SVG and HTML refused; XML only for the server's own UBL files) and size by kind: documents and receipts 10 MB, client and task files 20 MB, logo and avatar 2 MB; total storage per plan; the declared type must match the content | M | An executable renamed to `.pdf` is refused; an SVG is refused; a 21 MB task file returns `FILE_TOO_LARGE` |
| DOC-03 | Downloads use signed links valid 5 minutes, issued after checking the caller may read the record the file is attached to, **[2.1]** served with `Content-Disposition: attachment` from the storage domain, never the application's | M | A link used after 6 minutes returns 403 |
| DOC-04 | Issued invoice PDFs, UBL files and journal exports are immutable; their hash is checked on download | M | A modified object fails the hash check and is reported |
| DOC-05 | Sensitive files (medical, identity) are downloadable only by the allowed roles and every download is audited | M | Download by an administrator writes an audit event |
| DOC-06 | Files are scanned for malware before being made available | S | The EICAR test file is rejected |
| DOC-07 | Files follow the retention of their record and are deleted with it, except documents the law requires to keep; **[2.1]** files of a purged client or task are deleted with it | M | Deleting an expense draft deletes its receipt after the retention delay |

### 13.4 Notifications, E-mail and the Outbox

**Table 47: Notification requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| NTF-01 | No e-mail is sent inside a business transaction; the transaction writes an outbox event, the worker sends after commit | M | A failed transaction sends nothing |
| NTF-02 | E-mails are rendered in the recipient's language among the nine, from versioned templates; the template version is stored with the message | M | A French contact receives the French invoice e-mail |
| NTF-03 | Sending retries with backoff; failures end visibly in a dead state on the operations page; each message is sent at most once per idempotency key | M | Provider outage: messages wait and go out after recovery, once |
| NTF-04 | The e-mail provider is behind the mailer port (local log mailer in development) | M | Tests run with the fake mailer |
| NTF-05 | **[2.1, B12: S → M]** In-app notices (bell) are created for approvals, mentions, expiring documents, sign-ins from new devices, and failed jobs relevant to the person, and served as one feed (`GET /app/v1/workspaces/:wid/notifications`) that replaces the many lists the front end reads today | M | Mentioning Lina creates one notice for her |
| NTF-06 | E-mails carry no sensitive figure beyond what the recipient may see; invoice e-mails attach the PDF and the XML | M | Reminder e-mails show only the invoice number, amount due and due date |
| **NTF-07** **[2.1, B12]** | The feed carries these notice kinds, each created once per source record and person (dedupe key): approvals waiting, invoices overdue, documents expiring, tasks late and watched, low satisfaction ratings, follow-ups due, client-note and task mentions, client requests waiting, deals gone stale, quotes expiring within 3 days, supplier bills due within 7 days, action items from meeting pages | M | Running the daily jobs twice creates each notice once; each kind appears only for the people allowed to see its record |
| **NTF-08** **[2.1, D6]** | Notification preferences (per kind: bell, e-mail, off) are stored per person once server notifications exist | C | Turning e-mail off for stale deals stops those e-mails and keeps the bell notice |

---

## 14. Platform Console Backend

The console's behaviour is fully specified by the platform console cahier des charges and implemented in the front end. This section states what the server must add so that each of those requirements holds against a real database: storage, transactions, separation from company data, numbering and jobs. The console requirements keep their identifiers; the PLF requirements below are the server obligations behind them.

### 14.1 Mapping of Console Requirements to Server Work

**Table 48: Server work behind each console requirement family.**

| Console family | Server obligation | Requirements here |
|---|---|---|
| CUS customers and lifecycle | Lifecycle state machine; trial creation in one transaction with the workspace; access state view for the tenant side; scheduled read-only, suspension and purge (D-02) | PLF-01, PLF-02, JOB |
| PLA plans and prices | Plan versions immutable once used; the price of a subscription read from its version (BR-02) | PLF-03 |
| SUB subscriptions and seats | One active subscription per customer; proration by day, downgrade at renewal (BR-05); seat limit from the seat-usage view (BR-01) | PLF-04, WSP-09 |
| INV Nexora's invoices | NX series per calendar year (BR-03), separate AV and PF series; immutable after issue (BR-04); VAT per line and rate (BR-06); VAT on payment (BR-07); UBL file | PLF-05, PLF-06, TRX-03 |
| PAY payments and dunning | Transfers matched from Nexora's statements; provider port with signed, idempotent webhooks (SEC-07, SEC-08); dunning schedule (BR-08, D-03); refunds with two people above 1,000 MAD (BR-10); nightly reconciliation (PAY-09) | PLF-07 to PLF-11 |
| STF staff and sessions | Staff realm, mandatory second factor, **[2.1, D3]** 15 min idle and 8 h sessions (SEC-06), step-up, two-person approvals, new-device alerts | PLF-12, IAM |
| SUP support access | Support session approved inside the company workspace; `nx_support` role; duration 60 min by default, 24 h at most (BR-11); audited on both sides | PLF-13, TEN-10 |
| INC health and incidents | Health page fed by job, backup and error data; incident records with timeline | PLF-14 |
| AUD audit and data requests | Append-only console audit, 5 years (AUD-01 to AUD-07); export within 7 days; deletion with retention and two people | PLF-15, TRL, RET |
| MET metrics | MRR, ARR, churn and conversion computed from subscriptions and invoices, reconciled nightly | PLF-16 |
| CFG configuration | Retention, announcements, flags and seller identity, every change audited | PLF-17 |

### 14.2 Platform Requirements

**Table 49: Platform console backend requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| PLF-01 | Customer lifecycle transitions follow the console state machine; any other transition is refused by the server | M | Moving a cancelled customer to trial returns `INVALID_TRANSITION` |
| PLF-02 | Creating a trial creates, in one transaction, the customer, the workspace reference, the tenant workspace with default roles and settings, the owner's account and membership, and the trial subscription, through `provision_workspace` (Section 6.2) | M | A failure at any step leaves nothing behind |
| PLF-03 | Plan versions are immutable once a subscription uses them; a price change creates a new version | M | Updating a used version's price is refused by the database |
| PLF-04 | One active subscription per customer (partial unique index); proration and downgrade rules of BR-05 computed by `platform/billing.ts` | M | Downgrading below the seats in use returns `SEATS_IN_USE` |
| PLF-05 | Nexora invoices are numbered `NX-YYYY-NNNNN` per calendar year at issue, credit notes `AV-YYYY-NNNNN`, pro-formas `PF-YYYY-NNNNN` and data requests `DR-YYYY-NNNNN`, each from its own sequence | M | Concurrent renewals produce consecutive NX numbers |
| PLF-06 | Renewal invoices are created by a job on the renewal date, once per subscription and period (unique key), with the price of the subscription's plan version | M | Re-running the renewal job creates no second invoice |
| PLF-07 | Bank transfers to Nexora are matched from Nexora's own statements with the same import rules as FIN-01 to FIN-05 | M | Matching a transfer marks the NX invoice paid |
| PLF-08 | The payment provider is behind a port; its webhooks are verified by signature, recorded in an idempotent ledger, and applied once | S | Replaying a webhook returns success and changes nothing |
| PLF-09 | Dunning follows BR-08 and D-03 (transfers from the due date, one pause up to 15 days with a reason) and moves the customer's access state | M | The dunning job on day 7 sets the workspace read-only |
| PLF-10 | Refunds above 1,000 MAD VAT included need a second staff member's approval recorded in `two_person_approvals`; the approver differs from the requester | M | The same person approving returns `SAME_APPROVER` |
| PLF-11 | Nightly reconciliation compares invoices, payments, settlements and subscriptions and stores the run and its differences (PAY-09) | M | A missing payment appears as a difference the next morning |
| PLF-12 | Staff accounts live only in the staff realm; Table 23 of the console specification is enforced per request with step-up and two-person checks | M | Console permission matrix test passes for the seven roles |
| PLF-13 | A support session is requested by staff, approved by the company's administrator inside the workspace, runs under `nx_support` with read-only scope (write access deferred, OD-8), ends at expiry, and is recorded in both audit trails | M | An agent's request one second after expiry returns 401 |
| PLF-14 | The health page reads real data: job queue depth and dead jobs, last backup and restore test, error rates, slow queries | S | A dead job appears on the health page within a minute |
| PLF-15 | Data requests: exports produced within 7 days and available 7 days; deletions run only after two staff approvals and after the customer's retention periods, archiving the accounting records of Table 61 for 10 years | M | Deletion job test archives the accounting records and removes the rest |
| PLF-16 | Metrics (MRR, ARR, churn, trials, overdue) are computed on the server from subscriptions and invoices and reconcile with them nightly | M | MRR equals the sum of active subscriptions' monthly amounts |
| PLF-17 | Configuration changes (retention, announcements, flags, seller identity) are audited with before and after | M | Audit test |

---

## 15. Transactions, Consistency and Critical Flows

This section is the heart of the specification. It defines how the server keeps the data correct when two people act at the same instant, when a request is retried, when a process crashes halfway, and when a job runs twice.

### 15.1 Unit of Work

Every command runs in one database transaction opened by the application layer: set the tenant and principal, load and lock what the command changes, run the domain rules, write the changes, the audit events and the outbox events, commit. Nothing that leaves the database (e-mail, file generation, provider calls) happens inside the transaction; it is triggered by the outbox after commit. Transactions use `READ COMMITTED` with explicit row locks where a rule depends on other rows; a transaction that fails on a deadlock or serialization error is retried up to three times, which is safe because nothing outside the database has happened yet.

### 15.2 Gap-Free Numbering

Legal numbering requires that issued invoices follow each other without gap or duplicate within a series and fiscal year. A database `SEQUENCE` cannot guarantee this (a rolled-back transaction loses its value). The number is therefore taken from a row of `ops.document_sequences` identified by workspace, series and fiscal year:

1. In the issue transaction, after all checks have passed, the row is locked with `SELECT … FOR UPDATE` (created on first use with `INSERT … ON CONFLICT DO NOTHING`).
2. The number is formatted from its value; the value is incremented; the invoice is updated with the number.
3. The transaction commits. If anything fails after step 1, the rollback also restores the counter, so no number is lost.

The lock is held for milliseconds and serialises only issues of the same series and year in one workspace, which is acceptable for the volumes of Table 4. **[2.1]** The same mechanism numbers quotes when they are sent (B7), tasks per project (series `task:<project>`, WRK-12) and client requests (series `request`); tasks and requests need uniqueness rather than legal continuity, but sharing one mechanism keeps one code path.

### 15.3 Concurrency Rules

**Table 50: How each contended operation is protected.**

| Operation | Risk | Protection |
|---|---|---|
| Issue an invoice | Two issues take the same number | Sequence row locked `FOR UPDATE`; unique (workspace, number) as a backstop |
| Put hours or expenses on a draft | Two drafts bill the same hours | Selected rows locked `FOR UPDATE` in identifier order; a row already linked returns `ALREADY_ON_INVOICE`; partial unique index on active links as a backstop |
| Log time | A day exceeds 24 hours | Transaction-level advisory lock on (workspace, employee, date) while summing |
| Record payment, allocate a bank line | Over-allocation | Invoice rows locked in identifier order; allocations checked against the locked balance |
| Approve | Double approval, self-approval | Request row locked; check constraint on approver and `submitted_by`; state machine |
| Submit or approve leave | Two requests together exceed the balance | Advisory lock on (workspace, employee, leave type, year) while the balance is computed |
| Invite a member | Seats above the plan limit | Advisory lock on the workspace's seats; invited and active memberships both count |
| Fixed-price share, issue above a credit limit | Billing above the price; open balance above the limit | Project row, or client row, locked `FOR UPDATE` while the sum is computed |
| Draft a retainer month | Two invoices for one month | Partial unique index (project, retainer period) on non-void invoices |
| Edit a form | Lost update | `version` column compared on update (optimistic lock) |
| Start a timer | Two running timers | Partial unique index |
| Recurring and renewal jobs | Same period generated twice | Unique key (schedule, period); job idempotency key |
| Accept an invitation or single-use link | Used twice | `UPDATE … WHERE used_at IS NULL` returning one row |
| **[2.1]** Create a task, send a quote, log a client request | Two get the same number | Sequence row locked `FOR UPDATE`; unique (project, number) or (workspace, number) as a backstop |
| **[2.1]** Remove a sales stage | Deals left on a stage that no longer exists | Stage and its deals locked; deals moved and stage removed in one transaction |
| **[2.1]** Merge two clients | A record created for the removed client during the merge | Both client rows locked `FOR UPDATE` in identifier order; every child table updated in the same transaction |
| **[2.1]** Complete a repeating task, convert an action item, accept a client request, win a deal | The follow-up record created twice | Unique `next_task_id`, unique task link per action-item line, unique task per request, unique `project_id` per deal |
| **[2.1]** Create a cycle | Two overlapping cycles | Exclusion constraint per project |

Locks are always taken in the same order within a module (parent before children, rows in identifier order, sequence rows last) so that two commands cannot deadlock each other.

### 15.4 Invariants

These statements must be true at every commit. Each has a guard that makes a violation impossible or immediately visible.

**Table 51: Invariants of the Nexora data.**

| # | Invariant | Guard |
|---|---|---|
| 1 | No record references a record of another workspace | Composite foreign keys; row-level security |
| 2 | Issued numbers of a series and fiscal year are consecutive and unique | Sequence row lock; unique index; nightly check |
| 3 | An issued document's lines and totals never change | Frozen-row trigger |
| 4 | Stored totals equal the totals recomputed from lines | Domain computation; nightly check |
| 5 | A time entry or expense is on at most one non-void invoice | Partial unique index on active links; locked drafting |
| 6 | Approved hours keep the rates of their approval | Frozen columns after approval |
| 7 | Nobody approves their own request | Check constraint against `submitted_by`; engine rule |
| 8 | Allocations never exceed an invoice's balance or, in total, a payment's amount | Locked balance check; nightly check |
| 9 | A person's pending and approved leave never overlap | Exclusion constraint |
| 10 | A person has at most one running timer | Partial unique index |
| 11 | Nothing dated in a locked period changes | Domain check in every module; integration test |
| 12 | A workspace always has an active owner | Trigger on memberships |
| 13 | Audit events are never changed or removed before retention | Insert and read privileges only; trigger; seals (TRL-05) |
| 14 | Every journal export balances | Domain check before writing the file |
| 15 | The console never reads tenant business tables | No privilege for `nx_platform` |
| 16 **[2.1]** | A project with hours, invoices, quotes, expenses, bills, change orders or feedback is never deleted | Domain check (WRK-22); foreign keys without cascade from those tables |
| 17 **[2.1]** | Client history rows are never changed | Insert and read privileges only; frozen-row trigger |
| 18 **[2.1]** | No row references a client removed by a merge | Merge in one transaction; nightly orphan check |
| 19 **[2.1]** | Every task's status matches the group of its state | Domain rule; nightly check |

### 15.5 Critical Flows

**Approve hours.** Load the submitted entries and lock them; for each entry, resolve the approver and check the decision (`approvalDecision`); refuse own entries; for the final step, freeze the bill and cost rates in force on the entry's date (`entryBillRate`, `entryCostRate`); set status, approver and time; write decision rows, audit events and an outbox event for the summaries; commit; return a per-item result.

**Issue an invoice.** Check the idempotency key; load and lock the draft; check the period, identifiers, lines, exchange rate and approval rule; compute totals with the core function and compare with the draft; take the number (Section 15.2); write the parties' snapshot, number, fiscal year, issue time and author; freeze the linked entries and expenses; write the audit event and outbox events (generate PDF, generate UBL, refresh summaries); commit. After commit the worker generates the files, stores them with their hashes and records them on the invoice.

```
1. Idempotency key checked; draft locked FOR UPDATE
2. Checks: period open, identifiers, lines, exchange rate, approval
3. Totals recomputed by invoiceTotals; mismatch refuses
4. Sequence row locked; number taken; counter incremented
5. Snapshot, number, issue time written; hours and expenses frozen
6. Audit event and outbox events (PDF, UBL, summaries) written
7. COMMIT — or ROLLBACK of everything, counter included
   After commit, worker: PDF and UBL generated, stored with SHA-256, linked to the invoice
```

_Figure 5: Issuing an invoice: one transaction, then work after commit._

**Allocate a bank line.** Lock the bank line (must be unmatched) and the chosen invoices in identifier order; spread the amount with `allocate`; create the payment, allocations and invoice status changes; mark the line matched; audit; commit.

**Credit an invoice.** Lock the original; refuse credit notes and lines already credited; check the period for today; create the credit note with negated lines; issue it in the same transaction (credit series); release hours and expenses if asked; audit; commit.

**Move the lock date.** Lock the settings row; refuse a backward move without owner, reason and fresh second factor; write the history row and audit; commit. From the next transaction, every dated write checks the new date.

**Generate a recurring invoice.** For each due schedule (job, one workspace at a time): insert the run key (schedule, period) and stop if it exists; create the draft from the schedule's lines; advance the next run date; outbox event to notify the owner; commit.

**[2.1] Merge two clients.** Check the idempotency key; lock both clients in identifier order; apply the chosen values (`mergeClientValues`); move every linked row (contacts not already present, deals, follow-ups, projects, quotes, invoices, files, requests, bank matches, saved reports and views naming the client) to the kept client; remove the other client; write one history row and one audit event; commit.

**[2.1] Accept a client request.** Lock the request (must be new, snoozed or reopened); create the task (next task number) or, when out of scope, a draft change order; link it; set the status, decider and time; write the audit event and an outbox event that tells the portal contact; commit.

### 15.6 Failure Cases

**Table 52: Behaviour under failure.**

| Situation | Behaviour |
|---|---|
| The same command is sent twice (double click, retry after time-out) | The idempotency key returns the first response; no second number, payment or e-mail |
| Two people edit the same record | The second save receives `CONFLICT_STALE_VERSION` with the current version |
| The server crashes during a command | The transaction rolls back; nothing is half-written; the client retries with the same key |
| The worker crashes during a job | The lease expires; the job runs again; its handler is idempotent |
| The e-mail provider is down | Outbox events wait and retry with backoff; business actions are not affected |
| The database fails over during a transaction | The transaction fails and is retried by the client with its key |
| A bulk action partly fails | Each item has its own result; succeeded items are committed, failed items are reported |
| The clock of a server is wrong | Business dates use the database clock in the workspace time zone; servers are synchronised by NTP |

### 15.7 Transaction Requirements

**Table 53: Transaction and concurrency requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| TRX-01 | Every command runs in one transaction that includes its audit and outbox writes; no command writes outside it | M | Fault injection after the domain write and before commit leaves no trace |
| TRX-02 | Nothing external (e-mail, files, provider, DGI) is called inside a business transaction | M | Architecture test: the application layer cannot import external adapters |
| TRX-03 | Document numbers come from the locked sequence row of Section 15.2; never from `MAX()+1` or a database sequence | M | 50 concurrent issues and 10 forced rollbacks: numbers consecutive, no gap |
| TRX-04 | Commands that create a number, money movement, file or message require an idempotency key kept 24 hours. **[2.1]** The web application sends an `Idempotency-Key` header on these commands (front-end item F4, §21.4) | M | Same key and body returns the stored response; same key with another body returns `IDEMPOTENCY_MISMATCH` |
| TRX-05 | The outbox is written in the business transaction and relayed after commit with at-least-once delivery; handlers are idempotent | M | Killing the relay mid-batch and restarting delivers each event, handlers apply it once |
| TRX-06 | Editable records use optimistic locking on version. **[2.1]** The web application sends the record's version with each update and reloads the record on `CONFLICT_STALE_VERSION` (front-end item F5, §21.4) | M | Concurrent edit test |
| TRX-07 | Contended operations use the protections of Table 50; locks follow a fixed order | M | Concurrency test suite runs each operation from 20 parallel clients without deadlock or invariant break |
| TRX-08 | Deadlock and serialization failures are retried up to three times before an error is returned | S | Injected deadlock: the command succeeds on retry |
| TRX-09 | The invariants of Table 51 are checked nightly; a violation alerts the operator | S | A forced violation produces an alert |
| TRX-10 | Bulk commands report a result per item and never leave an item half-processed | M | Bulk approval with one invalid item |

---

## 16. Audit Trail

The audit trail is the proof of who did what. It must be complete (every state-changing action), trustworthy (no one can alter it, administrators and Nexora included) and useful (searchable by the people allowed to read it). The Architecture repository's best-effort audit is replaced entirely.

### 16.1 Three Trails

- **Workspace trail** (`audit.workspace_events`): every action inside a company, including those of support agents during an approved session. Readable by the company's owners and administrators under row-level security; never by the console.
- **Identity trail** (`audit.identity_events`): sign-in, failures, lockouts, sign-out, second-factor and reset events of all realms, which happen before a workspace is known (IAM-16). A person reads their own events; staff events are readable in the console.
- **Console trail** (`audit.console_events`): every staff action (AUD-01). Readable by staff according to the console permission matrix; exportable by platform owners with a fresh second factor (AUD-03, AUD-07).

An event records: time, actor principal and role, realm, action key, target type and identifier, a human label of the target, before and after values of the changed fields, reason when one is required, IP address, user agent, request and session identifiers, and for support sessions the session identifier.

### 16.2 What Is Audited

**Table 54: Audited event families.**

| Family | Events |
|---|---|
| Access (identity trail for sign-in events) | Sign-in, failure, lockout, sign-out, session revoked, second factor enrolled or reset, **[2.1]** passcode set or failed, invitation sent and accepted, membership role changed or disabled, portal access granted, used and revoked |
| Settings | Every settings change with the fields changed, approval rules, lock date, numbering formats, bank details, plan change, **[2.1]** sales stages changed |
| People | Employee created, status change, rate change, document added or removed, leave decided, review submitted |
| **[2.1]** Clients | Client deleted, restored, purged and merged; client file added or removed; CRM import run; shared list view created or removed |
| Money | Quote sent, accepted, declined; invoice issued, sent, voided, credited; payment recorded or reversed; reminder sent; bill approved and paid; expense approved and reimbursed; bank line matched or unmatched |
| Work | Hours approved, rejected, reopened; project closed; change order decided; milestone decided; **[2.1]** project deleted; task deleted, restored and purged; template saved and deleted; client request decided; cycle closed |
| Compliance | VAT period filed, journal exported, e-invoice status change |
| Sensitive reads | Data export, audit export, download of a sensitive file, cost report export, **[2.1]** client export |
| Platform | Every console action of the console specification (AUD-01) |
| System | Each job run that changes data, with its job identifier as actor |

### 16.3 Audit Requirements

**Table 55: Audit trail requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| TRL-01 | Audit events are written in the same transaction as the change they describe; if the event cannot be written, the change does not happen | M | Fault injection on the audit insert rolls back the command |
| TRL-02 | Application roles have `INSERT` and `SELECT` only on the trails of Table 15; a trigger rejects `UPDATE` and `DELETE` for every role except the retention function | M | Update and delete as `nx_app`, `nx_platform` and `nx_owner` all fail |
| TRL-03 | The actor always comes from the session or the job principal, never from the request | M | Covered by IAM-01 tests on audited commands |
| TRL-04 | Audit details never contain passwords, tokens, second-factor secrets or full bank numbers; personal fields are masked in before and after | M | A scan of the audit table finds no secret pattern |
| TRL-05 | A sealing job writes a row of `audit.seals` for each trail (and each workspace) every 5 minutes, holding the hash of the previous seal and of the new events in order, so that any later change is detectable | S | Altering an old event with database superuser rights makes the verification job report the break |
| TRL-06 | Events are kept at least 5 years (AUD-06, BR-14) and removed after that only by the retention function, in batches, itself audited | M | Events older than retention disappear; younger ones never do |
| TRL-07 | Owners and administrators search the workspace trail by actor, action, target and period with pagination; the console trail is filtered per AUD-03 | M | Search over 1 million events returns in under 1 s |
| TRL-08 | Every event of a support session is written to both trails with the session identifier | M | An agent's read appears in the company's trail |
| TRL-09 | Sensitive reads of Table 54 are audited | M | Downloading the full data export writes one event |

---

## 17. Background Jobs and Scheduling

Work that is slow, depends on the outside world, or happens at a date runs in the worker process. The job queue of the Architecture repository is kept for its design (leases, exponential backoff, dead state, zombie reaper) and rebuilt on PostgreSQL.

### 17.1 Queue and Scheduler

- **Queue.** Jobs are rows of `ops.jobs`. Workers claim due jobs with `SELECT … FOR UPDATE SKIP LOCKED`, set a lease, run the handler, and mark the job done, retried (backoff 1, 2, 4… minutes, capped at 60) or dead after its maximum attempts. Expired leases are reclaimed.
- **Scheduler.** `ops.schedules` lists the recurring jobs. One worker at a time holds a PostgreSQL advisory lock and enqueues due jobs. Daily jobs that depend on the company's local time run hourly and select the workspaces whose local time has just passed the job's hour.
- **Fairness.** Tenant jobs carry the workspace; at most one job of a given type runs per workspace at a time, and batch sizes are bounded, so a large company cannot delay the others.
- **Visibility.** Queue depth, oldest due job and dead jobs are shown on the operations health page (PLF-14); a dead job can be retried after a fix.

### 17.2 Job Catalogue

**Table 56: Jobs of the backend.**

| Job | When | Idempotency and rule |
|---|---|---|
| `outbox.relay` | Continuous | Event marked published after its handler succeeds |
| `email.send` | On event | One message per event and recipient; provider message id stored |
| `invoice.render_pdf`, `invoice.build_ubl` | After issue | Skips when the file already exists with the same hash |
| `summaries.refresh` | On event and nightly | Recomputes affected rows; full rebuild nightly |
| `reminders.send` | Daily, 08:00 local | One reminder per invoice and level (unique) |
| `recurring.generate` | Daily, 06:00 local | Unique (schedule, period) |
| `timers.stop_stale` | Hourly | Stops timers running over 12 hours once |
| `documents.expiry` | Daily | One notice per document and threshold |
| `portal.expire`, `invitations.expire` | Daily | Status change only when still active or pending |
| `leave.year_end` | Yearly, first day of the leave year | Carry-over adjustments once per person, type and year |
| `exports.build`, `exports.expire` | On request; daily | Archive built once per request; links expire after 7 days |
| `workspace.delete` | After approval and retention | Archives the accounting records, then deletes in batches; resumable |
| **[2.1]** `bins.purge` | Daily | Purges clients and tasks deleted more than 30 days ago, with their files; audited once per record |
| **[2.1]** `followups.due` | Daily, 08:00 local | One notice per follow-up and day (dedupe key) |
| **[2.1]** `deals.stale` | Daily | One notice per deal and stale period, for its owner |
| **[2.1]** `quotes.expiring` | Daily | One notice per sent quote whose validity ends within 3 days |
| **[2.1]** `bills.due` | Daily | One notice per approved bill with a balance due within 7 days |
| **[2.1]** `requests.unsnooze` | Daily | Returns snoozed client requests whose date has come to the waiting list, once |
| **[2.1]** `cycles.roll` | Daily | Moves cycles from upcoming to running and running to ended on their dates; never closes a cycle |
| `platform.renewals` | Daily | Unique (subscription, period) |
| `platform.dunning` | Daily | One step per invoice and day; moves access state |
| `platform.trials` | Daily | End, read-only, suspension and purge dates of D-02 |
| `platform.reconciliation` | Nightly | One run per day; differences stored |
| `consistency.check` | Nightly | Invariants of Table 51; alerts on violation |
| `audit.seal`, `audit.verify` | Every 5 min; daily | Seals new events; verifies chains |
| `retention.purge` | Monthly | Removes data past retention (Section 19); audited |
| `sessions.purge`, `idempotency.purge` | Daily; hourly | Removes expired rows only |

### 17.3 Job Requirements

**Table 57: Background job requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| JOB-01 | The queue runs on PostgreSQL with `SKIP LOCKED` claims, leases, backoff and a dead state; no second store is needed | M | Two workers never run the same job; a killed worker's job is reclaimed after its lease |
| JOB-02 | Every handler is idempotent: running it twice with the same payload has the effect of running it once | M | Each handler has a replay test |
| JOB-03 | Jobs that touch tenant data set the workspace and run under the system principal; their changes are audited | M | Audit events of a job show `system:<job>` as actor |
| JOB-04 | One scheduler at a time enqueues recurring jobs (advisory lock); a restart never enqueues a run twice | M | Two worker instances started together enqueue each due run once |
| JOB-05 | Local-time jobs run at the workspace's local hour, including across daylight-saving changes | S | A workspace in Casablanca receives reminders at 08:00 local time on the days before and after the Ramadan time change |
| JOB-06 | At most one job of a type runs per workspace at a time; batches are bounded | S | A 500-person workspace's summary refresh does not delay a small workspace's reminders beyond 1 minute |
| JOB-07 | Queue depth, age of the oldest due job and dead jobs are measured and alerted | M | A dead job raises an alert within 5 minutes |
| JOB-08 | The worker shuts down gracefully: it stops claiming, finishes or releases current jobs within 30 seconds | S | Deploying during a job does not lose or duplicate it |

---

## 18. Security

Security requirements of the identity, tenancy, authorization and audit sections are not repeated here. This section covers the rest of the attack surface and maps the design to the OWASP Top 10 (2025). **[2.1]** §18.4 adds the security plan by OWASP area that came out of the front-end audit, with the check and the delivery phase of each item.

### 18.1 Threat Model Summary

**Table 58: Main threats and their answers.**

| Threat | Example | Answer |
|---|---|---|
| A company reads another's data | Changing an identifier in a request | TEN barriers, composite keys, isolation suite |
| An employee raises their own access | Sending a role or approver in a request | IAM-01, AUZ checks per request |
| An insider at Nexora browses company data | Querying tenant tables from the console | No privilege (SEC-02), support sessions only, dual audit |
| Stolen session or password | Phishing, reused password | Argon2id, breach list, second factor, refresh reuse detection, new-device alerts |
| Tampering with money records | Editing an issued invoice in the database | Frozen-row triggers, audit chain, nightly checks |
| Injection | SQL in a search field, formulas in a CSV export | Parameterised queries only; CSV cells escaped |
| Malicious upload | Executable disguised as a PDF | Type sniffing, size limits, malware scan, private bucket |
| **[2.1]** Cross-site request forgery | A page on another site posts to Nexora with the user's cookies | `SameSite=Lax`, `X-XSRF-TOKEN` double submit, `Origin` check (D1) |
| **[2.1]** Dangerous links | A `javascript:` or `data:` address saved as a website or task link | http/https only on every URL field (REL-12, WRK-14) |
| Supply chain | Compromised npm package | Lock file, audit in CI, pinned versions, minimal dependencies |
| Data loss | Disk failure, bad migration, ransomware | Point-in-time recovery, encrypted off-site backups, restore tests |

### 18.2 OWASP Top 10 Mapping

**Table 59: OWASP Top 10 (2025) and where the design answers each.**

| Risk | Answer in this specification |
|---|---|
| Broken access control | AUZ (deny by default, per request), TEN (three barriers), AUZ-07 field shaping, **[2.1]** CSRF protection (D1, SCR-16) |
| Cryptographic failures | TLS 1.2+ (1.3 preferred), Argon2id, application-level encryption of CIN, CNSS and bank accounts, encrypted backups |
| Injection | Typed query builder with parameters; no string-built SQL; schema validation; CSV escaping; **[2.1]** http/https-only addresses |
| Insecure design | Threat model, invariants, state machines, two-person rules, this review process |
| Security misconfiguration | Boot checks of configuration (ARC-04), security headers, no debug endpoints in production, **[2.1]** demonstration mode refused in production |
| Vulnerable and outdated components, supply chain | Dependency audit in CI, Renovate updates, lock file integrity |
| Identification and authentication failures | IAM-02 to IAM-19 |
| Software and data integrity failures | Signed webhooks, immutable documents with hashes, audit chain, reproducible builds |
| Logging and monitoring failures | TRL, QAL-07 to QAL-10, alerts on access-control failures |
| Mishandling of exceptional conditions | Error codes without internal detail; transactions roll back fully; jobs end in a visible dead state |

### 18.3 Security Requirements

**Table 60: Security requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| SCR-01 | All traffic uses TLS 1.2 or later (1.3 preferred) with HSTS; the database and object storage accept only encrypted connections | M | TLS scan grade A; plain connection to the database refused |
| SCR-02 | All SQL is parameterised through the query builder; a lint rule forbids string-built SQL | M | Lint rule active in CI; injection test suite on search fields passes |
| SCR-03 | Every input is validated against a schema with allowed values, lengths and formats; unknown fields are rejected; **[2.1]** web addresses accept http and https only | M | Fuzz test of every command finds no 500 response |
| SCR-04 | Errors returned to clients carry a code and a request identifier, never a stack trace, SQL or internal name | M | Forced database error returns `INTERNAL` with an identifier only |
| SCR-05 | Rate limits protect sign-in, password reset, invitation, export and upload endpoints, and a global per-IP limit protects the rest (starting values in §18.4) | M | Load test triggers 429 at the configured thresholds |
| SCR-06 | Secrets (session keys, encryption keys, provider keys, database passwords) are held in a secret store or Docker secrets, never in the repository or image; they are rotated yearly and on staff departure, with a different set per environment | M | Secret scan of the repository and image finds none |
| SCR-07 | CIN, CNSS numbers, employee and supplier bank accounts and second-factor secrets are encrypted with AES-256-GCM by the application, with keys from the secret store and a key identifier per value for rotation | M | Database dump shows ciphertext; key rotation re-encrypts without downtime |
| SCR-08 | CSV and spreadsheet exports escape cells starting with `=`, `+`, `-`, `@` | M | Exporting a client named `=HYPERLINK(…)` produces inert text |
| SCR-09 | Outgoing requests (e-mail provider, payment provider, DGI) go only to an allow-list of hosts | M | A configured URL outside the list is refused at boot |
| SCR-10 | Dependencies are audited on every build (`npm audit --omit=dev`); high findings fail the build; updates are proposed weekly | M | A known vulnerable package fails CI |
| SCR-11 | The web process runs as a non-root user in a minimal image; the database is not reachable from the internet | M | Container scan and network test |
| SCR-12 | Backups are encrypted and stored off-site in a different provider or region | M | Restore test uses the off-site copy |
| SCR-13 | An external penetration test of the company and console surfaces is passed before the first paying company (console SEC-15) | M | Report with no open high finding |
| SCR-14 | Access-control failures, lockouts and unusual exports raise alerts | S | Twenty 403 responses from one session in a minute raise one alert |
| SCR-15 | Exports of the user directory, the audit trail and full workspace data carry a watermark with the requester and the time (console SEC-14) | S | The exported file shows the requester's name and the export time |
| **SCR-16** **[2.1, D1]** | State-changing requests are refused unless the `X-XSRF-TOKEN` header equals the session's `XSRF-TOKEN` cookie and the `Origin` header is the application's origin; the API is served on the application's own origin, so no cross-origin access is allowed | M | A form posted from another origin with valid cookies returns 403 and writes nothing |
| **SCR-17** **[2.1]** | Images uploaded as logo or avatar are re-encoded and their EXIF data removed before storage | S | A JPEG with GPS data is stored without it |
| **SCR-18** **[2.1]** | An OWASP ZAP baseline scan runs on every staging deployment; high findings block the release | S | The release pipeline shows the scan report |

### 18.4 Security Plan by OWASP Area **[2.1]**

This plan came out of the front-end audit of October 2026. It names, for each area, what the server builds, how it is checked and the delivery phase of §21.2. Where a number here and a requirement above differ, the requirement wins.

**Table 60b: Security plan by OWASP area.**

| Area | What the server builds | How it is checked | Phase |
|---|---|---|---|
| A01 Access control and isolation | Session → user → membership of the workspace in the path, on every request; every query filtered by the workspace; row-level security as a second wall; deny by default with one rights table shared with the front end; record rules (own records, no self-approval, client scope); field shaping (costs, salaries, margins left out) | Cross-company suite calls every endpoint with another company's identifiers and expects 404; permission matrix per role; response snapshots per role | B1a, B1b |
| A01/A05 CSRF, CORS and cookies | Same origin through `API_PROXY_TARGET`; `SameSite=Lax`; `X-XSRF-TOKEN` double submit and `Origin` check on every write (SCR-16) | Forged cross-origin post refused | B1b |
| A07 Authentication | Argon2id; 12-character minimum with breach check (IAM-03); lockout (IAM-04); TOTP and recovery codes for staff, owners, administrators and accountants (IAM-05); new session identifier at sign-in and on privilege change; idle and absolute limits (Table 6); refresh rotation with reuse detection; "my devices" list; same answer whether an e-mail exists or not | IAM tests | B1b |
| A03 Input validation and injection | One schema per endpoint built from the contract types, with length limits on every text; parameterised queries only; http/https-only addresses; CSV and Excel import parsed on the server with row and size limits; exports neutralise `= + - @`; PDFs and UBL built with escaping | Fuzz tests; injection suite | B1a onwards |
| S-03 Files | Content type checked from the bytes; SVG and HTML refused; malware scan before download; private bucket and 5-minute signed links from the storage domain; images re-encoded without EXIF; quotas per plan (DOC-02, SCR-17) | Upload test set (executable renamed, SVG, EICAR, oversize) | B1e |
| A02 Sensitive data | TLS; encrypted disks and backups; field encryption for bank details, CIN and salaries (SCR-07); secrets in a secret store per environment (SCR-06); Law 09-08 obligations (§19) | Dump shows ciphertext | B1a, B1c |
| A09 Logging, monitoring, audit | Audit of sign-ins, refused permissions, exports, imports, deletes, settings, money writes and support access (Table 54); append-only trail with seals; central logs with the request identifier and no secrets; alerts on many failed sign-ins, unusual exports, spikes of cross-company 404 and of 429 | Audit tests; alert drill | B1a onwards |
| Rate limits and abuse | Starting limits, tuned on staging: sign-in, reset and second factor 5 failures then lockout (IAM-04) and 10 per 15 min per IP; normal use 1,000 per 15 min per person; exports and imports 10 per hour per company; uploads 60 per hour per person plus the plan quota; console 300 per 15 min per staff member | Load test returns 429 at the limits | B1b |
| A05, A06, A08 Configuration and supply chain | `npm audit` in CI; Renovate; lock files; CI actions pinned to a commit; an SBOM per release; security headers on the API; errors as codes only; demonstration mode refused in production | CI | B1a |
| A10 Server-side request forgery | Outgoing hosts from an allow-list (SCR-09); when customer webhooks come (public-API phase), https only, private address ranges refused after DNS resolution, short time-outs, no redirects, signed payloads | Allow-list test | B1e, later |
| A04 Business rules and integrity | Idempotency keys on money writes (TRX-04); gap-free numbering (TRX-03); lock date on the server (FIN-14); optimistic locking (TRX-06); approval rules on the server (APR); merges and deletes in one transaction (REL-18, WRK-22) | Concurrency and replay suites | B1c, B1d |
| Security testing | Every pull request: rights tests, the cross-company suite, dependency scan. Every staging deployment: ZAP baseline (SCR-18). Before launch: external penetration test (SCR-13). Every quarter: review of this plan, of access rights and of secret rotation | Reports kept | All |

---

## 19. Privacy, Retention and Compliance

Nexora holds two kinds of personal data. For its own customers (the companies and their administrators) Nexora decides why and how the data is used. For the data a company puts in Nexora (its employees, its clients' contacts) Nexora processes on the company's instructions. Law 09-08 on the protection of personal data applies to both; the GDPR applies when a company or person is in the European Union. This section is not legal advice; the items marked "to confirm" are validated with counsel and the accountant before the first paying company.

### 19.1 Retention Periods

**Table 61: Retention of each kind of record.**

| Record | Kept | Basis and behaviour |
|---|---|---|
| Accounting records: issued invoices and credit notes with their PDF and UBL files, payments and allocations, supplier bills and their files, expense receipts, VAT periods, journal exports; Nexora's own invoices | 10 years after the end of the financial year | BR-13; moved to the archive schema when the workspace is deleted, readable only for legal requests |
| Audit events (all three trails) | 5 years at least | AUD-06, BR-14 |
| Staff and member sessions | 1 year | D-07 |
| Support requests and sessions | 3 years | D-07 |
| Ended trial without a plan | Read-only 7 days, suspended, then data kept 30 days | D-02 |
| Workspace after a deletion request | 30 days, then deleted except accounting records | D-07, AUD-05 |
| Data exports | 7 days | AUD-04 |
| **[2.1]** Deleted clients and tasks (bin) | 30 days, then purged with their files | REL-17, WRK-20 |
| **[2.1]** Client history | As long as the client exists; removed with a purged client | REL-16 |
| **[2.1]** Import runs | 1 year | REL-21 |
| Employee personal data after departure | Per the company's policy; default 5 years | To confirm with counsel (labour and social-security rules) |
| Sign-in tokens, idempotency keys | Until expiry, then 30 days and 24 hours | Operations only |
| E-mail message bodies | 1 year; metadata 3 years | Proof of sending |
| Backups | 35 days rolling, point-in-time 7 days | Deleted data leaves the backups within 35 days |

### 19.2 Privacy Requirements

**Table 62: Privacy, retention and compliance requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| RET-01 | Retention periods of Table 61 are configuration of the platform, applied by the retention job, and shown on the console's data requests page | M | Changing the audit retention below 5 years is refused |
| RET-02 | Deleting a workspace removes every tenant record and file except the accounting records of Table 61, which the deletion job first copies with their files and hashes to the archive schema; the frozen-row triggers allow that delete only inside the archive step | M | After deletion, every accounting record of the reference data set is in archive with an equal hash, nothing else of the workspace remains, and only `nx_dataops` can read it |
| RET-03 | A person's access request is answered with an export of their personal data across the workspace; an erasure request removes or anonymises personal fields except where retention requires keeping them, and records why. **[2.1, D6]** A member can ask for both from their profile: "download my data" and "delete my account", with 14 days to change their mind | M | Erasing a former employee keeps their approved hours with an anonymised name; an account deletion requested today can be cancelled until day 14 |
| RET-04 | Only the fields the features need are collected; the CIN, CNSS number and salary are optional and used only for payroll inputs | M | A company can use every feature except payroll inputs without them |
| RET-05 | Personal data never appears in application logs, metrics labels or error reports | M | Log scan for e-mail addresses and identifiers finds none |
| RET-06 | Hosting region and sub-processors (hosting, e-mail, storage) are listed and published; a change is announced to customers in advance | M | The list is shown in the console configuration |
| RET-07 | A personal-data breach is detected, assessed and reported to affected companies without undue delay; the procedure is written and tested once a year | S | Tabletop exercise recorded |
| RET-08 | The declaration to the CNDP (Law 09-08) and the processor terms for customers are completed before the first paying company | M | To confirm with counsel; documents on file |
| RET-09 | Invoices meet Moroccan mentions (seller and buyer ICE, IF, RC, VAT per rate, totals, numbering) and are kept in their issued form | M | To confirm with the accountant; sample invoices reviewed |

---

## 20. Quality, Operations and Testing

### 20.1 Non-Functional and Operations Requirements

**Table 63: Quality and operations requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| QAL-01 | With the data set of Table 4, list queries answer in under 300 ms, record pages in under 200 ms and commands in under 500 ms at the 95th percentile | M | Load test report at 50 requests per second |
| QAL-02 | Reports and exports answer in under 2 s or run as jobs that return a file | M | Load test of the 12-month profitability and VAT reports |
| QAL-03 | Monthly availability of 99.5% for the web application (console NFR-07), with planned maintenance announced 48 hours ahead | S | Uptime monitoring report |
| QAL-04 | Recovery point within 15 minutes (write-ahead log archiving), recovery time within 4 hours; a restore is carried out and timed every month (console NFR-08) | M | Restore log on the health page |
| QAL-05 | Health endpoints: liveness (process up) and readiness (database, storage reachable, migrations current) | M | Readiness fails when the database is down |
| QAL-06 | Database connections are pooled (at most 20 per process; a pooler in transaction mode when more processes run); every unit of work uses `SET LOCAL` so pooling cannot leak settings | M | Pool exhaustion test returns 503 quickly, not a hang |
| QAL-07 | Logs are structured JSON with time, level, request identifier, workspace identifier, principal identifier and route; no personal data or secrets | M | Log sample review |
| QAL-08 | Metrics per route (rate, errors, duration), database pool, job queue, outbox lag, and business counters (invoices issued, payments recorded) | M | Dashboard shows each |
| QAL-09 | Server errors are reported with the request identifier to an error tracker; alerts go to the owner for errors, dead jobs, failed backups and invariant violations | M | An injected error appears in the tracker with its identifier |
| QAL-10 | Tracing with OpenTelemetry for requests and jobs | C | Trace of an invoice issue shows the database spans |
| QAL-11 | Three environments: development (demonstration data), staging (release candidates, full test suites, provider sandboxes) and production (real data, restricted access) | M | Staging deploy precedes every production deploy |
| QAL-12 | Deployments run migrations first, then roll the web and worker processes without downtime (expand and contract) | M | A deployment during a load test produces no failed request |
| QAL-13 | Graceful shutdown: the web process stops accepting, finishes requests within 20 s; the worker follows JOB-08 | S | Rolling restart test |

### 20.2 Test Strategy

Tests are the evidence that the requirements hold; documents are not. The pyramid follows the code: most tests on the domain rules (already written), integration tests against a real PostgreSQL started in a container, and a small number of end-to-end scenarios.

**Table 64: Test suites of the backend.**

| Suite | What it proves | Requirements |
|---|---|---|
| Core rules | **[2.1]** The rule tests of the 62 rule files (part of the front end's 869 tests) pass unchanged in `packages/core` | ARC-03 |
| Contract | Each front-end API module's tests run against the server instead of the browser store | MIG-03 |
| Tenancy guard | SQL filters, route chain, row-level security on every tenant table | TEN-04, TEN-07 |
| Isolation | Two identical workspaces: nothing of one is reachable from the other, for every query and command | TEN-08 |
| Database privileges | Each role can do exactly what Table 15 allows | DAT-02, TEN-10 |
| Permission matrix | Each default role and staff role against every command and query | AUZ-02, AUZ-13 |
| Concurrency | Contended operations of Table 50 from 20 parallel clients | TRX-03, TRX-07 |
| Idempotency and replay | Same key twice; every job and outbox handler replayed | TRX-04, TRX-05, JOB-02 |
| Money properties | Random documents: totals, VAT, withholding, allocations exact to the centime; **[2.1]** centimes to JSON and back | DAT-05, DAT-06, SAL-15 |
| Audit | Every command writes its event; tampering is refused or detected | TRL-01, TRL-02, TRL-05 |
| Migrations | All migrations on an empty and a seeded database; down-time free deploy | DAT-14, DAT-15 |
| Security | Fuzzing of inputs, injection, upload type checks, rate limits, **[2.1]** CSRF and ZAP baseline | SCR |
| Load | Table 4 data set at 50 requests per second | QAL-01, QAL-02 |
| Restore | Monthly restore from the off-site backup, timed | QAL-04 |

### 20.3 Reference Scenario

The reference scenario runs end to end against the server in staging, with fixed data and expected values stored in the scenario file. It exercises every actor.

1. Staff (sales) create a trial for Atlas Consulting; the owner Alex receives the invitation and sets a password and a second factor.
2. Alex completes the company identity (ICE, IF, RC), chooses the VAT regime on payments, and invites Karim (manager), Lina (accountant) and Yassine (employee). **[2.1]** Lina must enrol a second factor before her first page (IAM-05).
3. Karim creates the client Helio Energy with its ICE, an hourly project with Yassine as member, and a milestone needing client approval; he grants portal access to Helio's contact.
4. Yassine runs a 50-minute timer (saved as 1.00 hour), logs the rest of his week in quarter hours, and submits. He cannot approve his own week.
5. Karim approves; the entries keep the rates in force that week. Alex then raises Yassine's rate from next month; the approved hours do not change.
6. Lina drafts an invoice from the approved hours; a second draft from the same hours is refused. She issues it: number `INV-2026-001`; the PDF and UBL files are stored with their hashes.
7. Fifty concurrent issues of test drafts produce consecutive numbers without gap.
8. Lina imports a bank statement that pays part of the invoice, confirms the match, and the invoice shows partly paid; the reminder job sends level 1 three days after the due date, once.
9. Lina credits one line with release of its hours: `CN-2026-001`; those hours appear again as unbilled.
10. Alex locks the month; a time entry in that month is refused for everyone.
11. Lina computes the VAT return of the month under the payment regime and exports the CGNC journal; debits equal credits and a second export has the same hash.
12. Helio's contact signs in to the portal **[2.1]** with an e-mail link, sees only Helio's project and invoice, accepts a quote and approves the milestone, **[2.1]** and sends a request that Karim accepts: one task `HEL#n` is created and the contact sees the request move.
13. Staff (support) request a support session; Alex approves it for 60 minutes read-only; the agent can read and cannot write; the session ends at expiry; both trails show it.
14. The platform renews the subscription and issues an NX invoice; dunning runs on a simulated unpaid transfer and sets the workspace read-only on day 7; payment restores access.
15. Alex exports all data, then requests deletion; after the retention delay the workspace is gone except its accounting records.
16. **[2.1]** Karim imports 20 leads from a CSV file with 2 bad rows (18 created, 2 reported), converts one lead with a first deal, moves the deal to won, and creates its project once; he merges two duplicate clients, and no record points at the removed one.
17. **[2.1]** Karim tries to delete Helio's project: refused with `PROJECT_HAS_HISTORY`; he closes it instead.

### 20.4 Testing Requirements

**Table 65: Testing requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| TST-01 | The suites of Table 64 run in CI; a red suite blocks the merge; the tests, not documents, are the evidence of conformity | M | CI configuration and run history |
| TST-02 | Integration tests use a real PostgreSQL of the production major version, with all migrations applied | M | Test container image matches production version |
| TST-03 | Every fixed defect gets a regression test that fails before the fix | M | Pull-request checklist |
| TST-04 | The reference scenario passes in staging before each release | M | Scenario report attached to the release |
| TST-05 | Test coverage of the application and domain layers is at least 85% of lines, and 100% of state-machine transitions | S | Coverage report |

---

## 21. Migration from Demonstration Mode and Delivery Plan

The screens do not change. Each API module of the web application switches from the browser store to the server when its server side passes its contract tests. Until then it keeps working in demonstration mode, so the product is never broken during the build.

### 21.1 Migration Requirements

**Table 66: Migration requirements.**

| ID | Requirement | Pri. | Acceptance criterion |
|---|---|---|---|
| MIG-01 | Each API module has a server mode and a demonstration mode, chosen per module by configuration; production builds refuse demonstration mode (existing rule) | M | Switching one module to server mode leaves the others in demonstration mode and the pages working |
| MIG-02 | In server mode, an API module keeps its function names, signatures and error codes; pages are unchanged | M | No page file changes in the pull request that switches a module |
| MIG-03 | The tests of each API module run in both modes (contract tests) | M | The same test file passes against the store and against the server |
| MIG-04 | The demonstration data becomes the seed of demonstration workspaces on the server (`is_demo`) | S | A new demonstration workspace shows the same figures as the browser demonstration |
| MIG-05 | No browser data is migrated to production; real companies start empty and import their clients, employees and projects from CSV or spreadsheet files | M | Import of 500 clients with validation report |
| MIG-06 | The order of switching follows dependencies: identity and workspace, people, relations, work, time and approvals, sales, purchases, finance, analytics, portal, console | S | Release plan follows the order |
| **MIG-07** **[2.1]** | The front-end items of §21.4 are delivered in the web repository before the phase that needs them | M | Each phase's exit gate lists its front-end items as merged |

### 21.2 Phases and Exit Gates

The phases refine Lot B of the repository plan. The effort is indicative for one developer; it includes tests and documentation, and a contingency of 25% is added at the end because estimates of new work are always optimistic. **[2.1]** Version 2.1 adds about 3 weeks for the 24 features built after the 2.0 baseline and the identity items of the audit.

**Table 67: Delivery phases.**

| Phase | Content | Weeks | Exit gate |
|---|---|---|---|
| B1a | **[2.1]** Server repository (`Nexora-Backend`), `packages/core` with the CI check against the web repository, server skeleton from the Architecture repository, PostgreSQL schemas and roles, migrations, unit of work, audit, outbox, job queue, CI with the guard suites | 3 | Guard, privilege and audit suites green on an empty module |
| B1b | Identity, sessions, second factor, workspaces, memberships, roles, permission engine, tenancy barriers, **[2.1]** passcode, step-up, CSRF, session list and administrator revoke | 2 | Isolation and permission suites green; sign-in works end to end |
| B1c | Settings, people, relations, work, time, timers, approvals, **[2.1]** with the 12 CRM features (REL-11 to REL-22) and the 12 work features (WRK-12 to WRK-22) | **6** | Contract tests of these modules green; scenario steps 1 to 5, 16 and 17 |
| B1d | Quotes, invoices, numbering, payments, reminders, recurring, purchases, expenses, bank import, journal, VAT, UBL files | 4 | Concurrency and money suites green; scenario steps 6 to 11 |
| B1e | Analytics summaries, inbox, files, notifications, portal, **[2.1]** notice feed and catalogue, mentions, portal e-mail link, global search | **4** | Scenario step 12; load test of lists and reports |
| B1f | Platform console backend, support sessions, data requests | 3 | Console permission suite; scenario steps 13 to 15 |
| B2 | Real e-mail, payment provider port, backups and restore, monitoring, staging and production, load test at full capacity | 3 | Restore timed; QAL-01 met; first real trial |
| B3 | Key rotation, alerting, IP allow-list option, external penetration test and fixes | 2 | No open high finding; release criteria met |
| | **Subtotal** | **27** | (2.0: 24) |
| | **With 25% contingency** | **about 34** | (2.0: 30) |

### 21.3 Release Criteria

The first paying company may use the server when: every Must requirement of this document is met or formally waived by the owner with a reason; the test suites of Table 64 are green; the reference scenario passes in staging; a restore has been carried out from the off-site backup; the external penetration test has no open high finding; and the compliance items marked "to confirm" have written confirmation.

### 21.4 Front-End Items the Server Needs **[2.1]**

These are changes to the web application (`Nexora-Saas`), found by reading this document against its code. They are small, and each must be merged before the phase named (MIG-07).

**Table 67b: Front-end items.**

| # | Requirement | Gap in the front end today | Pri. | Before phase |
|---|---|---|---|---|
| F1 | SAL-02, SAL-06, SAL-26: quotes and invoices follow the approval rule | Settings sets a rule for quotes and invoices, but nothing applies it: no "pending approval" state and no approver | M | B1d |
| F2 | `approval_rules` subject *bill* | Supplier bills are reviewed, but "bill" is not an approval subject in Settings (one or two steps, threshold) | S | B1d |
| F3 | IAM-06: fresh second factor for sensitive actions | No step-up screen (`STEP_UP_REQUIRED`) before changing the company bank details, exporting all data, deleting the workspace, transferring ownership | M | B1b |
| F4 | TRX-04: idempotency key | The API helpers send no `Idempotency-Key` on commands that create a number, money or a file | M | B1d |
| F5 | DAT-11, TRX-06: optimistic locking | Updates do not send the record's `version`; no screen reloads the record on `CONFLICT_STALE_VERSION` | M | B1c |
| F6 | IAM-12: portal sign-in by e-mail link | The sign-in page has no "send me a link" path for client contacts | M | B1e |
| F7 | §8.2 point 5, IAM-19: sessions | No "my devices" list in the profile, and no way for an administrator to sign a member out | S | B1b |
| F8 | IAM-14, AUZ-11: owner rules | No "transfer ownership" action; demoting the last owner has no clear message | S | B1b |
| F9 | B9: no API keys or webhooks in v1 | The Developer page (keys and webhooks) shows in production | S | B1a |
| F10 | ARC-08, Annex F: one error catalogue | The catalogue lacks the keys Annex F marks "to add" | M | B1a |
| F11 | SCR-16: CSRF | The HTTP client sends no `X-XSRF-TOKEN` header (axios `xsrfCookieName` / `xsrfHeaderName`) | M | B1b |
| F12 | NTF-05: one notice feed | The bell builds its list from about 15 full lists; it must read the one feed | M | B1e |

---

## 22. Risks, Dependencies and Open Decisions

### 22.1 Risks

**Table 68: Main risks and their treatment.**

| Risk | Level | Treatment |
|---|---|---|
| One developer carries the whole build and operation | High | Simple architecture, managed database, automated tests and alerts, written runbooks; contingency in the plan |
| A tenant leak through a missed filter | High | Three barriers, isolation suite, external test |
| Numbering or money error reaching a real invoice | High | Locked sequences, frozen rows, property tests, nightly checks, accountant review of sample documents |
| Rules drift between front end and server | Medium | **[2.1]** One `packages/core` used by both; until the web application imports the package, a CI check compares the rule files of the two repositories |
| Underestimated effort | Medium | Phases with exit gates; scope cut by priority (S and C first) rather than quality |
| DGI e-invoicing specification published late or different | Medium | Port and fake adapter; UBL generation independent of transport |
| Performance of reports on large workspaces | Medium | Summary tables, jobs for heavy reports, load test before release |
| Legal requirements misunderstood | Medium | Items "to confirm" validated in writing before release |
| **[2.1]** The front end keeps growing while the server is built | Medium | Every new front-end feature updates the API contract and, when it adds data, this document (Annex E) in the same pull request |

### 22.2 Dependencies

- A hosting provider with managed PostgreSQL 16 (point-in-time recovery) or a self-hosted equivalent, and S3-compatible storage.
- An e-mail provider with a Moroccan and European deliverability record.
- The accountant's written confirmation of VAT regime handling, invoice mentions, cancellation and credit-note practice, and retention.
- Counsel's confirmation of the Law 09-08 declaration, processor terms and employee-data retention.
- An external firm for the penetration test.

### 22.3 Open Decisions

**Table 69: Open decisions.**

| ID | Question | Proposal |
|---|---|---|
| OD-1 | May an issued, unsent, unpaid invoice be cancelled (number kept, marked cancelled), or must every correction use a credit note? | Keep the front end's rule (SAL-22) and ask the accountant to confirm in writing |
| OD-2 | How long are former employees' personal fields kept? | 5 years by default, configurable per company; confirm with counsel |
| OD-3 | Hosting region: Morocco or the European Union? | EU region of a major provider with a Moroccan option reviewed yearly; confirm transfer rules under Law 09-08 |
| OD-4 | E-mail provider | Choose on deliverability tests in phase B2; the port keeps it replaceable |
| OD-5 | Malware scanning of uploads (DOC-06) | Open-source scanner in the worker in phase B2 |
| OD-6 | Managed or self-hosted PostgreSQL | Managed, to keep point-in-time recovery and backups off one person's hands |
| OD-7 | Default approval rule for invoices and quotes in new workspaces | None by default; companies switch it on in settings |
| OD-8 | Write access inside support sessions (console SUP requirements) | Read-only in this release; if needed later, a separate role with column-level grants and approval per change |

---

## Annexes

### A. Glossary

**Table 70: Glossary.**

| Term | Meaning |
|---|---|
| Workspace | One customer company's space in Nexora; the unit of isolation (tenant) |
| Principal | The account acting in a request: member, portal contact, staff member or system job |
| Realm | One of the three sign-in worlds: members, portal contacts, staff |
| Membership | The link between a member and a workspace, with a role and optionally an employee record |
| Unit of work | One database transaction around one business command |
| Outbox | Table of events written in a transaction and handled after commit |
| Row-level security (RLS) | PostgreSQL feature that filters rows by a policy for each query |
| Idempotency key | Identifier sent with a command so that a retry returns the first result |
| Lock date | Date on or before which dated records can no longer change |
| ICE, IF, RC | Moroccan company identifiers: common identifier, tax identifier, trade register |
| CGNC | Moroccan chart of accounts |
| UBL 2.1 | International XML format for electronic invoices |
| DGI | Moroccan tax administration |
| CNDP | Moroccan data-protection authority (Law 09-08) |
| Step-up | Asking for a fresh second factor before a sensitive action |
| Two-person approval | An action that needs a second, different person to approve |
| **[2.1]** Double submit | CSRF defence: the browser sends a token both as a cookie and as a header, and the server checks they match |
| **[2.1]** Lead | A possible client not yet won; converted to a client or dropped with a reason |
| **[2.1]** Sales stage | A step of the deals pipeline, with a chance %; deals stuck too long are stale |
| **[2.1]** Cycle | A time-boxed period (sprint) of 1 day to 4 weeks for a project's tasks |
| **[2.1]** Bin | Where deleted clients and tasks wait 30 days before they are purged |
| **[2.1]** Passcode | A short numeric code that unlocks the lock screen of an existing session |

### B. State Machines

Each record with a status moves only along these transitions; any other change is refused by the domain and, for money documents, by the database.

**Table 71: Allowed status transitions.**

| Record | Transitions | By |
|---|---|---|
| Time entry | draft → submitted → approved; submitted → rejected → draft; approved → draft (reopen, if not invoiced); approved → invoiced (by issue) → approved (void or credit with release) | Employee; approver; issue command |
| Leave request | pending → approved, rejected, cancelled; approved → cancelled (future: employee; past: administrator) | Employee; approver |
| Expense | draft → submitted → approved, rejected; rejected → draft; approved → reimbursed; draft deleted | Employee; approver; accountant |
| Quote | draft → sent, or, with an approval rule, draft → pending approval → approved → sent; pending approval → draft (rejected); sent → accepted, declined; expired derived from validity. **[2.1, B7]** The number is taken on the move to sent | Accountant; approver; client contact |
| Client invoice | draft → issued, or, with an approval rule, draft → pending approval → approved → issued; issued → sent; issued or sent → paid; paid → issued or sent (payment reversed); issued or sent → void (no payment, not at DGI, period open); draft deleted; partly paid derived from the balance | Accountant; approver; payment rules |
| Credit note | draft → issued (same transaction); never paid, never credited | Accountant |
| E-invoice | to send → sent → accepted, rejected | DGI port |
| Supplier bill | submitted → approved, rejected; approved → paid | Accountant; approver |
| Project | planning → active → on hold → active; active → completed (closed, frozen); any open → cancelled; **[2.1]** deleted only when it has no history (WRK-22) | Manager |
| Change order | draft → sent → approved, rejected | Manager; client contact (portal) |
| Membership | invited → active → disabled → active | Administrator |
| Portal access | invited → active → revoked; active → expired (job, after inactivity) → active (new grant) | User with client rights; job |
| Review | self → manager → done (acknowledged) | Employee; reviewer |
| VAT period | open → filed; filed → open (owner, fresh second factor, reason, audited) | Accountant; owner |
| Customer (platform) | As defined in the console specification, Figure 2 | Staff; jobs |
| Support session | requested → approved → active → ended; requested → refused; any → revoked | Staff; company administrator; expiry |
| Job | queued → running → done; running → queued (retry) → dead | Worker |
| **[2.1]** Client | lead → active (convert) → archived → active; lead → dropped (with reason); any without invoices → deleted → restored, or purged (by a person or the job after 30 days) | Manager; job |
| **[2.1]** Deal | open stage ↔ open stage; open → won (creates at most one project) or lost (with reason); won or lost → open (reopen) | Manager |
| **[2.1]** Follow-up | to do ↔ in progress → done → to do | Owner; manager |
| **[2.1]** Client request | new → accepted, rejected (reason), duplicate (of another request), snoozed (until a date); snoozed → new (job, on the date); any decided → reopened → new | Team member; portal contact (new only); job |
| **[2.1]** Cycle | upcoming → running → ended (job, by dates) → closed (summary frozen; unfinished tasks moved) | Manager; job |
| **[2.1]** Task | state changes inside the project's states, the status following the state's group; any → deleted → restored, or purged (by a person or the job after 30 days); done (repeating) → creates the next task once | Assignee; manager; job |
| **[2.1]** Account deletion (personal) | requested → cancelled (until day 14) or carried out (day 14, job) | Member; job |

### C. Traceability to the Audits, Lot B and the API Contract

**Table 72: Where earlier findings and plan items are answered.**

| Source | Requirements |
|---|---|
| Audit C1, pages open by URL | AUZ-01 to AUZ-03 (server refuses; front-end guard stays for usability) |
| Audit C2, approval rules not enforced | AUZ-04 to AUZ-06, APR-01 to APR-07 |
| Audit H1, floating-point money | DAT-05, DAT-06, SAL-15 |
| Audit H2, actor from the caller | IAM-01, TRL-03 |
| Audit H3, sensitive fields sent to everyone | AUZ-07, AUZ-08, ANL-04 |
| Audit H4, silent save failures | TRX-01, SCR-04 (errors always returned) |
| Audit M1, English error messages | ARC-08 |
| Audit M2, browser time zone | DAT-04, JOB-05 |
| Audit M3, everything computed in the browser | ANL-01 to ANL-03, ANL-07, DAT-16, NTF-05 |
| Audit M4, no concurrency control | TRX-03, TRX-06, TRX-07 |
| Lot B1 items 1 to 8 | DAT; ARC-07 and PLF; IAM; AUZ-13 and PLF-12; TRX-03 and PLF-05; JOB; DOC and SAL-21; MIG-03 |
| Lot B2 items 1 to 8 | PLF-07 and PLF-08; PLF-11; NTF; FIN-13; PLF-14; QAL-04; QAL-11 and QAL-12; QAL-01 |
| Lot B3 items 1 to 12 | TEN-10; TRL-02; PLF-13; PLF-08; SCR-05; SCR-06; IAM-13; IAM-17; SCR-15; RET-02; SCR-13; PLF-13 |
| Architecture repository defects 1 to 6 | DAT-01, TRX-01, TRX-05, TRL-01 to TRL-04, DAT-03 to DAT-07, TST-01, TEN-03 |
| **[2.1]** Full audit G-01, project delete | WRK-22, invariant 16 |
| **[2.1]** Full audit G-02 and G-03, landing page and old links | Front end only (fixed in A1) |
| **[2.1]** Full audit G-04, task mentions | WRK-05, NTF-07 |
| **[2.1]** Full audit G-05, company export | WSP-11 (table list from the catalogue) |
| **[2.1]** Full audit G-06, plan limits | WSP-09, WSP-10 (D4) |
| **[2.1]** Full audit G-07, search | ANL-08 |
| **[2.1]** Full audit G-08, missing notices | NTF-07, jobs of Table 56 |
| **[2.1]** Full audit G-09, functions without a screen | RET-03 (D6), WRK-03, NTF-08 |
| **[2.1]** Full audit G-10, merge misses records | REL-18 |
| **[2.1]** Full audit S-01, web addresses | REL-12, WRK-14, SCR-03 |
| **[2.1]** Full audit S-02, CSRF | SCR-16, §8.2 (D1) |
| **[2.1]** Full audit S-03, uploads | DOC-02, DOC-03, SCR-17 (D7) |
| **[2.1]** Full audit S-04, audit gaps | Table 54 |
| **[2.1]** Full audit S-05, idle lock | IAM-07, IAM-18 (D3) |
| **[2.1]** Full audit S-06, second factor | IAM-05 (D2) |
| **[2.1]** Full audit S-07, revoked sessions | IAM-19 |
| **[2.1]** Full audit S-08, demonstration mode | MIG-01, §18.4 |
| **[2.1]** Full audit C-02, large files | Split while wiring each module (MIG-02) |
| **[2.1]** API contract v2 (`docs/API_CONTRACT.md` in the web repository) | Paths, shapes and error codes of every endpoint; routes per B4, money per B6, codes per Annex F |

### D. Requirement Summary

**Table 73: Number of requirements by area and priority.** **[2.1]**

| Area | M | S | C | W |
|---|---|---|---|---|
| ARC — Architecture | 9 | 2 | 0 | 0 |
| DAT — Database | 17 | 2 | 0 | 0 |
| IAM — Identity and sessions | 14 | 3 | 2 | 0 |
| TEN — Multi-tenancy | 12 | 1 | 1 | 0 |
| AUZ — Authorization | 14 | 0 | 0 | 0 |
| WSP — Workspace and settings | 11 | 1 | 0 | 0 |
| PPL — People and HR | 10 | 3 | 0 | 0 |
| REL — Clients, CRM and portal | 13 | 9 | 0 | 0 |
| WRK — Projects and planning | 11 | 11 | 0 | 0 |
| TME — Time and timers | 9 | 2 | 1 | 0 |
| APR — Approvals | 6 | 1 | 0 | 0 |
| SAL — Sales and receivables | 29 | 2 | 0 | 0 |
| PUR — Purchases and expenses | 7 | 0 | 0 | 0 |
| FIN — Finance and compliance | 12 | 1 | 1 | 1 |
| ANL — Analytics | 4 | 4 | 0 | 0 |
| DOC — Files | 6 | 1 | 0 | 0 |
| NTF — Notifications | 7 | 0 | 1 | 0 |
| PLF — Platform console | 15 | 2 | 0 | 0 |
| TRX — Transactions | 8 | 2 | 0 | 0 |
| TRL — Audit trail | 8 | 1 | 0 | 0 |
| JOB — Background jobs | 5 | 3 | 0 | 0 |
| SCR — Security | 14 | 4 | 0 | 0 |
| RET — Privacy and retention | 8 | 1 | 0 | 0 |
| QAL — Quality and operations | 10 | 2 | 1 | 0 |
| TST — Testing | 4 | 1 | 0 | 0 |
| MIG — Migration | 5 | 2 | 0 | 0 |
| **Total** | **268** | **61** | **7** | **1** |

Version 2.0 had 305 requirements (253 M, 46 S, 5 C, 1 W). Version 2.1 has **337**: 32 added (IAM-18, IAM-19, REL-11 to REL-22, WRK-12 to WRK-22, ANL-08, NTF-07, NTF-08, SCR-16 to SCR-18, MIG-07) and one raised from S to M (NTF-05).

### E. Document Control

**Table 74: Document history.**

| Version | Date | Change |
|---|---|---|
| 1.0 | 7 October 2026 | First backend specification (API and data platform), baseline front end v3 |
| 2.0 | 16 October 2026 | Rewritten for the backend and database of every Nexora user; built on the front end at Lot A11 and the Architecture repository; public API moved out of scope; decisions of 16 October 2026 applied |
| **2.1** | **29 October 2026** | Brought up to the front end after audit fixes A1–A4 and the API contract v2; decisions D1–D8 and B1–B13 applied; converted from PDF to Markdown and kept in the server repository. Details below |

**Changes in 2.1, by section.**

| Section | Change | Source |
|---|---|---|
| Cover, §1.1 | Baseline, counts (362 API functions, 62 rule files, 143 test files, 869 tests, 441 error keys), audit status | Gap report D1–D3, D6 |
| §1.2 | Tables 1b and 1c (D1–D8, B1–B13); repository layout changed to two repositories | Decisions of 28 and 29 October |
| §2.2, §2.3 | New CRM and work features in scope; Developer page hidden in production | Gap report A, B9 |
| §3.2 Table 6 | Routes, session limits, who needs a second factor | B1, B2, B4 |
| §3.3 Table 7 | Rows for follow-ups, deleting and merging clients, import, export, sales stages, project delete, project pages, client requests | Gap report A3.5 |
| §3.4 | Client scope includes requests; shared views rule | Gap report A |
| §4.1 Table 9 | 15 more rule files; error key count | Gap report D4 |
| §5.1, ARC-01, ARC-07, ARC-08, ARC-09 | Two repositories; realm routes with the workspace in the path; catalogue keys | B4, B5, B13 |
| §5.5 | CSRF check; workspace from the path after the membership check | D1, B11 |
| §6.3, §6.5, Table 16 | Money on the wire; new uniqueness, exclusion and frozen rules | B6, gap report A |
| §7 | 15 new tables (`passcodes`, `client_follow_ups`, `pipeline_stages`, `client_history`, `import_runs`, `table_views`, `project_task_states`, `task_assignees`, `task_watchers`, `task_links`, `task_relations`, `task_views`, `client_requests`, `cycles`, `project_pages`) and about 30 new columns | Gap report A1, A2, A3.6 |
| §8 | Portal link endpoints; lock screen; CSRF; IAM-03, IAM-05, IAM-07, IAM-12 updated; IAM-18 and IAM-19 added | B1, B2, B3, B10, A3.6, audit S-07 |
| §9.3 TEN-01 | Workspace in the path, checked | B11 |
| §11 | WSP-09, WSP-10, WSP-11 updated; REL-11 to REL-22 and WRK-12 to WRK-22 added; REL-05 to REL-09, WRK-03, WRK-05 updated | D4, gap report A1, A2, audit G-05 |
| §12 | SAL-01 numbers quotes when sent; approval note; PUR-02 bill rule | B7, gap report C1, C2 |
| §13 | ANL-07 updated, ANL-08 added; DOC-02, DOC-03, DOC-07 updated; NTF-05 raised to M; NTF-07 and NTF-08 added | B8, B12, D6, D7, audit G-07 |
| §15 | Numbering for quotes, tasks and requests; 5 new contended operations; 4 new invariants; merge and request flows; TRX-04 and TRX-06 front-end notes | B7, gap report A, C4, C5 |
| §16.2 | Client, work and settings events added | Gap report A3.3 |
| §17.2 | 7 new jobs | Gap report A3.2 |
| §18 | Threats, OWASP mapping, SCR-03, SCR-05, SCR-06 updated; SCR-16 to SCR-18 added; new §18.4 security plan | Plan Part C, D1 |
| §19 | Retention of bins, history and imports; RET-03 personal data from the profile | D6 |
| §20 | Test suites; scenario steps 2, 12, 16 and 17 | Gap report A |
| §21 | MIG-07; phases B1b, B1c, B1e longer (27 weeks, about 34 with contingency); new §21.4 front-end items | Gap report C, E |
| §22 | Rules drift and growing front end risks | B13 |
| Annexes | Glossary terms; 7 new state machines; traceability to the full audit and the contract; counts; new Annex F | Gap report A3.4, B5, D5 |

This document is approved by the owner of Nexora before phase B1a starts. Any change to a Must requirement after approval is recorded here with its reason.

### F. Error Codes and Catalogue Keys **[2.1, B5]**

The server returns the front end's catalogue keys (ARC-08). This document writes codes in `UPPER_SNAKE` for readability; the table gives the key each one becomes, with its HTTP status. Keys marked **to add** are missing from the catalogue today and are added with their nine translations before phase B1a (front-end item F10). A code that has several wordings in the front end maps to the one shown; the others stay valid.

**Table 75: Error codes and catalogue keys.**

| Code in this document | HTTP | Catalogue key |
|---|---|---|
| `CONFLICT_STALE_VERSION` | 409 | `err_conflict` |
| `STEP_UP_REQUIRED` | 403 | `err_stepUpRequired` (**to add**) |
| `LAST_OWNER` | 409 | `err_lastCompanyAdmin` (company), `err_lastOwner` (console) |
| `WORKSPACE_READ_ONLY` | 403 | `err_workspaceReadOnly` (**to add**) |
| `SEAT_LIMIT` | 409 | `err_seatsFull` |
| `SEATS_IN_USE` | 409 | `err_seatsUsed` |
| `PLAN_FEATURE` | 403 | `upgrade_required` (already handled by the HTTP client) |
| `IDEMPOTENCY_MISMATCH` | 422 | `err_idempotencyMismatch` (**to add**) |
| `INTERNAL` | 500 | `err_internal` (**to add**) |
| CSRF check failed (SCR-16) | 403 | `err_csrf` |
| Rate limit (SCR-05) | 429 | `err_tooManyRequests` |
| Password too short, breached (IAM-03) | 400 | `err_passwordTooShort`, `err_passwordBreached` |
| Second factor required, wrong code (IAM-05) | 403, 400 | `err_twoFactorRequired`, `err_twoFactorInvalid` |
| `NOT_YOUR_RECORD`, `NOT_IN_TEAM` | 404 on reads, 403 on writes | the record's not-found key (for example `err_clientNotFound`); `err_forbidden` (**to add**) on writes |
| `SELF_APPROVAL` | 403 | `err_youCanTApproveYourOwn` |
| `SAME_APPROVER` | 409 | `err_theSecondApprovalMustComeFrom` (company), `err_refundSecondPerson` (console) |
| `APPROVAL_REQUIRED` | 409 | `err_approvalRequired` (**to add**) |
| `PERIOD_LOCKED` | 409 | `err_periodLocked` |
| `DOCUMENT_FROZEN` | 409 | `err_documentFrozen` (**to add**) |
| `INVALID_TRANSITION` | 409 | `err_transition` |
| `REASON_REQUIRED` | 400 | the key of the action (for example `err_sayWhyDealLost`, `err_leadDropReason`, `err_giveAReasonWhenRejecting`) |
| `INVALID_ICE`, `CLIENT_ICE_REQUIRED` | 400, 409 | `err_theIceMustHaveExactly15`, `err_addTheClientSIceInvoices` |
| `BASE_CURRENCY_LOCKED` | 409 | `err_baseCurrencyLocked` (**to add**) |
| `CUSTOM_FIELD_REQUIRED` | 400 | `err_customFieldRequired` (**to add**) |
| `EMPLOYEE_INACTIVE` | 409 | `err_thisEmployeeHasLeftTheCompany` |
| `MANAGER_CYCLE` | 409 | `err_managerCycle` (**to add**) |
| `LEAVE_BALANCE` | 409 | `err_leaveBalance` |
| `CLIENT_ARCHIVED` | 409 | `err_archivedClientsCanTUseThe` |
| `CLIENT_HAS_INVOICES` | 409 | `err_thisClientHasInvoicesSoIt` |
| `CREDIT_LIMIT` | 409 | `err_creditLimit` (**to add**) |
| `QUOTE_EXPIRED` | 409 | `err_quoteExpired` (**to add**) |
| `ALREADY_ANSWERED` | 409 | `err_surveyAlreadyAnswered` |
| `BAD_URL` | 400 | `err_badUrl` |
| `DEAL_HAS_PROJECT`, `DEAL_NOT_WON` | 409 | `err_dealHasProject`, `err_dealNotWon` |
| `RETAINER_TERMS` | 400 | `err_retainerTerms` (**to add**) |
| `NOT_PROJECT_MEMBER` | 403 | `err_onlyTheProjectTeamCanLog` |
| `DEPENDENCY_CYCLE` | 409 | `err_theseDependenciesWouldMakeTasksWait` |
| `PROJECT_CLOSED` | 409 | `err_projectClosed` |
| `PROJECT_HAS_HISTORY` | 409 | `err_projectHasHistory` |
| Cycle overlap (WRK-18) | 409 | `err_cycleOverlap` |
| `DAY_OVER_24H` | 409 | `err_moreThan24HoursInOne` |
| `ENTRY_LOCKED` | 409 | `err_submittedOrApprovedHoursCanT` |
| `ENTRY_INVOICED` | 409 | `err_invoicedHoursCanTBeReopened` |
| `TIMER_RUNNING` | 409 | `err_timerRunning` (**to add**) |
| `ALREADY_ON_INVOICE` | 409 | `err_someHoursAreNoLongerAvailable`, `err_someExpensesAreNoLongerAvailable` |
| `OVER_PROJECT_PRICE` | 409 | `err_thisWouldBillMoreThanThe` |
| `ALREADY_INVOICED` | 409 | `err_thisMonthOfTheRetainerIs` |
| `EXCHANGE_RATE_REQUIRED` | 400 | `err_exchangeRate` |
| `HAS_PAYMENTS` | 409 | `err_thisInvoiceHasPaymentsIssueA` |
| `ALREADY_CREDITED` | 409 | `err_someOfTheseLinesWereAlready` |
| `OVER_BALANCE` | 409 | `err_leftToPay` (invoices), `err_thePaymentIsMoreThan` (bills) |
| `DUPLICATE_BILL` | 409 | `err_thisSupplierSBillNumber` |
| `RECEIPT_REQUIRED` | 400 | `err_receiptAbove` |
| `LINE_MATCHED` | 409 | `err_lineMatched` (**to add**) |
| `LOCK_PERIOD_FIRST` | 409 | `err_lockPeriodFirst` (**to add**) |
| `SENT_TO_DGI` | 409 | `err_thisInvoiceWasSentTo` |
| `FILE_TOO_LARGE`, wrong type, infected, storage full | 413, 415, 422, 409 | `err_fileTooLarge`, `err_fileType`, `err_fileInfected`, `err_storageFull` |

**Keys to add (16):** `err_stepUpRequired`, `err_workspaceReadOnly`, `err_idempotencyMismatch`, `err_internal`, `err_forbidden`, `err_approvalRequired`, `err_documentFrozen`, `err_baseCurrencyLocked`, `err_customFieldRequired`, `err_managerCycle`, `err_creditLimit`, `err_quoteExpired`, `err_retainerTerms`, `err_timerRunning`, `err_lineMatched`, `err_lockPeriodFirst`.

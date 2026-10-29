# Nexora: latest audit

_The audit of the front end, the API and security. The same report is in `docs/AUDIT.md` of the web repository (`yahyanaim/Nexora-Saas`); each new audit, code review or report replaces both. Screenshots are in the web repository's `docs/screenshots/`._

**Last update:** 29 October 2026, after audit fixes A1–A4, the backend cahier des charges v2.1, server prep F9–F10 and the first server step (B1a step 1). **Scope:** front end, API layer and contract, security. The server is specified in `docs/CAHIER_DES_CHARGES.md` of `yahyanaim/Nexora-Backend`; its first step (repository, shared rules, skeleton, CI) is built.

## 1. Summary

The front end is finished and clean: every finding of the October full audit that belongs to the front end is fixed. What is left is (a) the server, which is specified and has just started (B1a step 1 of 4), and (b) 10 small front-end items that only make sense once the server exists.

| Area | Grade | In one line |
|---|---|---|
| Code quality | 🟢 Good | Types, lint and translations clean; no `any` or `@ts-ignore` in app code; no unused text |
| Tests | 🟢 Good | 143 files, 869 tests, all passing; money screens and PDFs covered |
| Accessibility | 🟢 Good | axe: no critical or serious finding on 23 console and 21 company pages, in CI |
| Browser security | 🟢 Good | Nonce CSP, strict headers, safe redirects, http/https-only addresses, idle lock, real 404 |
| API layer and contract | 🟢 Ready | 56 modules, 362 functions, all in `docs/API_CONTRACT.md`, kept in step by a test |
| Server security | 🟡 Specified, being built | CSRF, files, second factor, sessions, plan limits, isolation: decided and written, waiting for the server |
| Dependencies | 🟢 Good | Production: 0 vulnerabilities. Development tools: 3 low |

## 2. Checks run today

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ No error |
| `eslint` (0 warnings allowed) | ✅ Clean |
| Translations in 9 languages | ✅ In sync; all 5,587 texts used |
| Vitest | ✅ 143 files, 869 tests passing |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| `npm audit` (with dev tools) | ⚠️ 3 low: `deepmerge` inside the `shadcn` command-line tool (development only, never shipped) |
| CI on the last pull request | ✅ Build, Playwright, axe, demo-mode guard, dependency audit, type and unit checks |
| Code scan | `any` in app code: 0 · `@ts-ignore`: 0 (4 `@ts-expect-error`, all in tests) · `dangerouslySetInnerHTML`: 1 (sanitized chart CSS) · lint suppressions: 21, each with a reason |

## 3. Status of every finding of the October full audit

| # | Finding | Status |
|---|---|---|
| G-01 | Project with history could be deleted | ✅ Fixed (A1) |
| G-02 | Employees landed on "No access" | ✅ Fixed (A1) |
| G-03 | Old `/billing` links | ✅ Fixed (A1) |
| G-04 | Task mentions never reached the bell | ✅ Fixed (A1) |
| G-05 | Company export missed 6 collections | ✅ Fixed (A1) |
| G-06 | Plan limits not enforced | ⏳ Server (WSP-09, WSP-10) |
| G-07 | Search did not cover everything | ✅ Fixed (A4) |
| G-08 | Events missing from the bell | ✅ Fixed (A4) |
| G-09 | Functions with no screen | ✅ Fixed (A4); notification preferences wait for the server (NTF-08) |
| G-10 | Merge missed bank matches and reports | ✅ Fixed (A4) |
| S-01 | Any web-address scheme accepted | ✅ Fixed (A2) |
| S-02 | No CSRF approach | ⏳ Server (SCR-16) + front-end item F11 |
| S-03 | Uploads without allow-list | ⏳ Server (DOC-02, DOC-03, SCR-17) |
| S-04 | Sensitive actions not audited | ✅ Fixed (A2) |
| S-05 | No idle lock | ✅ Fixed (A2) |
| S-06 | Second factor not really wired | ⏳ Server (IAM-05) |
| S-07 | Revoked session not pushed to the browser | ⏳ Server (IAM-19) |
| S-08 | Demo mode must stay off in production | ✅ Blocked by a CI check |
| S-09 | Dev dependency vulnerabilities | ✅ Fixed (A3); 3 new low ones since, see §4 |
| C-01 | Unused code and texts | ✅ Fixed (A3) |
| C-02 | Large files | ⏳ Split while wiring each module to the server |
| C-03 | Settings labels; axe only on console | ✅ Fixed (A2) |
| C-04 | Hard-coded English | ✅ Fixed (A3, A4) |
| C-05 | Few screen and PDF tests | ✅ Fixed (A4) |
| C-06 | Direct `console` calls | ✅ Fixed (A3) |
| H2, H3 | Actor and sensitive fields decided by the server | ⏳ Server (IAM-01, AUZ-07) |

**Front end: 19 of 19 front-end findings fixed. Server: 8 items waiting, all specified.**

## 4. What is still not done

### 4.1 Small things found today

| # | Item | Level | Fix |
|---|---|---|---|
| N-1 | 3 low vulnerabilities in `deepmerge`, used only by the `shadcn` command-line tool. `npm audit fix --force` would install an old major version of `shadcn` | Low | Wait for a `shadcn` release that updates it; nothing ships to users |
| N-2 | The Developer page (API keys, webhooks) showed in production, although decision B9 keeps keys and webhooks out of version 1 | Low | ✅ Fixed (F9): demo mode only; a real deployment answers 404 |
| N-3 | Six files are over 600 lines (`work-billing-api.ts` 808, `platform-billing-api.ts` 772, `project-detail-page.tsx` 723, `settings-page.tsx` 666, `client-form.tsx` 634, `use-dashboard-nav.tsx` 619) | Low | Split each one when its module is wired to the server (C-02) |

### 4.2 Front-end items the server needs (cahier des charges §21.4)

| # | Item | Before phase |
|---|---|---|
| F1 | Quotes and invoices follow the approval rule ("pending approval" state) | B1d |
| F2 | "Bill" as an approval subject in Settings | B1d |
| F3 | Step-up screen (fresh second factor) before sensitive actions | B1b |
| F4 | `Idempotency-Key` header on money and number commands | B1d |
| F5 | Send the record version; reload on conflict | B1c |
| F6 | Portal "send me a sign-in link" | B1e |
| F7 | "My devices" list; administrator signs a member out | B1b |
| F8 | Transfer ownership; clear message for the last owner | B1b |
| F9 | Hide the Developer page in production | ✅ Done |
| F10 | Add the 16 missing error keys in 9 languages | ✅ Done (19 keys with the 3 HTTP ones) |
| F11 | Send the `X-XSRF-TOKEN` header | B1b |
| F12 | The bell reads one notice feed | B1e |

### 4.3 The server

Built: phase B1a step 1 — the server repository, `packages/core` generated from this repository's rules (with a CI check that they stay identical), the server skeleton (configuration that refuses weak production secrets, health checks, errors as catalogue codes) and CI. The rest is specified in the cahier des charges v2.1 (337 requirements: 268 Must, 61 Should, 7 Could, 1 Won't) and planned in 8 phases, 27 weeks (about 34 with contingency). The open security items above (S-02, S-03, S-06, S-07, G-06, H2, H3) are built in phases B1a to B1e. Eight open decisions (OD-1 to OD-8: invoice cancellation, employee data retention, hosting region, e-mail provider, malware scanner, managed database, default approval rule, support write access) need an answer before the phases that use them, and the items "to confirm" with the accountant and counsel need written answers before the first paying company.

## 5. Screenshots

The latest screenshots are in `docs/screenshots/` (from A4): real 404 in Arabic, search, project pages tab, template delete, personal data, form messages in Arabic, bell action item.

# Nexora: security plan

_How the code is kept secure from now to release, phase by phase. It applies the cahier des charges §18 (threat model, OWASP mapping, SCR requirements, Table 60b) to the code as it is today. Written on 10 November 2026, before step 4 was merged, from a security review of the branch and a read of both repositories. It is updated with each phase, like the tracker._

**Sources and method:**
- The security review of the step 4 changes (both repositories).
- The engineering-lifecycle rules of the roadmap (cahier §21.5): requirements first, design before code, adversarial tests, review, diagnostics.
- The OWASP Top 10 (2025) as the checklist.
- Every gap below was checked in the code; none is a guess.

## 1. Review of the step 4 changes

| Repository | Changed | Result |
|---|---|---|
| Nexora-Backend #10 | `src/architecture/import-rules.ts` (a pure checker run by a test), two test files, docs | No vulnerability. The checker takes no outside input, opens no network or database connection and runs only in tests |
| Nexora-Saas #145 | `docs/AUDIT.md` | Documentation only |

## 2. What already protects the code

| Protection | Where | OWASP | Test |
|---|---|---|---|
| Three tenant barriers: forced row-level security, a role per transaction (`SET LOCAL ROLE` from a closed list), NOINHERIT logins | `0001_foundation.sql`, `src/db/session.ts` | A01 | `database.test.ts`, `session.test.ts` |
| Ids and roles checked before they reach SQL | `src/db/session.ts` | A03 | `session.test.ts` (9 cases) |
| Parameterised SQL everywhere; the only interpolation is the role, from the closed list | `src/db/*`, `src/jobs/*` | A03 | Code read; `session.test.ts` |
| Insert-only audit trails; secrets masked in audit values | `0005_audit_trails.sql`, `unit-of-work.ts` | A09 | `unit-of-work.test.ts` |
| Errors leave as a code and a request id, never a stack or SQL | `src/http/error-body.ts` | A05, A10 (exceptional conditions) | `error-body.test.ts` |
| Security headers (HSTS, `nosniff`, `DENY` frames, strict CSP, `no-store`), 1 MB body limit, no `x-powered-by` | `src/http/app.ts` | A05 | `app.test.ts` |
| Production refuses weak secrets and a non-https origin | `src/config/config.ts` | A05, A02 | `config.test.ts` |
| Dependency audit fails CI on a high finding (both repositories); lock files | `ci.yml` | A06 | CI |
| CI jobs read-only (`permissions: contents: read`) | `ci.yml`, `core-drift.yml` | A08 | — |
| Rules generated from a recorded web commit; no hand edits | `sync-core.mjs`, `packages/core/SOURCE` | A08 | `sync-core.test.mjs` |
| Module boundaries enforced | `src/architecture/import-rules.ts` | A04 | `import-rules.test.ts` |
| Front end: demo mode refused in production builds; CSP with a nonce per request; same-origin frames only for the manual's diagrams | `src/proxy.ts`, `next.config.mjs` | A05 | CI job "Demo mode is blocked" |

## 3. Gaps found now

| # | Gap | Evidence | Risk | Fix | When |
|---|---|---|---|---|---|
| G-1 | GitHub Actions are pinned by tag (`@v4`), not by commit | Both repositories' workflows | A moved tag runs other code in CI (A08, supply chain) | Pin every action to a commit SHA with the version in a comment | Step 6 |
| G-2 | No secret scan of the repositories | No scan in CI | A committed key goes unnoticed (SCR-06) | A secret-scan job on every pull request, and GitHub secret scanning switched on | Step 6 |
| G-3 | No automatic dependency updates | No Renovate or Dependabot file | Fixes arrive only when someone looks (A06, SCR-10) | Dependabot (security updates weekly), grouped by ecosystem | Step 6 |
| G-4 | No rule forbids string-built SQL | SCR-02 asks for a lint rule; the backend has no linter | A later `query(\`… ${x}\`)` would pass review unseen (A03) | A test like the import-rule test that refuses template literals with `${…}` inside `query(…)` calls, except the reviewed role line | Step 6 |
| G-5 | The database connection does not require TLS in production | `src/db/pool.ts` sets no `ssl` | Credentials and data in clear on the network (SCR-01, A02) | Production config refuses a `DATABASE_URL` without `sslmode=verify-full` | B1b (with the first real data); checked again in B2 |
| G-6 | Error logs may carry personal data from database error details | `errorHandler` logs the whole error; PostgreSQL `detail` can hold values (e.g. a duplicate e-mail) | PII in logs (A09, Law 09-08) | `pino` redaction of `err.detail`, `err.where`, request bodies and cookies; a test that logs a duplicate-key error and checks the output | B1b (with the access log, M-5) |
| G-7 | `trust proxy` is fixed at one hop | `app.set("trust proxy", 1)` | Behind a different chain, the client IP (used by rate limits and logs) could be spoofed | Make the hop count configuration, documented per environment | B1b (before rate limits) |
| G-8 | No SBOM per release, no container image yet | No Dockerfile | A08, SCR-11 | SBOM and image scan in the release pipeline; non-root minimal image | B2 |

## 4. Security work per phase

Each item has a test or a check that proves it; nothing counts as done without it.

| Phase | Security work | Proof |
|---|---|---|
| **B1a step 5** | Worker heartbeat (an alert can only fire if the worker reports); audit seal and verify jobs, so tampering with the trail is detected (TRL-05) | Stopping the worker shows a missing heartbeat; changing an audit row makes `audit.verify` fail |
| **B1a step 6 (exit gate)** | Guard suite, privilege suite, audit secret scan (TRL-04); G-1 to G-4 | A role reaching another role's table fails; a secret in an audit value fails; an unpinned action, a committed key and a string-built query each fail CI |
| **B1b** | Argon2id passwords, 12+ characters, breach check, lockout; realm cookies, refresh rotation with reuse detection; CSRF double submit and `Origin` check; second factor and step-up; same answer whether an e-mail exists or not; rate limits; access log; G-5 to G-7 | IAM tests; a forged cross-origin post returns 403 and writes nothing; a reused refresh token revokes the session; 429 at the limits; no PII in logs |
| **B1c** | Membership check of the workspace in the path; deny by default; record rules (own records, no self-approval); field shaping (costs, salaries); optimistic locking; http/https-only addresses; field encryption of CIN, CNSS and bank accounts (SCR-07) | Cross-company suite (another company's ids → 404 on every endpoint); permission matrix per role; response snapshots per role; a database dump shows ciphertext |
| **B1d** | Idempotency keys on money writes; gap-free numbering; lock date on the server; frozen issued documents; CSV export escaping (SCR-08) | Replay and concurrency suites; editing an issued invoice in SQL is refused; `=HYPERLINK(…)` exports as text |
| **B1e** | Uploads: type from the bytes, SVG and HTML refused, malware scan, private bucket, short signed links, images re-encoded without EXIF; outgoing hosts allow-list (SCR-09) | Upload test set (renamed executable, SVG, EICAR, oversize); a host outside the list refused at boot |
| **B1f** | Console role with no tenant privilege; support sessions with consent, time limit and double audit; watermarked exports (SCR-15) | Console permission suite; a support session after expiry is refused |
| **B2** | TLS everywhere with HSTS; encrypted off-site backups and a timed restore; non-root minimal image; SBOM and image scan; secrets in a secret store per environment; OWASP ZAP baseline on every staging deployment (SCR-18); alerts on 403 and 404 spikes, failed sign-ins and unusual exports (SCR-14) | TLS scan grade A; restore drill; image scan clean; ZAP report with no high finding; alert drill |
| **B3** | Key rotation without downtime; IP allow-list option for the console; external penetration test and fixes (SCR-13) | Report with no open high finding; rotation drill |

## 5. Security definition of done for every pull request

Added to the definition of done of the cahier §21.5:

| # | Check |
|---|---|
| 1 | The change says which threat of Table 58 it touches, or that it touches none |
| 2 | Identity, role, workspace and actor come from the session, never from the request body |
| 3 | Every input goes through a schema with lengths and allowed values; unknown fields are refused |
| 4 | SQL is parameterised; nothing is built from strings |
| 5 | A negative test for each rule: the forbidden case is refused (wrong company, wrong role, bad input, replay) |
| 6 | No secret, token or personal data in code, logs, audit values or error bodies |
| 7 | New dependencies are justified, audited and pinned; CI stays green on the dependency audit |
| 8 | A security review of the branch runs before the merge, and its findings are fixed or written down with a reason |
| 9 | The docs (contract, architecture, this plan) match the code |

## 6. Recurring checks

| When | Check |
|---|---|
| Every pull request | CI (tests, rights and isolation suites, dependency audit; from step 6: secret scan, pinned actions, SQL rule); security review of the branch |
| Every week | Dependency updates (from step 6) |
| Every staging deployment (from B2) | ZAP baseline |
| Every quarter | Review of this plan, of access rights and of secret rotation |
| Before the first paying company | External penetration test |

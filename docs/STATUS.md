# Status

## Phase 3 — Tasks and the next-step rule (2026-11-17)

**Gate result: pass locally; GitHub Actions not yet run.** The full suite ran against the Compose stack on a Windows/Docker Desktop machine (web on port 3100, `RADAR_INTERVAL_SECONDS=10`, `REMINDER_INTERVAL_SECONDS=5`, as in the E2E workflow).

| Gate check                                          | Result | How it was run                                                                                                                                                              |
| --------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UF-8 E2E passes                                     | Pass   | `tests/e2e/uf-8.spec.ts`: My day order, a touch refused without a next step, a reminder in-app and by email, reminder emails turned off; a touch that closes as Won (phone) |
| UF-2 E2E passes                                     | Pass   | `tests/e2e/uf-2.spec.ts`: open stages, Won and Lost, the radar flags a lead on change and on its sweep, My day orders stuck leads, the Owner reassigns one                  |
| Each reminder is sent exactly once across a restart | Pass   | `tests/integration/reminders.test.ts`: restart, a crash mid-send without idempotency (skipped, not repeated), and with Resend (retried under the same key)                  |

### Requirements done

TASK-01, TASK-02, TASK-03, TASK-04, TASK-05, NOT-01. Test names start with the ID.

### Tests added

- Unit: domain now has 104 tests (22 new: next-step rule, stuck reasons, My day, reminder key and window, digest time across timezones and daylight saving, email budget).
- Integration: 97 in total (30 new), including cross-tenant cases for every new route.
- E2E: 13 runs pass on desktop and phone (UF-2 and UF-8 new).

### Fixed while running the gate

The new E2E specs had locator bugs, not app bugs: `getByLabel('Next step')` and `getByText('Stuck: no activity')` also matched the "Next steps" section, the "Set the next step" radio and the timeline entry; the bell check counted before the unread count loaded; and UF-2's quiet lead had an earlier deadline than the lead it was meant to follow.

### Deferred

- The 2 sample workflows of ORG-04 and the outbox publisher still arrive in Phase 4.

## Phase 2 — Leads and pipeline (2026-11-16)

**Gate result: pass on GitHub Actions** — [CI run 43873830195](https://github.com/Senthee1811/DatoFlow-SaaSConcept/actions/runs/43873830195) (lint, types, unit tests with coverage, build, integration and cross-tenant suite including the 10k-lead p95 check, linux/arm64 images) and [E2E run 43873830255](https://github.com/Senthee1811/DatoFlow-SaaSConcept/actions/runs/43873830255) (leads, board and sample-data flows against a fresh no-secrets Compose stack, desktop and phone).

| Gate check                                      | Result                     | How it was run                                                                                                                                     |
| ----------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| LEAD-05 p95 under 300 ms with 10,000 leads      | Pass: p95 48 ms, max 52 ms | `tests/integration/perf.test.ts`: 10,000 leads in one organization, 69 list requests across search, every filter, every sort and five cursor pages |
| Keyboard moves work on the board                | Pass                       | `tests/e2e/leads.spec.ts`: Space picks up, arrows choose a stage, Space drops, Escape cancels; focus follows the card; desktop and phone           |
| Deleting sample data leaves real data untouched | Pass                       | Integration (exact rows left, timeline kept, real leads owned by a sample rep go to the pool) and E2E                                              |

### Requirements done

| ID      | Tests (names start with the ID)                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LEAD-01 | Every field kept, first open stage, archive and restore, edits refused while archived; unknown fields rejected                                                                                                 |
| LEAD-02 | Field-level 422 for invalid email and phone; E.164 with the organization's country (LK and US); domain normalisation rules                                                                                     |
| LEAD-03 | Linked on email, phone and name + company, never merged; editing into a match links it; UI shows "Possible duplicate" with links                                                                               |
| LEAD-05 | Search over name, company, email and phone; owner, stage, source, priority, created dates (org timezone), stuck; cursor paging in a stable order; filters persist per user (API and browser); performance gate |
| LEAD-06 | Created, updated (with field changes), stage changed, assigned, note, archived and restored all on the timeline; workflow actor shown as "Workflow: name"                                                      |
| PIPE-01 | Add, rename, reorder, set SLA, mark Won or Lost; a stage with leads cannot be removed until they move; new SLA applies to leads in the stage; invalid lists refused; Managers cannot configure                 |
| PIPE-02 | Drag-and-drop, keyboard moves, and an API error rolls back the optimistic move with a toast (E2E with a forced 500); table view                                                                                |
| PIPE-03 | Lost refused without a loss reason; Won refused without a deal value unless the org setting is off; the browser asks for them in a dialog                                                                      |
| ORG-04  | 60 sample leads and 3 sample reps on a new workspace, none counted as seats; delete removes only sample records; Owner and Admin only                                                                          |

Also covered: Sales Rep scope (assigned plus pool, the "Reps can see all leads" setting, no reassigning or archiving), outbox events written in the same transaction as the change, and cross-tenant cases for the 8 new routes plus cross-organization stage and owner references.

### Tests added

- Unit: domain now has 82 tests (98.9% line coverage).
- Integration: 67 in total (26 new), including the performance gate.
- E2E: 5 new specs in `tests/e2e/leads.spec.ts`; 8 runs in total pass on desktop and phone.

### Deferred

- The 2 sample workflows of ORG-04 arrive with workflows in Phase 4.
- The outbox publisher arrives in Phase 4; events accumulate unpublished until then.
- "Stuck" counts only the stage SLA for now. The overdue-next-step half arrives with tasks in Phase 3.
- Touches (call, email, message, meeting) on the timeline arrive with the next-step rule in Phase 3.

## Phase 1 — Foundation (2026-11-16)

**Gate result: pass on GitHub Actions** — [CI run 43865228519](https://github.com/Senthee1811/DatoFlow-SaaSConcept/actions/runs/43865228519) (lint, types, unit tests with coverage, build, integration and cross-tenant suite, linux/arm64 images) and [E2E run 43865228603](https://github.com/Senthee1811/DatoFlow-SaaSConcept/actions/runs/43865228603) (UF-4 against a fresh no-secrets Compose stack).

| Gate check                                               | Result | How it was run                                                                                                                                                        |
| -------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh clone runs with `docker compose up` and no secrets | Pass   | `docker compose -f infra/docker-compose.yml down -v`, then `up --build --wait`. All six services healthy, migrations applied by the `migrate` service, no `.env` file |
| Generated cross-tenant suite passes for every route      | Pass   | `tests/integration/cross-tenant.test.ts` reads `/v1/openapi.json`; 16 operations, each covered. A route without a case fails the suite                                |
| UF-4 E2E passes                                          | Pass   | `tests/e2e/uf-4.spec.ts` against the Compose stack, desktop and phone viewports, axe WCAG 2.2 AA on every screen visited                                              |
| Production build                                         | Pass   | `turbo run build` (Next.js standalone, Nest via tsc), and Docker images for api, worker and web                                                                       |

### Requirements done

| ID                                     | Tests (names start with the ID)                                                                                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-01                                | Unverified user cannot sign in, signed in after the link; sign out; wrong password refused; unverified users cannot create an org; Google hidden without credentials                                                             |
| AUTH-02                                | Reset token single-use; 30-minute expiry; 5 requests/hour per email (6th is 429); revoke all sessions; reset revokes sessions                                                                                                    |
| ORG-01                                 | Creator becomes Owner with a 6-stage pipeline; slug unique; field-level 422 and unknown fields refused; schema normalisation; default pipeline shape                                                                             |
| ORG-02                                 | Member of two orgs lists both and switches the active one; 404 without membership; Better Auth org endpoints other than set-active closed                                                                                        |
| ORG-03                                 | Token hashed, 7-day expiry, single-use; must match invitee email; expired refused; resend and revoke; Admins cannot grant Owner; last Owner rules; Admin limits on Owners; concurrent demotion race; domain rules for every case |
| CAP-04                                 | Provider chosen by `EMAIL_PROVIDER` alone; missing credentials name the variable; console, SMTP (Mailpit in Compose) and Resend adapters                                                                                         |
| AUD-01 (auth, role, invitation events) | Sign-in, failed sign-in, sign-out, password reset and session revocation audited without secrets; invitation and role events; Managers cannot read; append-only enforced by a database trigger; metadata stripping               |

UF-4 is covered by two integration tests (402 naming `users`; accept, audit and inviter email) and the browser test.

### Tests added

- Unit: 78 (domain 59 with 100% line coverage, shared 7, adapters 4, db 8). Includes every cell of the role table.
- Integration: 41 across `auth`, `orgs` and `cross-tenant`, on Testcontainers Postgres 17 and Redis 7.4.
- E2E: 2 UF-4 specs (3 runs: desktop, plus the mismatch case on a phone viewport).

### Also in place

- Tenancy: Prisma extension adds the organization filter to every operation and fails closed without a context; Postgres RLS under `SET LOCAL ROLE datoflow_app`; a test checks every tenant table has `organizationId`, an index and a policy.
- RFC 9457 errors with stable codes, cursor pagination, `Idempotency-Key` on POST, `X-Request-Id` on every response and log line, JSON logs with redaction, `/health/live` and `/health/ready` on api, worker and web.
- Rate limits: auth credential endpoints 5/min per IP, API 300/min per user, password reset 5/hour per email.
- Caldera tokens in `packages/ui/src/theme.css`; the shell, auth screens, onboarding, members, audit log, settings and account screens.

### Deferred or not verified

- **CI on GitHub**: not run, see above.
- **Google sign-in**: wired, but not exercised; it needs a Google OAuth client. It stays hidden while `GOOGLE_CLIENT_ID` is unset.
- **Resend**: the adapter is unit-tested against a stubbed API; no real email was sent. Needs a Resend account and a verified domain (Phase 7).
- **Per-day email counter and next-day overflow queue** (section 3, Resend limits): arrives with the worker's email queue in Phase 3, where reminders and digests are sent.
- **In-app notification to the inviter** (UF-4): email only for now; NOT-01 lands in Phase 3.
- **Display font**: Anton is the fallback. Add licensed PP Neue Corp Compact `.woff2` files to `apps/web/public/fonts/` and switch `apps/web/src/app/fonts.ts` to `next/font/local`.
- **CSP with nonces**: the web CSP allows inline scripts for Next's bootstrap; Phase 7 tightens it.
- **Plans**: seat limits are enforced for invitations. Other entitlements and the 402 path for the rest arrive in Phase 6.
- Local note: host port 3000 was taken on the development machine, so the stack was verified with `WEB_HOST_PORT=3300 APP_URL=http://localhost:3300`. A fresh machine needs neither.

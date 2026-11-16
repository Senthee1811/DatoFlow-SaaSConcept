# Status

## Phase 1 — Foundation (2026-11-16)

**Gate result: passes locally. Not yet run on GitHub Actions** — the repository has no remote yet. The workflows are in `.github/workflows/`; the gate counts once they pass on GitHub.

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

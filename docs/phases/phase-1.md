# Phase 1 — Foundation

## What gets built

- pnpm + Turborepo monorepo: `apps/{api,worker,web}`, `packages/{db,domain,shared,adapters,ui}`, `tests/`.
- Docker Compose for local use (web, api, worker, postgres, redis, mailpit) that runs with no secrets.
- GitHub Actions: lint, format check, typecheck, unit tests with coverage, build, integration tests (Testcontainers), and E2E on `main` or PRs labelled `e2e`.
- Env validation with Zod at boot (`packages/shared/src/env.ts`); `.env.example` with every variable.
- Caldera design tokens as a Tailwind v4 `@theme` in `packages/ui`, and the app shell in `apps/web`.
- Better Auth (email + password, email verification, password reset, revoke sessions, Google when configured), with the organization plugin for the active organization.
- Organizations, memberships, the four roles, invitations with the console email adapter.
- Tenancy: a Prisma client extension that adds the organization filter, plus Postgres RLS with `SET LOCAL ROLE datoflow_app` and `app.organization_id`.
- Audit log skeleton: auth, organization, role and invitation events. Append-only by trigger.
- `/health/live` and `/health/ready`, request ids, JSON logs with redaction.
- Worker skeleton: a NestJS process with BullMQ connected and health endpoints. Jobs arrive in later phases.

## Requirements covered

AUTH-01, AUTH-02, ORG-01, ORG-02, ORG-03, CAP-04, AUD-01 (auth, role and invitation events).

## Tests

| Kind        | Where                                    | What                                                                                                                                                                                                     |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `packages/domain`                        | Every cell of the role table; last-Owner rule; invitation expiry, single use, email match; plan limits; default pipeline                                                                                 |
| Unit        | `packages/shared`                        | Env validation, strict schemas, audit metadata stripping                                                                                                                                                 |
| Unit        | `packages/adapters`                      | CAP-04 provider switching by env only                                                                                                                                                                    |
| Unit        | `packages/db`                            | Tenant filter on every operation; every tenant table has `organizationId`, an index and an RLS policy                                                                                                    |
| Integration | `tests/integration`                      | Sign-up, verification, sign-in, reset (single use, 30 min, 5/hour), revoke sessions, org creation, active org switch, members, invitations, audit, RLS at the database, health, rate limits, idempotency |
| Generated   | `tests/integration/cross-tenant.test.ts` | One cross-tenant case per route in the OpenAPI document; fails if a route has no case                                                                                                                    |
| E2E         | `tests/e2e/uf-4.spec.ts`                 | UF-4 Invite a teammate, in the browser, with axe checks                                                                                                                                                  |

## Gate

A fresh clone runs with `docker compose up` and no secrets; the generated cross-tenant suite passes for every route; UF-4 E2E passes.

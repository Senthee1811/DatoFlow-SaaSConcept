# DatoFlow

Follow-up enforcement for lead-generation agencies and small B2B service teams. Every open lead has an owner, a dated next step and a deadline, and DatoFlow shows you the ones that slipped.

The build plan is in [docs/MASTER_PROMPT.md](docs/MASTER_PROMPT.md). Progress is in [docs/STATUS.md](docs/STATUS.md), decisions in [docs/DECISIONS.md](docs/DECISIONS.md).

## Run it

Needs Docker. No accounts and no secrets.

```bash
docker compose -f infra/docker-compose.yml up --build
```

| What                                       | Where                           |
| ------------------------------------------ | ------------------------------- |
| App                                        | http://localhost:3000           |
| Emails (verification, invitations, resets) | http://localhost:8025 (Mailpit) |
| API docs                                   | http://localhost:4000/v1/docs   |

If port 3000 is taken, set both: `WEB_HOST_PORT=3300 APP_URL=http://localhost:3300`.

## Develop

Needs Node 24 and pnpm 12.

```bash
pnpm install
pnpm build            # all packages and apps
pnpm lint && pnpm format:check
pnpm typecheck
pnpm test             # unit tests, with the coverage gate on packages/domain
pnpm test:integration # Testcontainers Postgres and Redis, including the cross-tenant suite
pnpm test:e2e         # Playwright against a running Compose stack (E2E_BASE_URL, MAILPIT_URL)
```

For E2E, start the stack with a higher auth limit, since every browser in the run shares one IP:

```bash
RATE_LIMIT_AUTH_PER_MIN=200 docker compose -f infra/docker-compose.yml up -d --build --wait
pnpm --filter @datoflow/tests exec playwright install chromium
pnpm test:e2e
```

## Layout

```
apps/api       NestJS REST API under /v1, Better Auth at /v1/auth
apps/worker    NestJS + BullMQ background worker
apps/web       Next.js app; proxies /v1 to the API on the same origin
packages/db    Prisma schema, migrations, tenant extension
packages/domain    Pure rules: roles, plans, invitations, pipeline
packages/shared    Zod schemas, DTOs, error codes, env validation
packages/adapters  Email (console, SMTP, Resend)
packages/ui        Caldera design tokens and components
tests          Integration (Vitest + Testcontainers) and E2E (Playwright)
infra          Dockerfile and Compose
```

## Design

The UI uses the Caldera design system ([docs/MASTER_PROMPT.md §10](docs/MASTER_PROMPT.md)). UI work also follows the [unslop](.claude/skills/unslop/SKILL.md) skill by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Where the two differ, Caldera wins, because it is the product's own brand.

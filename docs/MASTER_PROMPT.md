# DatoFlow — Master Build Prompt

Paste this whole file into your AI coding agent (Claude Code or similar) at the root of an empty Git repository. Keep it in the repo as `docs/MASTER_PROMPT.md` so the agent can re-read it at the start of every session.

---

## 0. Your role and how to work

You are the lead engineer building **DatoFlow**, a multi-tenant SaaS product, from an empty repository to a deployed MVP. I am the founder and the only human on the project.

Work like this:

1. **Build in the 7 phases in section 12, in order.** Do not start a phase until the previous phase's exit gate passes in CI on a production build.
2. **At the start of each phase**, write a short plan to `docs/phases/phase-N.md` (what you will build, which requirement IDs it covers, what you will test), then build it without waiting for approval.
3. **Every requirement marked Must needs at least one automated test whose name starts with its ID**, for example `it('WF-07: replayed event creates no second execution')`. A requirement is not done until that test passes.
4. **Check current documentation before using any library.** Versions and APIs change. Read the official docs for Next.js, NestJS, Prisma, Better Auth, BullMQ, Tailwind CSS v4 and shadcn/ui before writing code against them, and pin exact versions in `package.json`.
5. **Never invent scope.** If something is not in this prompt, it is out of scope. If two rules here conflict, stop and ask me. Otherwise decide, write the decision to `docs/DECISIONS.md` in one line, and continue.
6. **Stop and ask me only for:** secrets or accounts you need me to create, a destructive action on real data, or a conflict in this prompt.
7. **At the end of each phase**, update `docs/STATUS.md` with: requirement IDs done, tests added, gate result, and anything deferred.
8. **Never claim something works unless you ran it.** Report failing tests and gaps plainly.

---

## 1. The product in one page

**What it is.** A follow-up enforcement layer for digital agencies (5–30 people) that run lead generation for clients, and for small B2B service teams. It is not a general CRM.

**One-line promise.** Every open lead has an owner, a dated next step and a deadline, and DatoFlow shows you the ones that slipped.

**The two features that must be excellent:**

- **Next-step guarantee.** Logging a touch on an open lead requires a new open, dated task, unless the lead moves to Won or Lost.
- **Stuck-lead radar.** Each stage has an SLA (default 72 h). Leads past it, or with an overdue next step, rise to the top of the dashboard and of each rep's "My day".

**North-star metric.** Next-step coverage = open leads with at least one open next step ÷ all open leads.

**Feature test.** Every feature must serve next-step coverage or time to first touch. Anything else waits.

### Definitions (use these words exactly, in code and UI)

| Term | Definition |
| --- | --- |
| Organization (workspace) | The tenant. Every record belongs to exactly one organization |
| Open lead | A lead whose stage is not Won or Lost and that is not archived |
| Next step | An open task linked to a lead, with a due date-time and an assignee |
| Stuck lead | An open lead with an overdue next step, or with no activity for longer than its stage SLA (default 72 h) |
| Time to first touch (TTFT) | From lead creation to the first human-initiated outbound activity (call, email, message or meeting). Automated acknowledgements do not count |
| Execution | One run of one workflow version for one triggering event |
| Sample data | Records with `isSample = true`. Excluded from analytics by default; deletable in one click |
| Activation | A new workspace's first real (non-sample) lead is touched within 24 h of capture |

---

## 2. Scope

**Build now (MVP, v1.0):** auth and organizations, 4 roles, invitations, sample workspace, leads, duplicate detection, CSV import and export, pipeline (kanban and table), tasks and the next-step rule, stuck-lead radar, workflow engine (4 triggers, 4 conditions, 5 actions), public capture forms, signed inbound webhooks, in-app and email reminders, core analytics, plans and entitlements, audit log.

**Design for, but do not build (v1.1):** WhatsApp adapter, agency client workspaces and reports, Merchant-of-Record checkout (Polar), custom lead fields, SSE live updates, manual lead merge, outbound webhooks, privacy export and delete. Leave the adapter interfaces and table columns in place so these slot in without a rewrite.

**Never build:** email inbox sync, calling or dialer, quotes and invoicing, a marketing email builder, native mobile apps.

---

## 3. Stack — everything must run at $0/month

Every managed service sits behind an adapter interface. **`docker compose up` on a fresh clone must run the whole product with no external account and no secret** (NFR-PORT-01).

| Layer | Use | Local fallback (no account) |
| --- | --- | --- |
| Web | Next.js (App Router), React, TypeScript strict, Tailwind CSS v4, shadcn/ui, Lucide icons, Recharts, React Hook Form | — |
| API | NestJS REST API, Zod validation, `@nestjs/swagger` + Scalar at `/v1/docs` | — |
| Worker | Separate NestJS process running BullMQ jobs | — |
| Database | PostgreSQL in Docker, Prisma with checked-in migrations | Same |
| Queue and cache | Redis (or Valkey) in Docker with AOF persistence, BullMQ | Same |
| Auth | Better Auth, self-hosted, with its organization plugin. Roles are stored in DatoFlow's own `OrganizationMembership` table | Same |
| Email | Adapter: `resend` \| `smtp` \| `console` | `console`, plus Mailpit in Compose |
| Bot protection | Adapter: Cloudflare Turnstile \| `noop` | `noop` (always passes, dev only) |
| File storage | Adapter: Cloudflare R2 (S3 API) \| local disk | Local disk volume |
| Billing | Adapter: `noop` now, `polar` in v1.1 | `noop` → UI says "Payments not configured" |
| Messaging | Adapter interface only (WhatsApp in v1.1) | `noop` |
| Errors | Sentry (Developer plan), off when no DSN | Off |
| Product analytics | PostHog, off when no key | Off |
| Uptime | Uptime Kuma (self-hosted container) | — |
| CI | GitHub Actions | — |
| Hosting | One Oracle Cloud Always Free ARM VM (Ampere A1), Dokploy, Docker Compose | — |
| Staging DB | Neon Free | — |
| Tests | Vitest, Playwright, Testcontainers, k6, axe-core | — |

**Do not use:** Vercel Hobby (non-commercial only), Render Free (services sleep; free Postgres expires), Supabase Free (projects pause), Upstash Free behind BullMQ (polling burns the quota), Clerk Free (member cap; custom roles are a paid add-on).

**Free-tier limits to code against** (checked November 2026; treat as configuration, never hard-code):

- Resend: 100 emails/day, 3,000/month, 1 domain. Add a per-day send counter and queue the overflow for the next day; daily digests go first.
- Cloudflare R2: 10 GB storage. Nightly backups keep 14 days, then delete.
- Sentry: 5,000 errors/month, 1 user. Sample and de-duplicate noisy errors.
- PostHog: 1M events/month. Track only the events in section 11.
- GitHub Actions: 2,000 minutes/month on private repos. Cache dependencies; run the full E2E suite on `main` and on PRs labelled `e2e`, not on every push.
- Oracle VM: assume 2 OCPU and 12 GB RAM, ARM64. All images must build for `linux/arm64`.

### Environment variables

Ship `.env.example` with every variable, a comment, and a safe default. Validate env with Zod at boot; fail fast with a clear message.

```
NODE_ENV, APP_URL, API_URL
DATABASE_URL, REDIS_URL
BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   # Google sign-in hidden when unset
SECRETS_ENCRYPTION_KEY                                       # AES-256-GCM key for stored secrets
EMAIL_PROVIDER=console|resend|smtp, RESEND_API_KEY, SMTP_URL, EMAIL_FROM
CAPTCHA_PROVIDER=noop|turnstile, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY
STORAGE_PROVIDER=local|r2, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
BILLING_PROVIDER=noop|polar, POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET
SENTRY_DSN, NEXT_PUBLIC_POSTHOG_KEY
```

Only `NEXT_PUBLIC_*` variables may reach the browser.

---

## 4. Repository layout

A pnpm + Turborepo monorepo:

```
apps/
  web/        Next.js app (marketing site + product UI)
  api/        NestJS REST API
  worker/     NestJS BullMQ worker (outbox publisher, workflows, reminders, imports, radar, backups)
packages/
  db/         Prisma schema, migrations, tenant extension, seed (sample workspace)
  domain/     Pure business rules: next-step rule, stuck-lead rule, metrics formulas, entitlements
  workflow/   Workflow engine: catalogue, state machine, idempotency, retries, loop protection
  shared/     Zod schemas and types shared by web and api; error codes
  adapters/   Email, captcha, storage, billing, messaging interfaces + implementations
  ui/         Design tokens, Tailwind theme, shared components
infra/
  docker-compose.yml          local: web, api, worker, postgres, redis, mailpit
  docker-compose.prod.yml     prod: + uptime-kuma, behind Dokploy's proxy
  backup/                     pg_dump script and restore runbook
docs/         MASTER_PROMPT.md, SRS notes, DECISIONS.md, STATUS.md, runbooks, phases/
.github/workflows/            ci.yml, e2e.yml
```

`packages/domain` and `packages/workflow` have no framework imports and need ≥ 80% line coverage (NFR-MAINT-01).

---

## 5. Non-negotiable engineering rules

**Tenancy (release blocker, NFR-SEC-01)**

- Every tenant table has `organizationId` NOT NULL and indexed.
- A Prisma client extension injects the organization filter into every query. Postgres Row-Level Security backs it up, using a per-request `SET LOCAL app.organization_id`.
- A request for another tenant's ID returns **404**, never 403.
- Generate a cross-tenant test for **every** route from the OpenAPI document. CI fails if a route has no such test.

**Authorization**

- Enforced in the API on every request, from the role in `OrganizationMembership`. The UI only hides what the API already forbids.
- The role table in section 6 is the source of truth; encode it once in `packages/domain` and test every cell.

**Input and output (NFR-SEC-02)**

- Zod `.strict()` schemas on every body, query and parameter. Unknown fields are rejected.
- Output DTOs never return internal fields (hashes, encrypted secrets, internal flags).

**Reliability**

- Every state change that can trigger automation writes an `OutboxEvent` **in the same transaction**. The worker publishes the outbox to BullMQ.
- Jobs must survive API and worker restarts. CI includes a kill-the-worker test (NFR-REL-01).
- All side effects are idempotent, keyed as described in WF-07 and TASK-04.

**Security**

- CSP, HSTS, `X-Content-Type-Options`. No `dangerouslySetInnerHTML` on user data. Redirects only to allow-listed URLs (NFR-SEC-03).
- Rate limits: auth 5/min per IP; public forms 10/min per IP; webhooks 60/min per integration; API 300/min per user. Over the limit returns 429 (NFR-SEC-04).
- Webhook secrets and API keys are stored hashed or encrypted (AES-256-GCM, key from env) and never logged. Add a log-redaction unit test (NFR-SEC-05).
- Uploads: CSV only, ≤ 5 MB, MIME and extension checked, parsed as a stream. On export, escape cells that start with `=`, `+`, `-` or `@` (NFR-SEC-06).
- No card data stored. Subscription state changes **only** from verified provider webhooks.
- Session cookies: httpOnly, Secure, SameSite=Lax.

**Code**

- TypeScript strict everywhere. ESLint and Prettier in CI.
- Database changes only through checked-in Prisma migrations. Never `prisma db push` outside local experiments.
- Times stored in UTC, shown in the organization's timezone (default `Asia/Colombo` for the first workspace).

**API conventions**

- REST under `/v1`, OpenAPI at `/v1/docs`.
- Errors as RFC 9457 `application/problem+json` with a stable `code` (for example `NEXT_STEP_REQUIRED`).
- Cursor pagination: `?cursor=&limit=`, limit up to 100.
- `Idempotency-Key` header accepted on all POSTs. `X-Request-Id` echoed back and present on every log line.
- Structured JSON logs. `/health/live` and `/health/ready` endpoints (NFR-OBS-01).

---

## 6. Roles and permissions

| Capability | Owner | Admin | Sales Manager | Sales Rep |
| --- | --- | --- | --- | --- |
| Billing, plan changes, delete organization | ✓ | – | – | – |
| Organization settings, pipelines, stage SLAs | ✓ | ✓ | – | – |
| Invite and remove members, change roles | ✓ | ✓ (not Owner) | – | – |
| Integrations, forms, webhook secrets | ✓ | ✓ | – | – |
| Create, edit, activate and pause workflows | ✓ | ✓ | ✓ | – |
| View leads | All | All | All | Assigned + unassigned pool\* |
| Edit leads | ✓ | ✓ | ✓ | Assigned only |
| Reassign leads | ✓ | ✓ | ✓ | – |
| CSV import, CSV export | ✓ | ✓ | ✓ | – |
| Archive and restore leads | ✓ | ✓ | ✓ | – |
| Team analytics | ✓ | ✓ | ✓ | Own metrics only |
| Audit log | ✓ | ✓ | – | – |

\* An organization setting, "Reps can see all leads", is off by default. The last Owner cannot be removed or demoted.

---

## 7. Functional requirements

48 requirements; 41 are **Must** (build now). **Should** and **Could** are v1.1 or later: leave room for them, do not build them.

### Auth and organizations

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| AUTH-01 | Sign up / sign in with email + password or Google; email verification; sign out | Must | Unverified users cannot create an org |
| AUTH-02 | Password reset; revoke all sessions | Must | Reset token single-use, 30-min expiry; 5 requests/hour per email |
| ORG-01 | Create an organization (name, slug, timezone, currency); creator becomes Owner | Must | Slug unique; a default 6-stage pipeline is created (4 open stages, Won, Lost) |
| ORG-02 | Belong to many organizations and switch the active one | Must | A request for an org without membership returns 404 |
| ORG-03 | Invite, resend, revoke; change roles; remove members | Must | Last Owner cannot be removed or demoted; token hash stored, 7-day expiry, single-use, must match invitee email |
| ORG-04 | Sample workspace: a fictional agency with 60 leads, 3 reps, 2 workflows, all `isSample` | Must | "Delete sample data" removes only sample records |

### Leads and import

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| LEAD-01 | Create, view, edit, archive, restore leads (name, company, email, phone, source, stage, owner, priority, deal value, notes, UTM fields, timestamps) | Must | Zod validation in the API; unknown fields rejected |
| LEAD-02 | Normalise: trim, lower-case email, E.164 phone using the org's default country | Must | Invalid email returns a field-level 422 |
| LEAD-03 | Detect possible duplicates on email, phone, or name + company | Must | Shows "Possible duplicate" with a link; never auto-merges |
| LEAD-04 | Manual merge with a field-by-field choice | Should | — |
| LEAD-05 | Search and filter by owner, stage, source, priority, date, stuck status; filters persist per user | Must | p95 under 300 ms with 10,000 leads |
| LEAD-06 | Activity timeline for every change, note, touch, task and workflow action | Must | Workflow changes show the actor as "Workflow: name" |
| IMP-01 | CSV import: upload (≤ 5 MB, ≤ 10,000 rows, UTF-8), map columns (mapping saved per org), 20-row preview with counts, one duplicate policy for the file (skip / create anyway / update), background job in batches of 500 with progress, final report | Must | A 10,000-row file finishes in under 2 min; error CSV downloadable |
| IMP-02 | CSV export of filtered leads and reports | Must | Exports audit-logged; formula cells escaped |

### Pipeline

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| PIPE-01 | Configure stages: add, rename, reorder, set SLA hours, mark as Won or Lost | Must | A stage that holds leads cannot be deleted until they are moved |
| PIPE-02 | Kanban with drag-and-drop and keyboard moves; table view | Must | An API error rolls back the optimistic move and shows a toast |
| PIPE-03 | Lost requires a loss reason; Won requires a deal value (org setting) | Must | The API rejects the move without them |
| PIPE-04 | Multiple pipelines per organization | Could | — |

### Tasks and the next-step rule

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| TASK-01 | Tasks with title, type (call, email, WhatsApp, meeting, other), due date-time, priority, assignee, lead, status | Must | Assignee must be a member of the same org |
| TASK-02 | Next-step rule: logging a touch on an open lead requires a new open task, unless the lead moves to Won or Lost | Must | API returns 422 `NEXT_STEP_REQUIRED`; an org can switch to "warn only" |
| TASK-03 | Overdue markers and stuck-lead radar using per-stage SLAs | Must | Recalculated on change and every 5 min |
| TASK-04 | Reminders: in-app 15 min before due; daily email digest at 08:00 org time | Must | Each reminder sent once (key: taskId + type + dueAt) |
| TASK-05 | "My day" view | Must | Order: overdue next steps, due today, then stuck leads assigned to the rep |

### Workflow automation

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| WF-01 | Builder: one trigger, AND-ed conditions, up to 10 ordered actions | Must | Saving creates an immutable `WorkflowVersion` |
| WF-02 | Triggers: `lead.created`, `lead.stage_changed`, `lead.assigned`, `task.deadline_reached` | Must | Each trigger has a fixture test |
| WF-03 | Conditions on source, stage, assignee, priority (is, is any of, is none of) | Must | False conditions record a SKIPPED execution |
| WF-04 | Actions: assign (user or round-robin), create task, schedule email (up to 30 days ahead), internal notification, update an allowed field (priority, stage, owner, tags) | Must | Fields outside the allow-list are rejected when the workflow is saved |
| WF-05 | Activate, pause, resume | Must | Queued runs of a paused workflow become CANCELLED |
| WF-06 | Execution log: status, attempts, timestamps, step results, error details; manual retry | Must | Retry allowed only for FAILED or DEAD runs |
| WF-07 | Idempotency: unique (workflowVersionId, eventId); side effects keyed by (executionId, stepIndex) | Must | A replayed event creates no second execution |
| WF-08 | Retries: up to 5 attempts, exponential backoff with jitter; non-retryable errors (validation, permission) fail fast | Must | After the last attempt the run is DEAD and Admins are notified |
| WF-09 | Loop protection: event depth ≤ 3; no self-triggering; per-org execution caps by plan | Must | Exceeding a cap records a SKIPPED run with the reason |

Model the execution as an explicit state machine in `packages/workflow`: `QUEUED → RUNNING → SUCCEEDED | SKIPPED | CANCELLED | FAILED → (retry) → DEAD`. Only the fixed catalogue above exists; there is no free-form scripting.

### Capture and integrations

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| CAP-01 | Public form builder (fields, consent checkbox, redirect allow-list) with an embed snippet | Must | Turnstile + honeypot; 10 submissions/min per IP |
| CAP-02 | Inbound webhooks: per-integration secret, HMAC-SHA256, 5-min timestamp window, replay protection | Must | Secret shown once; rotation keeps the old secret valid for 24 h |
| CAP-03 | Signed outbound webhooks on lead events | Should | — |
| CAP-04 | Email adapter: Resend, SMTP, console (dev) | Must | Switching provider needs only environment variables |
| CAP-05 | WhatsApp Cloud API adapter (customer's own account) | Should | — |

### Analytics

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| ANL-01 | Dashboard: new leads over time, by source, by stage, next-step coverage, stuck leads, median and P90 TTFT, follow-up completion, won and lost (count, value, win rate) | Must | Every number matches a SQL fixture in tests; sample data excluded by default |
| ANL-02 | Stage conversion, as a cohort by stage-entry date | Must | Formula shown in a tooltip on the chart |
| ANL-03 | Export any report to CSV | Must | Same numbers as the screen |
| ANL-04 | Agency client report as a read-only link | Should | — |

Write each metric formula once in `packages/domain/metrics`, with a doc comment that states it in plain words, and reuse it for the screen, the export and the tests.

### Notifications, billing and audit

| ID | Requirement | Pri | Acceptance |
| --- | --- | --- | --- |
| NOT-01 | In-app notification centre with unread count | Must | Mark one or all as read |
| NOT-02 | Live updates (SSE) | Should | For now, poll every 30 s |
| BILL-01 | Plans and entitlements as config; enforced in the API | Must | Over a limit returns 402 with the limit's name |
| BILL-02 | Monthly usage counters per org (leads, executions, emails) | Must | Counters match the database after a recount job |
| BILL-03 | Billing adapter: Noop by default; status changes only from verified webhooks | Must | Without credentials the UI says "Payments not configured" |
| AUD-01 | Audit log: auth events, roles, invitations, imports, exports, workflow changes, secrets, billing | Must | Append-only; never stores passwords, tokens or full secrets |
| AUD-02 | Export or delete one lead's personal data on request | Should | — |

### Plans (config, not code)

Keep this in one typed config file. These prices are hypotheses; the numbers must be easy to change.

| Plan | USD/mo | Users | Leads | Active workflows | Executions/mo | Adds |
| --- | --- | --- | --- | --- | --- | --- |
| Free | 0 | 2 | 250 | 1 | 500 | Sample workspace, 1 capture form |
| Starter | 19 | 5 | 2,500 | 5 | 5,000 | Email reminders, CSV import and export |
| Growth | 49 | 15 | 15,000 | 25 | 50,000 | Webhooks, per-stage SLAs, analytics export |
| Agency | 99 | 25 | 50,000 | Unlimited | 200,000 | Up to 10 client workspaces, client report (v1.1) |

---

## 8. User flows to implement

Each flow needs one Playwright E2E test named after it (`UF-1 … UF-8`).

**UF-1 Sign-up to first value.** Sign up → verify email → create organization (becomes Owner) → explore the sample workspace → add a capture form or import a CSV → first real lead arrives → it gets an owner and a dated next step → touched within 24 h? Yes: the workspace is activated. No: the owner is nudged and the next lead gets another chance. Sample data never counts.

**UF-2 Lead lifecycle.** A captured lead moves through the open stages; it can close as Won (deal value) or Lost (loss reason) from any open stage. The radar checks every open lead on each change and every 5 minutes; flagged leads go to the top of the dashboard and My day, and a manager can reassign them.

**UF-3 Automation run.** Event in outbox → first run for this (version, event)? No: dropped. → workflow active? No: CANCELLED. → depth ≤ 3 and under plan cap? No: SKIPPED with reason. → conditions true? No: SKIPPED. → run actions in order → all succeeded? Yes: SUCCEEDED. No → retryable and under 5 attempts? Yes: retry after backoff with jitter. No: DEAD, Admins notified, manual retry available.

**UF-4 Invite a teammate.** Owner or Admin enters an email and role (Admins cannot grant Owner) → seat entitlement checked (402 if full) → invitation created and emailed → invitee signs in or up → token valid, unused and matching the email? Yes: membership created, audit-logged, inviter notified. No: a clear screen with "Ask for a new invite".

**UF-5 Public form and webhook capture.** Form submit or `POST /v1/hooks/{integrationId}` → rate limit (429) → verify (forms: Turnstile + honeypot; webhooks: HMAC + 5-min window) → dedupe against `WebhookEvent` (duplicate returns 200 `{duplicate:true}`, nothing re-processed) → normalise and link possible duplicates → create the lead and the `lead.created` outbox event in one transaction → respond 202 → assignment rules and workflows run in the background.

**UF-6 CSV import.** As IMP-01.

**UF-7 Upgrade plan.** A limit prompt names the limit → Owner picks a plan → checkout session through the billing adapter → redirect to "Confirming payment" while the plan stays unchanged → only a verified webhook updates the subscription. With no billing credentials: "Payments not configured" and no plan can be bought.

**UF-8 A rep's day.** My day lists overdue next steps, then today's, then the rep's stuck leads → the rep logs a call or email from the lead panel → must set the next step before closing the panel, or mark the lead Won or Lost → reminders fire 15 minutes before each due next step, in-app and by email (the rep can choose).

---

## 9. Data model

26 tables. Use these names. Every tenant table carries `organizationId`.

| Entity | Key fields | Constraints and indexes |
| --- | --- | --- |
| User, Session, Account | email, name, emailVerified; auth-provider tables | unique(email) |
| Organization | name, slug, timezone, currency, settings JSON, planCode | unique(slug) |
| OrganizationMembership | userId, organizationId, role (OWNER, ADMIN, MANAGER, REP) | unique(userId, organizationId); index(organizationId, role) |
| Invitation | email, role, tokenHash, expiresAt, status | unique(tokenHash); index(organizationId, email) |
| Pipeline, PipelineStage | name; stage order, slaHours, kind (OPEN, WON, LOST) | unique(pipelineId, order) |
| LossReason | label, active | unique(organizationId, label) |
| Lead | name, company, emailNormalized, phoneE164, source, stageId, ownerId, priority, dealValue, currency, utm JSON, isSample, archivedAt, lastActivityAt | index(org, stageId), (org, ownerId), (org, emailNormalized), (org, phoneE164), (org, createdAt) |
| LeadDuplicate | leadId, candidateId, reason, status | unique(leadId, candidateId) |
| LeadActivity | leadId, type, actorType (USER, WORKFLOW, SYSTEM), actorId, payload JSON, occurredAt | index(org, leadId, occurredAt) |
| StageHistory | leadId, fromStageId, toStageId, enteredAt | index(org, toStageId, enteredAt) |
| Task | leadId, title, type, dueAt, priority, assigneeId, status, completedAt | index(org, assigneeId, status, dueAt) |
| Notification | userId, kind, payload, readAt | index(userId, readAt) |
| Workflow | name, status (DRAFT, ACTIVE, PAUSED), activeVersionId | index(org, status) |
| WorkflowVersion | workflowId, version, trigger, conditions JSON, actions JSON | unique(workflowId, version); immutable |
| WorkflowExecution | versionId, eventId, status, attempt, depth, startedAt, finishedAt, error | unique(versionId, eventId) |
| WorkflowExecutionStep | executionId, stepIndex, status, attempt, result, error | unique(executionId, stepIndex) |
| OutboxEvent | type, aggregateId, payload, depth, causationId, publishedAt | partial index where publishedAt is null |
| Integration | kind (FORM, WEBHOOK, EMAIL, WHATSAPP), config JSON, secretEnc, status | index(org, kind) |
| WebhookEvent | integrationId, dedupeKey (externalId or bodyHash), receivedAt, status | unique(integrationId, dedupeKey) |
| ImportJob | fileName, mapping, policy, counts, status, errorFileKey | index(org, createdAt) |
| Subscription | planCode, status, provider, providerRef, periodEnd | unique(organizationId) |
| UsageRecord | metric, period, count | unique(org, metric, period) |
| AuditLog | actorId, action, targetType, targetId, ip, userAgent, metadata | index(org, createdAt); append-only |

**Deletes.** Organizations soft-delete, then hard-delete after 30 days. Leads archive (soft). Memberships hard-delete. Audit logs are never deleted while the org exists.

### API surface

| Resource | Endpoints | Minimum role |
| --- | --- | --- |
| Auth | `/auth/*` (from Better Auth) | Public |
| Organizations | `GET/POST /orgs`, `GET/PATCH /orgs/:orgId` | Member / Admin |
| Members, invitations | `GET /orgs/:orgId/members`, `PATCH/DELETE …/members/:id`, `POST …/invitations`, `POST /invitations/:token/accept` | Admin (accept: invitee) |
| Leads | `GET/POST …/leads`, `GET/PATCH …/leads/:id`, `POST …/leads/:id/archive`, `POST …/leads/:id/restore` | Rep (scoped) / Manager |
| Activities | `GET/POST …/leads/:id/activities` | Rep (assigned) |
| Pipelines | `GET/POST/PATCH …/pipelines`, `PATCH …/pipelines/:id/stages` | Member / Admin |
| Tasks | `GET/POST …/tasks`, `PATCH …/tasks/:id`, `GET …/me/day` | Rep (own) |
| Workflows | `GET/POST …/workflows`, `POST …/workflows/:id/versions`, `POST …/workflows/:id/(activate\|pause)`, `GET …/executions`, `POST …/executions/:id/retry` | Manager |
| Imports, exports | `POST …/imports`, `GET …/imports/:id`, `POST …/imports/:id/confirm`, `GET …/exports/leads.csv` | Manager |
| Analytics | `GET …/analytics/(summary\|timeseries\|conversion\|ttft)` | Rep (own) / Manager |
| Integrations | `GET/POST/PATCH …/integrations`, `POST …/integrations/:id/rotate-secret` | Admin |
| Public capture | `POST /v1/public/forms/:formKey`, `POST /v1/hooks/:integrationId` | Public, CAPTCHA or signature |
| Billing | `GET …/billing`, `POST …/billing/checkout`, `POST /v1/billing/webhooks/:provider` | Owner / provider signature |
| Audit | `GET …/audit-logs` | Admin |

---

## 10. Design system — "Caldera"

The whole UI (marketing site and product) uses this system. Put the tokens in `packages/ui` as a Tailwind v4 `@theme` block and use them through utilities; never write raw hex values in components.

**Character.** Forge fire on warm limestone. Flat and shadowless. Heavy condensed display type carries the structure, one vivid orange carries the urgency, and everything is generously rounded.

### Tokens

```css
@theme {
  --color-ember: #fc5000;          /* primary actions, featured stat cards, "needs attention" */
  --color-plasma-violet: #524ae9;  /* hero halftone and one accent card only; never controls */
  --color-sulfur: #f5f28e;         /* tags, badges, small highlight washes */
  --color-limestone: #f7f6f2;      /* cards, content blocks, secondary fills */
  --color-pumice: #e2e2df;         /* page canvas */
  --color-obsidian: #070607;       /* text, headings, borders */
  --color-chalk: #ffffff;          /* text on dark sections only */

  --font-display: 'PP Neue Corp Compact', 'Anton', 'Bebas Neue', sans-serif;
  --font-body: 'DM Sans', ui-sans-serif, system-ui, sans-serif;

  --text-caption: 12px;     --leading-caption: 1.2;
  --text-body-sm: 14px;     --leading-body-sm: 1.2;
  --text-body: 16px;        --leading-body: 1.55;
  --text-subheading: 26px;  --leading-subheading: 1.2;
  --text-heading-sm: 30px;  --leading-heading-sm: 1.5;
  --text-heading: 32px;     --leading-heading: 1;
  --text-heading-lg: 48px;  --leading-heading-lg: 1;
  --text-heading-2xl: 80px; --leading-heading-2xl: 1.1;
  --text-heading-3xl: 96px; --leading-heading-3xl: 0.95;
  --text-display: 189px;    --leading-display: 0.94;

  --radius-small: 16px;  --radius-medium: 20px;  --radius-cards: 40px;
  --radius-buttons: 40px;  --radius-inputs: 100px;  --radius-pills: 800px;
}
```

Spacing scale (px): 4, 8, 9, 10, 12, 16, 18, 20, 24, 32, 40, 48, 56, 64, 80, 92. Page max-width 1280px; section gap 80px; card padding 40px; element gap 16px.

### Fonts

- **Display:** PP Neue Corp Compact is a commercial typeface. If licensed `.woff2` files exist in `apps/web/public/fonts/`, load them with `next/font/local` and enable `font-feature-settings: "ss06", "ss10"`. If not, use **Anton** through `next/font/google`. Never ship unlicensed font files. Display type always has `letter-spacing: 0.02em`, never negative tracking.
- **Body:** DM Sans at weight **500 only**. Never Regular, never Bold.
- **Captions (12px):** system sans-serif, weight 400.

### Rules

- **No shadows anywhere.** Layer with colour: Pumice canvas → Limestone cards → Ember features.
- **Primary button:** Ember fill, Obsidian text, full pill (800px), padding 12px 24px, DM Sans 500 16px.
- **Secondary button:** transparent, 1.5px solid Obsidian border, Obsidian text, 40px radius, padding 16px.
- **Ghost link / nav item:** no border, Obsidian text, pill radius, padding 0 12px.
- **Cards:** Limestone, 40px radius, 40px padding, no border.
- **Inputs:** pill (100px radius), 1.5px border.
- **Tags and badges:** Sulfur fill, Obsidian text, pill, DM Sans 500 12–14px.
- **Dividers:** 1.5px **dotted** Obsidian. Not dashed, not solid.
- **Navigation:** nav row inside a Limestone pill container on the Pumice canvas.
- **Only three chromatic colours:** Ember, Plasma Violet, Sulfur. Add no others. No photography, no 3D, no stock imagery. Icons are small, monochrome Lucide glyphs.
- **Signature motifs:** the halftone dot block (orange dots on a violet-to-orange gradient, 40px radius, built in CSS or SVG) and the oversized display headline.

### Applying it to DatoFlow (adaptations I have approved)

- **Marketing landing page:** full Caldera. A display headline up to 189px on desktop (scale down with `clamp()` to about 64px on phones), the halftone hero block, a row of Ember stat cards, a dark Obsidian section with a pill input for the waitlist or sign-up.
- **Product app:** the same tokens at working density. Page titles in display type at 48px; section titles at 32px; never set display type below 26px, so table headers, card titles and form labels use DM Sans. Dense surfaces (table rows, kanban lead cards, form groups) use the 20px radius and 16–24px padding; page-level cards keep 40px.
- **Accessibility wins over the reference (NFR-A11Y-01, WCAG 2.2 AA).** White on Ember is only about 3.3:1, so on Ember surfaces use **Obsidian** text for anything under 24px; Chalk is allowed only for large display numbers. Inputs on light surfaces use an Obsidian border and Obsidian text. Every interactive element has a visible 2px Obsidian focus ring with a 2px offset. Touch targets are at least 44px.
- **Status without new colours.** Stuck or overdue = Ember badge plus an icon and the word. Due today = Sulfur badge. Done or neutral = Limestone with Obsidian text. Never signal status by colour alone.
- **Kanban:** Pumice canvas, each stage column a Limestone block (40px radius), lead cards in Pumice (20px radius). A stuck lead card gets an Ember badge, not an Ember fill.
- **Dashboard:** next-step coverage and stuck-lead count are the two Ember stat cards at the top. The single Plasma Violet halftone card is reserved for the activation or empty-state banner. Charts (Recharts) use Obsidian, Ember and Plasma Violet for series, in that order, with direct labels; dotted Obsidian grid lines.
- **Empty states and auth screens** use the halftone block as artwork.
- Layouts are responsive from 360px wide. Use shadcn/ui primitives restyled to these tokens; remove their default shadows and small radii.

---

## 11. Non-functional targets

Sized for the MVP: up to 50 organizations and 10,000 leads each.

| Area | Target | Checked by |
| --- | --- | --- |
| API latency | p95 under 300 ms for lists, under 150 ms for single reads | k6 smoke test on staging |
| Web | Board with 500 cards interactive in under 1.5 s; landing-page LCP under 2.5 s | Lighthouse CI |
| Accessibility | WCAG 2.2 AA: contrast, focus states, keyboard moves on the board, labelled forms | axe checks in Playwright |
| Backups | Nightly `pg_dump` to object storage, kept 14 days; monthly restore drill | Runbook + drill log |
| Failures | Dead-letter state, Admin alert, manual retry in the UI | E2E test |
| Privacy | Collect only needed PII; store consent for form leads | Tests |
| Coverage | ≥ 80% lines on `packages/domain` and `packages/workflow` | CI gate |

**Product analytics events (PostHog), and no others:** `org_created`, `sample_deleted`, `lead_created` (with source type), `touch_logged`, `next_step_set`, `workflow_activated`, `import_completed`, `form_published`, `activation_reached`, `upgrade_prompt_shown`. Never send lead PII.

Do not show any uptime or SLA figure anywhere in the product or site.

---

## 12. Build phases and exit gates

Each gate must pass in CI on a production build before the next phase starts.

**Phase 1 — Foundation.** Monorepo, Docker Compose, CI, env validation, design tokens and app shell, Better Auth, organizations, memberships, the four roles, invitations (console email adapter), tenancy (Prisma extension + RLS), audit log skeleton, health endpoints.
Covers AUTH-01, AUTH-02, ORG-01, ORG-02, ORG-03, CAP-04, AUD-01 (auth, role and invitation events).
*Gate:* a fresh clone runs with `docker compose up` and no secrets; the generated cross-tenant test suite passes for every route; UF-4 E2E passes.

**Phase 2 — Leads and pipeline.** Lead CRUD, normalisation, duplicate detection, search and filters, activity timeline, stage configuration, kanban and table, Won/Lost rules, sample workspace seed.
Covers LEAD-01, LEAD-02, LEAD-03, LEAD-05, LEAD-06, PIPE-01, PIPE-02, PIPE-03, ORG-04.
*Gate:* LEAD-05 p95 under 300 ms with 10,000 seeded leads; keyboard moves work on the board; deleting sample data leaves real data untouched.

**Phase 3 — Tasks and the next-step rule.** Tasks, next-step rule, stuck-lead radar (on change and every 5 min), reminders and daily digest, notification centre, My day.
Covers TASK-01 to TASK-05, NOT-01.
*Gate:* UF-8 and UF-2 E2E pass; each reminder is sent exactly once across a worker restart.

**Phase 4 — Workflow engine.** Transactional outbox and publisher, the trigger/condition/action catalogue, immutable versions, state machine, idempotency, retries, dead-letter, loop protection, builder UI, execution log.
Covers WF-01 to WF-09.
*Gate:* UF-3 E2E passes; replay test and kill-the-worker test pass; ≥ 80% coverage on `packages/workflow`.

**Phase 5 — Capture and import.** Form builder and embed snippet, Turnstile adapter, inbound webhooks with HMAC and replay protection, secret rotation, CSV import and export, storage adapter.
Covers CAP-01, CAP-02, IMP-01, IMP-02.
*Gate:* UF-5 and UF-6 E2E pass; a 10,000-row import finishes in under 2 minutes; rate-limit tests return 429.

**Phase 6 — Analytics, billing and audit.** Metric formulas with SQL fixtures, dashboard, conversion cohort, report export, plans config, entitlement enforcement, usage counters and recount job, Noop billing adapter and the "Payments not configured" state, full audit coverage.
Covers ANL-01, ANL-02, ANL-03, BILL-01, BILL-02, BILL-03, AUD-01 (complete).
*Gate:* every dashboard number matches its fixture; over-limit calls return 402 with the limit name; UF-7 E2E passes on the Noop adapter; UF-1 E2E passes end to end.

**Phase 7 — Hardening and launch.** Security headers, rate limits everywhere, log redaction, axe and Lighthouse checks, k6 smoke test, nightly backup job and restore runbook, Sentry and PostHog wiring, landing page, production Compose file, deployment guide.
*Gate:* all 41 Must requirements have a passing ID-named test; all NFR checks pass; the app is deployed on the VM; one backup has been restored into a scratch database and the drill is logged.

---

## 13. Deployment (Phase 7)

Write `docs/DEPLOY.md` as a step-by-step runbook I can follow, covering:

1. **Oracle Cloud Always Free:** create the Ampere A1 ARM VM (Ubuntu), open ports 80 and 443 only, set up a firewall, SSH keys only, unattended security upgrades.
2. **Dokploy:** install it, connect the GitHub repo, deploy `infra/docker-compose.prod.yml` (web, api, worker, postgres, redis, uptime-kuma), set environment variables, attach the domain with automatic TLS. Keep Dokploy itself patched.
3. **Builds:** Dokploy builds from the repo on the VM. If builds starve the VM, switch to building `linux/arm64` images in GitHub Actions and pulling them.
4. **Cloudflare:** DNS, a Turnstile widget, an R2 bucket and API token for backups and exports.
5. **Resend:** verify the sending domain (SPF, DKIM), set `EMAIL_PROVIDER=resend`.
6. **Backups:** the worker runs nightly `pg_dump` to R2, keeps 14 days, and the runbook shows a restore.
7. **Monitoring:** Uptime Kuma checks on `/health/ready` for web and api; Sentry DSN; PostHog key.
8. **Staging:** the same Compose file pointed at a Neon Free database.

Postgres and Redis are never exposed to the public internet.

---

## 14. Definition of done

The MVP is done when:

- All 41 Must requirements have passing tests named by ID, and all eight UF E2E tests pass.
- The cross-tenant suite covers every route and passes.
- A fresh clone runs with `docker compose up` and no external accounts.
- The production stack runs on one free ARM VM, with every paid service either on its free tier or switched off.
- The UI follows section 10 with no shadows, no extra colours, and passing axe checks.
- `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/DEPLOY.md` and the backup runbook are current.

**Start now with Phase 1.** First reply with the Phase 1 plan and the pinned versions you will use after checking current docs, then begin building.

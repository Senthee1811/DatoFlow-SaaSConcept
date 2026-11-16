# Decisions

One line each, newest at the bottom.

- 2026-11-16 — Pinned TypeScript 6.0.3, not 7.0.2: `@nestjs/swagger`, `typescript-eslint` and `@thallesp/nestjs-better-auth` peer ranges stop at TS 6.
- 2026-11-16 — Pinned Prisma 7.10.1, not the `latest` tag 8.0.0-rc.33: 8 is a release candidate and Better Auth's Prisma adapter does not support it yet.
- 2026-11-16 — Pinned ioredis 5.11.1, not 6.0.0: 5.x is inside BullMQ 6's peer range and has a long track record; 6.0 is a new major.
- 2026-11-16 — Every package is ESM (`"type": "module"`, `nodenext`); NestJS 12 ships ESM-only.
- 2026-11-16 — NestJS dependencies are injected by explicit token (`@Inject(X)`), so no code relies on emitted decorator metadata.
- 2026-11-16 — Better Auth is mounted directly on Express at `/v1/auth` with `toNodeHandler`, ahead of the JSON parser, instead of through a third-party Nest wrapper.
- 2026-11-16 — The Better Auth organization plugin is used only for the session's active organization (`/v1/auth/organization/set-active`), with its `member` model mapped to `OrganizationMembership`. Its other endpoints return 404; organizations, roles and invitations go through DatoFlow's API so the role enum, hashed tokens, 7-day expiry and audit rules hold.
- 2026-11-16 — The web app proxies `/v1/*` to the API through a route handler (not a `rewrites()` entry, which is fixed at build time), so browser, cookies and API share one origin, SameSite=Lax cookies work without CORS, and `API_URL` is read at runtime.
- 2026-11-16 — Session cookies get `Secure` when `APP_URL` is https. Plain-http localhost cannot hold `__Secure-` cookies reliably, so local dev and CI run without it; production is https.
- 2026-11-16 — Auth events are written to the audit log of every organization the person belongs to; a person with no membership yet (sign-up) is only in the request log, since `AuditLog.organizationId` is NOT NULL.
- 2026-11-16 — Better Auth's built-in rate limiter is off; one Redis fixed-window limiter covers auth (5/min per IP on the credential and email-sending endpoints: sign-in, sign-up, reset, verify), the API (300/min per user) and password resets (5/hour per email). Reading the session, signing out and switching workspace are not counted, or normal navigation would trip the limit.
- 2026-11-16 — Tenant isolation runs as a NOLOGIN role `datoflow_app` (`SET LOCAL ROLE` per transaction) that RLS applies to. System work (membership lookup, org creation, accepting an invitation by token) runs as the table owner, which RLS does not apply to.
- 2026-11-16 — `AuditLog` is append-only by trigger: UPDATE always fails, DELETE only inside the future 30-day organization purge (`app.audit_purge = 'on'`).
- 2026-11-16 — A seat is a member or an open invitation, so inviting cannot overbook the plan's user limit. A new invitation to the same address revokes the old open one.
- 2026-11-16 — An invitation that cannot be accepted returns 409 `INVITATION_INVALID` with `reason` (EXPIRED, USED, REVOKED, EMAIL_MISMATCH). The web shows "Ask for a new invite".
- 2026-11-16 — UF-4 "inviter notified" is an email in Phase 1; the in-app notification follows with NOT-01 in Phase 3.
- 2026-11-16 — Listing members follows the API table (Admin minimum) for now; a lighter assignee list for Managers and Reps comes with tasks in Phase 3 if needed.
- 2026-11-16 — ORG-03 resend and revoke are `POST …/invitations/:id/resend` and `POST …/invitations/:id/revoke`; an invitation preview for the accept screen is `GET /v1/invitations/:token`. The API table names neither, but ORG-03 and UF-4 need them.
- 2026-11-16 — Postgres and Redis publish no host ports in the local Compose file. Nothing outside the Compose network needs them, and another local Postgres often holds 5432.
- 2026-11-16 — Minimum password length is 10 characters.
- 2026-11-16 — Display type falls back to Anton (Google Fonts) because no licensed PP Neue Corp Compact files exist in the repo; switching is a change to `apps/web/src/app/fonts.ts`.
- 2026-11-16 — Display headings are uppercase. That follows Caldera's oversized display headline; unslop's "no uppercase labels" rule yields to the product's own brand.
- 2026-11-16 — Local Compose sends email through SMTP to Mailpit (not the console adapter), so verification and invitation links can be clicked at http://localhost:8025. `.env.example` keeps `console` for running the API outside Docker.
- 2026-11-16 — pnpm 12 blocks dependency install scripts by default. Prisma's are allowed; the optional native extras (`msgpackr-extract`, `ssh2`, `cpu-features`, `protobufjs`, `@scarf/scarf`) are denied, which keeps ARM builds free of a compiler toolchain.
- 2026-11-16 — Integration tests run against the compiled API (`apps/api/dist`), so the code under test is what ships.

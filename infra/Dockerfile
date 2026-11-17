# One Dockerfile, three targets: api, worker, web. Builds for linux/amd64 and linux/arm64.
# Build from the repository root: docker build -f infra/Dockerfile --target api .

FROM node:24.22.3-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@12.8.1 \
  && npm cache clean --force
WORKDIR /repo

# Dependencies first, so source changes do not reinstall them.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/adapters/package.json packages/adapters/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/workflow/package.json packages/workflow/
COPY tests/package.json tests/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM deps AS build
COPY . .
RUN pnpm turbo run build --filter=@datoflow/api --filter=@datoflow/worker --filter=@datoflow/web

# ---- api (also runs migrations as the `migrate` service) ----
FROM base AS api
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo /repo
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

# ---- worker ----
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo /repo
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||4100)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/worker/dist/main.js"]

# ---- web: Next.js standalone output only ----
FROM node:24.22.3-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

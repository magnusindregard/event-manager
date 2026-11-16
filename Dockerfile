# One image definition for every Node app: docker build --build-arg APP=api|public-api|worker|db .
# APP=db builds the migration runner used by the Container Apps "migrate" job.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/public-api/package.json apps/public-api/
COPY apps/worker/package.json apps/worker/
COPY apps/admin/package.json apps/admin/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/schemas/package.json packages/schemas/
COPY packages/sdk/package.json packages/sdk/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@event-manager/${APP}...
RUN pnpm --filter @event-manager/${APP} deploy --prod /out

FROM node:22-slim
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
# api/public-api/worker start dist/main.js; the db image runs migrations.
CMD ["sh", "-c", "if [ -f dist/main.js ]; then exec node dist/main.js; else exec node dist/migrate-cli.js; fi"]

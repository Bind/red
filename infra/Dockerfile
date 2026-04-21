FROM oven/bun:1-alpine AS base
WORKDIR /app
RUN apk add --no-cache docker-cli git python3 make g++

FROM base AS install
COPY package.json bun.lock ./
COPY apps/ctl/package.json ./apps/ctl/
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/grs/package.json ./apps/grs/
COPY apps/web/package.json ./apps/web/
COPY apps/obs/package.json ./apps/obs/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/triage/package.json ./apps/triage/
COPY pkg/obs/package.json ./pkg/obs/
COPY pkg/health/package.json ./pkg/health/
COPY workflows/docs-review/package.json ./workflows/docs-review/
RUN bun install --frozen-lockfile

FROM base AS build-web
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
COPY package.json ./
RUN cd apps/web && bun run build

FROM base AS prod-install
COPY package.json bun.lock ./
COPY apps/ctl/package.json ./apps/ctl/
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/grs/package.json ./apps/grs/
COPY apps/web/package.json ./apps/web/
COPY apps/obs/package.json ./apps/obs/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/triage/package.json ./apps/triage/
COPY pkg/obs/package.json ./pkg/obs/
COPY pkg/health/package.json ./pkg/health/
COPY workflows/docs-review/package.json ./workflows/docs-review/
RUN bun install --frozen-lockfile

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=prod-install /app/node_modules ./node_modules
COPY apps/ctl ./apps/ctl
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json tsconfig.json ./
COPY --from=build-web /app/apps/web/dist ./apps/web/dist

EXPOSE 3000
ENV REDC_PORT=3000
ENV GIT_COMMIT=${GIT_COMMIT}
CMD ["bun", "run", "apps/ctl/index.ts"]

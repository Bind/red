FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
COPY apps/obs/package.json ./apps/obs/
COPY apps/ctl/package.json ./apps/ctl/
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/grs/package.json ./apps/grs/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/triage/package.json ./apps/triage/
COPY apps/web/package.json ./apps/web/
COPY pkg/obs/package.json ./pkg/obs/
COPY pkg/health/package.json ./pkg/health/
COPY workflows/docs-review/package.json ./workflows/docs-review/
RUN bun install --frozen-lockfile

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY apps/obs ./apps/obs
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json ./

ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 4090

CMD ["bun", "run", "apps/obs/src/index.ts"]

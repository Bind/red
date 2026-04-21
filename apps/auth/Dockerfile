FROM oven/bun:1.3.10 AS base

WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/ctl/package.json ./apps/ctl/
COPY apps/grs/package.json ./apps/grs/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/obs/package.json ./apps/obs/
COPY apps/triage/package.json ./apps/triage/
COPY apps/web/package.json ./apps/web/
COPY pkg/obs/package.json ./pkg/obs/
COPY pkg/health/package.json ./pkg/health/
COPY workflows/docs-review/package.json ./workflows/docs-review/
RUN bun install --frozen-lockfile

FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY apps/auth ./apps/auth
COPY pkg/obs ./pkg/obs
COPY package.json ./

WORKDIR /app/apps/auth

EXPOSE 4020

CMD ["bun", "run", "src/index.ts"]

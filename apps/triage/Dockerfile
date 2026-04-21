# Image is used for BOTH the triage HTTP service (default CMD) and the
# long-running smithers server (compose overrides CMD). git + ca-certs are
# installed because the propose workflow can push branches to grs.
FROM oven/bun:1-alpine AS base
WORKDIR /app
RUN apk add --no-cache git ca-certificates npm
RUN npm install -g @openai/codex@0.117.0

FROM base AS install
COPY package.json bun.lock ./
COPY apps/triage/package.json ./apps/triage/
COPY apps/ctl/package.json ./apps/ctl/
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/grs/package.json ./apps/grs/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/obs/package.json ./apps/obs/
COPY apps/web/package.json ./apps/web/
COPY pkg/obs/package.json ./pkg/obs/
COPY pkg/health/package.json ./pkg/health/
COPY workflows/docs-review/package.json ./workflows/docs-review/
RUN bun install --frozen-lockfile --production

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY apps/triage ./apps/triage
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json ./

ENV TRIAGE_PORT=7000
ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 7000 7331

CMD ["bun", "run", "apps/triage/src/index.ts"]

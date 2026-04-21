ARG WORKSPACE_DEPS_IMAGE=ghcr.io/bind/red-workspace-deps-debian:dev
FROM oven/bun:1.3.10 AS base

WORKDIR /app

FROM ${WORKSPACE_DEPS_IMAGE} AS workspace-deps

FROM workspace-deps AS install

FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/auth/node_modules ./apps/auth/node_modules
COPY apps/auth ./apps/auth
COPY pkg/obs ./pkg/obs
COPY package.json ./

WORKDIR /app/apps/auth

EXPOSE 4020

CMD ["bun", "run", "src/index.ts"]

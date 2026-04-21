ARG WORKSPACE_DEPS_IMAGE=red-workspace-deps-debian:dev
FROM oven/bun:1.3.10 AS base
WORKDIR /app

FROM ${WORKSPACE_DEPS_IMAGE} AS workspace-deps

FROM workspace-deps AS install

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/obs/node_modules ./apps/obs/node_modules
COPY apps/obs ./apps/obs
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json ./

ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 4090

CMD ["bun", "run", "apps/obs/src/index.ts"]

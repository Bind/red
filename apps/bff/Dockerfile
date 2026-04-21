ARG WORKSPACE_DEPS_IMAGE=red-workspace-deps-alpine:dev
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM ${WORKSPACE_DEPS_IMAGE} AS workspace-deps

FROM workspace-deps AS install

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/bff/node_modules ./apps/bff/node_modules
COPY apps/bff ./apps/bff
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json ./

ENV BFF_PORT=3001
ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 3001

CMD ["bun", "run", "apps/bff/src/index.ts"]

ARG WORKSPACE_DEPS_IMAGE=red-workspace-deps-alpine:dev
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM ${WORKSPACE_DEPS_IMAGE} AS workspace-deps

FROM workspace-deps AS install

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/mcp/node_modules ./apps/mcp/node_modules
COPY apps/mcp ./apps/mcp
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY pkg/server ./pkg/server
COPY package.json ./

ENV MCP_PORT=3002
ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 3002

CMD ["bun", "run", "apps/mcp/src/index.ts"]

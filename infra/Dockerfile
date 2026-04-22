ARG WORKSPACE_DEPS_IMAGE=red-workspace-deps-alpine:dev
FROM oven/bun:1-alpine AS base
WORKDIR /app
RUN apk add --no-cache docker-cli git python3 make g++

FROM ${WORKSPACE_DEPS_IMAGE} AS workspace-deps

FROM workspace-deps AS install

FROM base AS build-web
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
COPY package.json ./
RUN cd apps/web && bun run build

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/ctl/node_modules ./apps/ctl/node_modules
COPY apps/ctl ./apps/ctl
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json tsconfig.json ./
COPY --from=build-web /app/apps/web/dist ./apps/web/dist

EXPOSE 3000
ENV REDC_PORT=3000
ENV GIT_COMMIT=${GIT_COMMIT}
CMD ["bun", "run", "apps/ctl/index.ts"]

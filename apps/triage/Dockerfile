# Image is used for BOTH the triage HTTP service (default CMD) and the
# long-running smithers server (compose overrides CMD). git + ca-certs are
# installed because the propose workflow can push branches to grs.
ARG WORKSPACE_DEPS_IMAGE=red-workspace-deps-alpine:dev
FROM oven/bun:1-alpine AS base
WORKDIR /app
RUN apk add --no-cache git ca-certificates npm
RUN npm install -g @openai/codex@0.117.0

FROM ${WORKSPACE_DEPS_IMAGE} AS workspace-deps

FROM workspace-deps AS install

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/triage/node_modules ./apps/triage/node_modules
COPY apps/triage ./apps/triage
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json ./

ENV TRIAGE_PORT=7000
ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 7000 7331

CMD ["bun", "run", "apps/triage/src/index.ts"]

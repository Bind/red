FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
COPY apps/bff/package.json ./apps/bff/
COPY apps/ctl/package.json ./apps/ctl/
COPY apps/auth/package.json ./apps/auth/
COPY apps/grs/package.json ./apps/grs/
COPY apps/obs/package.json ./apps/obs/
COPY apps/web/package.json ./apps/web/
COPY pkg/obs/package.json ./pkg/obs/
COPY pkg/health/package.json ./pkg/health/
RUN bun install --frozen-lockfile --production

FROM base AS release
ARG GIT_COMMIT=unknown
COPY --from=install /app/node_modules ./node_modules
COPY apps/bff ./apps/bff
COPY pkg/obs ./pkg/obs
COPY pkg/health ./pkg/health
COPY package.json ./

ENV BFF_PORT=3001
ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 3001

CMD ["bun", "run", "apps/bff/src/index.ts"]

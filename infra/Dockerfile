FROM oven/bun:1-alpine AS base
WORKDIR /app
RUN apk add --no-cache docker-cli git python3 make g++

FROM base AS install
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/gs/package.json ./apps/gs/
COPY apps/web/package.json ./apps/web/
COPY pkg/obs/package.json ./pkg/obs/
RUN bun install --frozen-lockfile

FROM base AS build-web
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
COPY package.json ./
RUN cd apps/web && bun run build

FROM base AS prod-install
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/gs/package.json ./apps/gs/
COPY apps/web/package.json ./apps/web/
COPY pkg/obs/package.json ./pkg/obs/
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=prod-install /app/node_modules ./node_modules
COPY apps/api ./apps/api
COPY pkg/obs ./pkg/obs
COPY package.json tsconfig.json ./
COPY --from=build-web /app/apps/web/dist ./apps/web/dist

EXPOSE 3000
ENV REDC_PORT=3000
CMD ["bun", "run", "apps/api/index.ts"]

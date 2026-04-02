FROM oven/bun:1-alpine AS base
WORKDIR /app
RUN apk add --no-cache docker-cli git python3 make g++

FROM base AS install
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile

FROM base AS build-web
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/web/node_modules ./web/node_modules
COPY web ./web
COPY package.json ./
RUN cd web && bun run build

FROM base AS prod-install
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=prod-install /app/node_modules ./node_modules
COPY src ./src
COPY package.json tsconfig.json ./
COPY --from=build-web /app/web/dist ./web/dist

EXPOSE 3000
ENV REDC_PORT=3000
CMD ["bun", "run", "src/index.ts"]

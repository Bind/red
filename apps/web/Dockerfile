# Two-stage: build the Vite bundle with bun, then serve the static assets
# via nginx. The /health endpoint is a tiny static file so the service-health
# contract applies uniformly.
FROM oven/bun:1-alpine AS build
WORKDIR /app
ARG GIT_COMMIT=unknown

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY apps/ctl/package.json ./apps/ctl/
COPY apps/auth/package.json ./apps/auth/
COPY apps/bff/package.json ./apps/bff/
COPY apps/grs/package.json ./apps/grs/
COPY apps/obs/package.json ./apps/obs/
COPY pkg/obs/package.json ./pkg/obs/
COPY pkg/health/package.json ./pkg/health/
RUN bun install --frozen-lockfile

COPY apps/web ./apps/web
COPY package.json ./
ENV VITE_GIT_COMMIT=${GIT_COMMIT}
RUN cd apps/web && bun run build

FROM nginx:1.27-alpine AS release
ARG GIT_COMMIT=unknown
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

RUN printf '{"service":"web","status":"ok","commit":"%s"}\n' "${GIT_COMMIT}" \
    > /usr/share/nginx/html/health \
 && printf 'server {\n  listen 5173;\n  root /usr/share/nginx/html;\n  location = /health {\n    default_type application/json;\n  }\n  location / {\n    try_files $uri $uri/ /index.html;\n  }\n}\n' \
    > /etc/nginx/conf.d/default.conf

EXPOSE 5173

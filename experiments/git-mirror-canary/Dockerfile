FROM oven/bun:1.2.20

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock tsconfig.json biome.json ./
RUN bun install --frozen-lockfile

COPY src ./src

EXPOSE 4080

CMD ["bun", "run", "start"]

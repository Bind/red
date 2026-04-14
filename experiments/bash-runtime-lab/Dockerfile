FROM oven/bun:1.3.2

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends make \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* tsconfig.json biome.json ./
RUN bun install

COPY src ./src

CMD ["bun", "run", "src/index.ts"]

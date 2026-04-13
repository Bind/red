FROM oven/bun:1.3.2

WORKDIR /app

COPY package.json bun.lock* tsconfig.json biome.json ./
RUN bun install

COPY src ./src

CMD ["bun", "run", "src/index.ts"]

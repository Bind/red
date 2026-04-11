FROM oven/bun:1.3.9

WORKDIR /app

COPY package.json bun.lock tsconfig.json biome.json bunfig.toml ./
RUN bun install

COPY src ./src

EXPOSE 4090

CMD ["bun", "run", "src/index.ts"]

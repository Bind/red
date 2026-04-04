FROM oven/bun:1.3.10

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY README.md ./README.md
COPY compose ./compose

EXPOSE 4020

CMD ["bun", "run", "src/index.ts"]

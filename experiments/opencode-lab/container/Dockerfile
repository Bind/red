FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@1.2.24

WORKDIR /workspace

ENTRYPOINT ["opencode"]

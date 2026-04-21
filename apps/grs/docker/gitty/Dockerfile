FROM debian:bookworm-slim AS build

ARG GITTY_REF=291bc674c5105ccb00b27273e7772cf6120149d5
ARG ZIG_VERSION=0.16.0-dev.3061+9b1eaad13
ARG TARGETARCH

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git python3 xz-utils && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

RUN case "${TARGETARCH:-amd64}" in \
      amd64) zig_arch="x86_64" ;; \
      arm64) zig_arch="aarch64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://ziglang.org/builds/zig-${zig_arch}-linux-${ZIG_VERSION}.tar.xz" -o zig.tar.xz && \
    mkdir -p /opt/zig && \
    tar -xJf zig.tar.xz -C /opt/zig --strip-components=1

ENV PATH="/opt/zig:${PATH}"

COPY zig /src/gitty

WORKDIR /src/gitty

RUN if [ -e .git ]; then test "$(git rev-parse HEAD)" = "${GITTY_REF}"; fi

RUN zig build server-only -Doptimize=ReleaseFast
RUN zig build wasm -Doptimize=ReleaseSmall

FROM oven/bun:1

ARG GIT_COMMIT=unknown

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

COPY src /app/src
RUN mkdir -p /app/zig/zig-out/bin

COPY --from=build /src/gitty/zig-out/bin/gitty.wasm /app/zig/zig-out/bin/gitty.wasm

COPY --from=build /src/gitty/zig-out/bin/server /usr/local/bin/gitty-server
COPY docker/gitty/run-gitty.sh /usr/local/bin/run-gitty.sh

RUN chmod +x /usr/local/bin/run-gitty.sh

EXPOSE 8080

ENV GIT_COMMIT=${GIT_COMMIT}

ENTRYPOINT ["/usr/local/bin/run-gitty.sh"]

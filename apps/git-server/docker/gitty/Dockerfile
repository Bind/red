FROM debian:bookworm-slim AS build

ARG GITTY_REF=291bc674c5105ccb00b27273e7772cf6120149d5
ARG ZIG_VERSION=0.16.0-dev.3061+9b1eaad13
ARG ZIG_TARBALL=https://ziglang.org/builds/zig-aarch64-linux-${ZIG_VERSION}.tar.xz

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git python3 xz-utils && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

RUN curl -fsSL "${ZIG_TARBALL}" -o zig.tar.xz && \
    mkdir -p /opt/zig && \
    tar -xJf zig.tar.xz -C /opt/zig --strip-components=1

ENV PATH="/opt/zig:${PATH}"

COPY vendor/gitty /src/gitty

WORKDIR /src/gitty

RUN test "$(git rev-parse HEAD)" = "${GITTY_REF}"

RUN python3 - <<'PY'
from pathlib import Path
path = Path("/src/gitty/src/server.zig")
text = path.read_text()
old = '    var server = try net.IpAddress.listen(.{ .ip4 = .{ .bytes = .{ 0, 0, 0, 0 }, .port = port } }, io, .{ .reuse_address = true });'
new = '''    const address: net.IpAddress = .{ .ip4 = net.Ip4Address.unspecified(port) };
    var server = try address.listen(io, .{ .reuse_address = true });'''
if old in text:
    path.write_text(text.replace(old, new))
PY

RUN zig build server-only -Doptimize=ReleaseFast
RUN zig build wasm -Doptimize=ReleaseSmall

FROM oven/bun:1

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

COPY src /app/src
RUN mkdir -p /app/vendor/gitty/zig-out/bin

COPY --from=build /src/gitty/zig-out/bin/gitty.wasm /app/vendor/gitty/zig-out/bin/gitty.wasm

COPY --from=build /src/gitty/zig-out/bin/server /usr/local/bin/gitty-server
COPY docker/gitty/run-gitty.sh /usr/local/bin/run-gitty.sh

RUN chmod +x /usr/local/bin/run-gitty.sh

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/run-gitty.sh"]

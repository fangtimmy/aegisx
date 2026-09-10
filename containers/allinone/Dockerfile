# build context = repo root. Single-image appliance: server + web UI +
# solver tool chain in one container (AEGISX_EXEC_BACKEND=local — solver bash
# runs in this same container instead of separate docker tool boxes).
#
# Requires aegisx/solver:minimal to exist locally first (containers/solver):
#   docker buildx build -f containers/allinone/Dockerfile \
#     --platform linux/amd64 -t aegisx/allinone:latest .

# === web build (vite) ===
FROM --platform=linux/amd64 oven/bun:1.4 AS web-builder
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/shared/package.json apps/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN bun install --frozen-lockfile
COPY apps/shared apps/shared
COPY apps/web apps/web
RUN bun run build

# === server bundle (minified single file; no src, no node_modules) ==========
FROM --platform=linux/amd64 oven/bun:1.4 AS server-bundle
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/shared apps/shared
COPY apps/server/package.json apps/server/
RUN bun install --production --frozen-lockfile
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
# cpu-features/ssh2 (optional native deps of docker-modem) normally build their
# build/Release/*.node bindings in postinstall scripts, which --frozen-lockfile
# skips — but bun build must RESOLVE those require() paths to emit the asset.
# Placeholder files keep resolution happy; at runtime these code paths are
# never hit (same as the tsecbench image, which also ships without them).
RUN set -eux; \
    for spec in cpu-features:cpufeatures ssh2:sshcrypto; do \
      pkg="${spec%%:*}"; bin="${spec##*:}"; \
      d=$(find node_modules -type d -path "*node_modules/$pkg" | head -1); \
      if [ -n "$d" ]; then mkdir -p "$d/build/Release"; touch "$d/build/Release/$bin.node"; fi; \
    done
RUN bun build apps/server/src/index.ts --target=bun --minify --outdir=/out/server/dist

# === runtime: solver:minimal tool chain + bun + server + web ============
FROM aegisx/solver:minimal

# Layout constraint: the bundled server resolves its migrations at
# import.meta.dir/../../drizzle → /opt/aegisx/server/dist + /opt/aegisx/drizzle.
COPY --from=oven/bun:1.4 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=server-bundle /out/server/dist /opt/aegisx/server/dist
COPY --from=server-bundle /app/apps/server/drizzle /opt/aegisx/drizzle
COPY --from=web-builder /app/apps/web/dist /opt/aegisx-web

ENV AEGISX_DATA_DIR=/data \
    AEGISX_EXEC_BACKEND=local \
    AEGISX_BOOTSTRAP=1 \
    AEGISX_API_URL=http://127.0.0.1:3000 \
    AEGISX_WEB_DIR=/opt/aegisx-web \
    HOST=0.0.0.0 \
    PORT=3000

VOLUME /data
EXPOSE 3000
WORKDIR /workspace
CMD ["bun", "/opt/aegisx/server/dist/index.js"]

# build context = repo root. Shared build-stage image: compiles server + web UI
# into one self-contained executable — the same `bun run compile` the host uses
# — for the appliance images (allinone, tsecbench, xihulunjian) to COPY from.
#
#   docker buildx build -f containers/app-build/Dockerfile \
#     --platform linux/amd64 -t aegisx/app-build:latest .

FROM --platform=linux/amd64 oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/shared/package.json apps/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
# Full install, not --production: the vite build for the web assets runs in
# this same stage and vite is a devDependency.
RUN bun install --frozen-lockfile
COPY apps/shared apps/shared
COPY apps/web apps/web
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
# cpu-features/ssh2 (optional native deps of docker-modem) normally build their
# build/Release/*.node bindings in postinstall scripts, which --frozen-lockfile
# skips — but bun build must RESOLVE those require() paths to emit the asset.
# Placeholder files keep resolution happy; at runtime these code paths are
# never hit (every appliance image ships without them).
RUN set -eux; \
    for spec in cpu-features:cpufeatures ssh2:sshcrypto; do \
      pkg="${spec%%:*}"; bin="${spec##*:}"; \
      d=$(find node_modules -type d -path "*node_modules/$pkg" | head -1); \
      if [ -n "$d" ]; then mkdir -p "$d/build/Release"; touch "$d/build/Release/$bin.node"; fi; \
    done
# Single executable: Bun runtime + server JS + web SPA + drizzle migrations,
# consumed at runtime via the bunfs import.meta.dir fallbacks in app.ts / db.
RUN bun run compile

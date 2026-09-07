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

# === production deps (server + shared source; no dev tools) ===
FROM --platform=linux/amd64 oven/bun:1.4 AS server-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/shared apps/shared
COPY apps/server/package.json apps/server/
RUN bun install --production --frozen-lockfile
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle

# === runtime: solver:minimal tool chain + bun + server + web ============
FROM aegisx/solver:minimal

COPY --from=oven/bun:1.4 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=server-deps /app /opt/aegisx
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
CMD ["bun", "/opt/aegisx/apps/server/src/index.ts"]

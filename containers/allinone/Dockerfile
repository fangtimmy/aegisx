# build context = repo root. Single-image appliance: server + web UI +
# solver tool chain in one container (AEGISX_EXEC_BACKEND=local — solver bash
# runs in this same container instead of separate docker tool boxes).
#
# Requires aegisx/app-build:latest (containers/app-build) and
# aegisx/solver:minimal (containers/solver) to exist locally first:
#   docker buildx build -f containers/allinone/Dockerfile \
#     --platform linux/amd64 -t aegisx/allinone:latest .

FROM aegisx/solver:minimal

# The compiled executable embeds the Bun runtime, the web SPA and the baseline
# migrations — no other build artifacts needed at runtime.
COPY --from=aegisx/app-build:latest /app/dist/aegisx /opt/aegisx/aegisx

ENV AEGISX_DATA_DIR=/data \
    AEGISX_EXEC_BACKEND=local \
    AEGISX_BOOTSTRAP=1 \
    AEGISX_API_URL=http://127.0.0.1:3000 \
    HOST=0.0.0.0 \
    PORT=3000

VOLUME /data
EXPOSE 3000
WORKDIR /workspace
CMD ["/opt/aegisx/aegisx"]

# build context = repo root. TSecBench all-in-one appliance: server + web UI +
# scheduler + solver toolchain in one container (AEGISX_EXEC_BACKEND=local —
# solver bash runs in this same container). Built for the offline TSecBench
# evaluation: no runtime network beyond the platform VPN, so every tool the
# 2026-09-08 full run actually used ships in the image.
#
# Tuned defaults are applied at build time by rewriting two source files
# (tuning.sed) before the server is bundled — no env/config plumbing needed:
#   - bootstrap event promptHint → TSecBench platform brief
#   - scheduler_config defaults → maxConcurrentTargets 3, stopSubmitterOnSolve true
#
#   docker buildx build -f containers/tsecbench/Dockerfile \
#     --platform linux/amd64 -t aegisx/tsecbench:v2 .

# === web build (vite) ========================================================
FROM oven/bun:1.4 AS web-builder
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/shared/package.json apps/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN bun install --frozen-lockfile
COPY apps/shared apps/shared
COPY apps/web apps/web
RUN bun run build

# === server bundle (single 13MB file replaces node_modules) ==================
FROM oven/bun:1.4 AS server-bundle
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/shared/package.json apps/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
# --trust: cpu-features/ssh2 postinstall must run so their native bindings
# exist for bun build to pick up as assets (host installs get them, bare
# containers do not). Mutually exclusive with --frozen-lockfile; bun.lock
# still pins the versions.
RUN bun install --trust
COPY apps/shared apps/shared
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
# TSecBench tuning: rewrite before bundling (see file header).
COPY containers/tsecbench/tuning.sed /tmp/tuning.sed
RUN sed -i -f /tmp/tuning.sed \
      apps/server/src/bootstrap.ts \
      apps/server/src/run/scheduler-admin.ts
# Optional native deps (cpu-features, ssh2) ship no prebuilt in a bare
# container, and their install scripts can't run here — but bun build must
# RESOLVE their `require('../build/Release/*.node')` to emit the asset.
# Placeholder files keep resolution happy; at runtime these code paths are
# never hit (same as the allinone image, which also ships without them).
RUN set -eux; \
    for spec in cpu-features:cpufeatures ssh2:sshcrypto; do \
      pkg="${spec%%:*}"; bin="${spec##*:}"; \
      d=$(find node_modules -type d -path "*node_modules/$pkg" | head -1); \
      if [ -n "$d" ]; then mkdir -p "$d/build/Release"; touch "$d/build/Release/$bin.node"; fi; \
    done
RUN bun build apps/server/src/index.ts --target=bun --outdir=/out/server/dist

# === knowledge bases (git lives only in this stage) ==========================
FROM kalilinux/kali-rolling AS knowledges
RUN apt-get update -qq && apt-get -y install --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
# Offline-relevant docs only: libc-database needs network to fetch libc files,
# vulhub needs docker pulls — both useless disconnected, so they are dropped.
RUN set -eux; \
    git clone --depth=1 https://github.com/swisskyrepo/PayloadsAllTheThings.git /opt/solver/knowledges/PayloadsAllTheThings; \
    git clone --depth=1 https://github.com/swisskyrepo/InternalAllTheThings.git /opt/solver/knowledges/InternalAllTheThings; \
    git clone --depth=1 https://github.com/HackTricks-wiki/hacktricks.git /opt/solver/knowledges/hacktricks; \
    git clone --depth=1 https://github.com/HackTricks-wiki/hacktricks-cloud.git /opt/solver/knowledges/hacktricks-cloud; \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +; \
    find /opt/solver/knowledges -type f \
      \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' \
         -o -name '*.webp' -o -name '*.svg' -o -name '*.mp4' -o -name '*.pdf' \) -delete

# === runtime ==================================================================
FROM kalilinux/kali-rolling
ARG KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
ARG PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/web/simple
ENV DEBIAN_FRONTEND=noninteractive TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PATH="/opt/venv/bin:${PATH}" \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 \
    KNOWLEDGES_DIR=/opt/solver/knowledges
RUN sed -Ei "s@https?://http\.kali\.org/kali@${KALI_MIRROR}@g" /etc/apt/sources.list.d/kali.sources

# Base toolchain: everything the 2026-09-08 run invoked (bash-level analysis),
# minus git/perl-suite/systemd ballast from the generic tiers.
RUN --mount=type=cache,id=tsec-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=tsec-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    apt-get -y install --no-install-recommends \
      ca-certificates curl wget less binutils gdb strace ltrace file \
      procps psmisc ripgrep fd-find jq yq bc zip unzip p7zip-full unrar xxd \
      netcat-openbsd ncat socat sshpass openssh-client ftp telnet \
      dnsutils iproute2 net-tools \
      python3.13-venv && \
    rm -rf /var/lib/apt/lists/*

# Security tooling + wordlists. seclists ships 1.9GB — keep Discovery/Web-Content
# whole (text, compresses well, breadth beats curation when offline) plus the
# referenced password lists; prune the rest. qemu-user ships ~20 emulators at
# ~15MB each; keep x86/i386/arm/aarch64 plus mips/mipsel (embedded firmware).
RUN --mount=type=cache,id=tsec-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=tsec-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    apt-get -y install --no-install-recommends \
      nmap masscan ffuf gobuster feroxbuster dirsearch wfuzz sqlmap hydra nikto \
      radare2 binwalk upx-ucl checksec \
      default-mysql-client php-cli php-mysql php-curl php-xml \
      qemu-user-binfmt tesseract-ocr seclists wordlists && \
    S=/usr/share/seclists K=/usr/share/seclists.keep && \
    mkdir -p "$K/Discovery" "$K/Passwords/Common-Credentials" "$K/Passwords/Keyboard-Walks" && \
    mv "$S/Discovery/Web-Content" "$K/Discovery/" && \
    C="$S/Passwords/Common-Credentials" && T="$K/Passwords/Common-Credentials" && \
    for f in 10k-most-common.txt xato-net-10-million-passwords-1000.txt \
             xato-net-10-million-passwords-10000.txt Pwdb_top-10000.txt \
             darkweb2017_top-10000.txt probable-v2_top-12000.txt best1050.txt; do \
      [ -f "$C/$f" ] && mv "$C/$f" "$T/"; done; \
    [ -d "$S/Passwords/Keyboard-Walks" ] && mv "$S/Passwords/Keyboard-Walks"/* "$K/Passwords/Keyboard-Walks/"; \
    [ -f "$S/Passwords/corporate_passwords.txt" ] && mv "$S/Passwords/corporate_passwords.txt" "$K/Passwords/"; \
    rm -rf "$S" && mv "$K" "$S" && \
    gunzip -f /usr/share/wordlists/rockyou.txt.gz 2>/dev/null || true; \
    find /usr/share/wordlists -mindepth 1 -maxdepth 1 \
      ! -name rockyou.txt ! -name dirb -exec rm -rf {} + ; \
    find /usr/bin -name 'qemu-*' \
      ! -name 'qemu-x86_64' ! -name 'qemu-i386' \
      ! -name 'qemu-aarch64' ! -name 'qemu-arm' \
      ! -name 'qemu-mips' ! -name 'qemu-mipsel' -delete; \
    W=/usr/share/seclists/Discovery/Web-Content && \
    P=/usr/share/seclists/Passwords/Common-Credentials && \
    ln -sf "$W/DirBuster-2007_directory-list-2.3-small.txt"  "$W/directory-list-2.3-small.txt" && \
    ln -sf "$W/DirBuster-2007_directory-list-2.3-medium.txt" "$W/directory-list-2.3-medium.txt" && \
    ln -sf "$P/xato-net-10-million-passwords-1000.txt"  "$P/10-million-password-list-top-1000.txt" && \
    ln -sf "$P/xato-net-10-million-passwords-10000.txt" "$P/10-million-password-list-top-10000.txt" && \
    test -s "$W/directory-list-2.3-medium.txt" && \
    test -s "$P/10-million-password-list-top-10000.txt"; \
    rm -rf /var/lib/apt/lists/*

# Offline rev helper: jdb needs a full JDK (c-04's solve path attaches to a
# Java debug port).
RUN --mount=type=cache,id=tsec-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=tsec-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    apt-get -y install --no-install-recommends openjdk-21-jdk-headless && \
    rm -rf /var/lib/apt/lists/*

# Python venv: the pwn/crypto stack + symbolic execution (angr) + the client
# libs the run missed (telnetlib was dropped from py3.13; AI-service targets
# wanted gradio/ws/yaml).
RUN --mount=type=cache,id=tsec-pip,target=/root/.cache/pip,sharing=locked \
    python3.13 -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install \
      pwntools pycryptodome pycryptodomex gmpy2 z3-solver capstone pyelftools \
      scapy requests angr \
      telnetlib3 gradio_client websockets pyyaml aiohttp pymysql

# App artifacts. Layout constraint: the bundled server resolves its migrations
# at import.meta.dir/../../drizzle → /opt/aegisx/server/dist + /opt/aegisx/drizzle.
COPY --from=oven/bun:1.4 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=server-bundle /out/server/dist /opt/aegisx/server/dist
COPY --from=server-bundle /app/apps/server/drizzle /opt/aegisx/drizzle
COPY --from=web-builder /app/apps/web/dist /opt/aegisx-web
COPY apps/sdk/python /opt/aegisx-sdk
COPY --from=knowledges /opt/solver/knowledges /opt/solver/knowledges

# Environment doc: build-time self-introspection, then replace the networked
# "install SOP" section — this image runs disconnected.
RUN --mount=type=bind,src=containers/solver/gen-environment.py,target=/tmp/gen-environment.py \
    python3 /tmp/gen-environment.py > /opt/solver/ENVIRONMENT.md && \
    python3 - <<'PY'
import re
p = "/opt/solver/ENVIRONMENT.md"
s = open(p).read()
offline = """## 离线环境（重要）

本镜像为断网评测构建: 没有公网, 只有 VPN 内的靶机网段可达。
**不要尝试 `pip install` / `apt-get install`** — 会直接失败。
预装工具见上文清单; 缺工具时换不需要该工具的技术路线, 不要在安装上耗时。
"""
s = re.sub(r"## 缺工具时的安装 SOP.*?(?=\n## |\Z)", offline, s, flags=re.S)
open(p, "w").write(s)
PY
RUN echo tsecbench > /opt/solver/VARIANT

ENV AEGISX_DATA_DIR=/data \
    AEGISX_EXEC_BACKEND=local \
    AEGISX_BOOTSTRAP=1 \
    AEGISX_ENQUEUE_ALL=1 \
    AEGISX_API_URL=http://127.0.0.1:3000 \
    AEGISX_WEB_DIR=/opt/aegisx-web \
    HOST=0.0.0.0 \
    PORT=3000

VOLUME /data
EXPOSE 3000
WORKDIR /workspace
CMD ["bun", "/opt/aegisx/server/dist/index.js"]

# build context = repo root. Competition all-in-one appliances: server + web UI
# + scheduler + solver toolchain in one container (AEGISX_EXEC_BACKEND=local —
# solver bash runs in this same container). Offline finals/eval images: no
# runtime network beyond the platform gateway/VPN, so every tool the runs
# actually used ships in the image. Tuning ships as DATA, not build-time source
# rewrites: each target's preset.json is copied to /opt/aegisx-preset/preset.json
# and applied by bootstrap on first boot (see the per-target manuals).
#
# One ladder, two targets — build with an explicit --target:
#   docker buildx build -f containers/appliance/Dockerfile \
#     --platform linux/amd64 --target tsecbench   -t aegisx/tsecbench:v12 .
#   docker buildx build -f containers/appliance/Dockerfile \
#     --platform linux/amd64 --target xihulunjian -t aegisx/xihulunjian:v2 .
# Requires aegisx/app-build:latest to exist locally first (containers/app-build).
# Per-target manuals: tsecbench/README.md, xihulunjian/README.md.

# === knowledge bases (git lives only in this stage) ==========================
FROM kalilinux/kali-rolling AS knowledges
RUN apt-get update -qq && apt-get -y install --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
# Offline-relevant docs only: libc-database needs network to fetch libc files,
# vulhub needs docker pulls — both useless disconnected, so they are dropped.
# nuclei-templates is the offline CVE/PoC index (known-product attacks were the
# main path on the 2026 runs); engines needing extra nuclei runtimes are pruned.
RUN set -eux; \
    git clone --depth=1 https://github.com/swisskyrepo/PayloadsAllTheThings.git /opt/solver/knowledges/PayloadsAllTheThings; \
    git clone --depth=1 https://github.com/swisskyrepo/InternalAllTheThings.git /opt/solver/knowledges/InternalAllTheThings; \
    git clone --depth=1 https://github.com/HackTricks-wiki/hacktricks.git /opt/solver/knowledges/hacktricks; \
    git clone --depth=1 https://github.com/HackTricks-wiki/hacktricks-cloud.git /opt/solver/knowledges/hacktricks-cloud; \
    git clone --depth=1 https://github.com/projectdiscovery/nuclei-templates.git /opt/nuclei-templates; \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +; \
    rm -rf /opt/nuclei-templates/.git /opt/nuclei-templates/.github \
           /opt/nuclei-templates/head /opt/nuclei-templates/javascript \
           /opt/nuclei-templates/helpers; \
    find /opt/solver/knowledges -type f \
      \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' \
         -o -name '*.webp' -o -name '*.svg' -o -name '*.mp4' -o -name '*.pdf' \) -delete

# === shared runtime toolchain ================================================
FROM kalilinux/kali-rolling AS toolchain
# Cache mount ids are shared with the pre-merge tsecbench/xihulunjian images on
# purpose: one local apt/pip cache serves every appliance build.
ARG KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
ARG PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/web/simple
ENV DEBIAN_FRONTEND=noninteractive TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PATH="/opt/venv/bin:${PATH}" \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 \
    KNOWLEDGES_DIR=/opt/solver/knowledges
RUN sed -Ei "s@https?://http\.kali\.org/kali@${KALI_MIRROR}@g" /etc/apt/sources.list.d/kali.sources

# Base toolchain: everything the 2026-09-08 TSecBench run invoked (bash-level
# analysis), minus git/perl-suite/systemd ballast from the generic tiers — the
# same stack battle-tested on the xihulunjian 2026-09-10/11 finals rehearsal.
RUN --mount=type=cache,id=tsec-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=tsec-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    apt-get -y install --no-install-recommends \
      ca-certificates curl wget less binutils gdb strace ltrace file \
      procps psmisc ripgrep fd-find jq yq bc zip unzip p7zip-full unrar xxd \
      netcat-openbsd ncat socat sshpass openssh-client ftp telnet \
      dnsutils iproute2 net-tools sqlite3 time \
      python3.13-venv && \
    rm -rf /var/lib/apt/lists/*

# Security tooling + wordlists. seclists ships 1.9GB — keep Discovery/Web-Content
# whole (text, compresses well, breadth beats curation when offline) plus the
# referenced password lists; prune the rest. qemu-user ships ~20 emulators at
# ~15MB each; keep x86/i386/arm/aarch64 plus mips/mipsel (embedded firmware).
# exploitdb/ghidra: cut in v4-v6 on the <1GB budget, restored on the 3GB one —
# both were real solve-path attempts on the 2026-09-08 run (searchsploit on
# c-01/b-02/c-09, ghidra-analyze on f2-05's custom-VM binary).
RUN --mount=type=cache,id=tsec-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=tsec-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    apt-get -y install --no-install-recommends \
      nmap masscan ffuf gobuster feroxbuster dirsearch wfuzz sqlmap hydra nikto \
      chisel whatweb nuclei exploitdb \
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
    ln -sf "$(command -v fdfind)" /usr/local/bin/fd; \
    W=/usr/share/seclists/Discovery/Web-Content && \
    P=/usr/share/seclists/Passwords/Common-Credentials && \
    ln -sf "$W/DirBuster-2007_directory-list-2.3-small.txt"  "$W/directory-list-2.3-small.txt" && \
    ln -sf "$W/DirBuster-2007_directory-list-2.3-medium.txt" "$W/directory-list-2.3-medium.txt" && \
    ln -sf "$P/xato-net-10-million-passwords-1000.txt"  "$P/10-million-password-list-top-1000.txt" && \
    ln -sf "$P/xato-net-10-million-passwords-10000.txt" "$P/10-million-password-list-top-10000.txt" && \
    test -s "$W/directory-list-2.3-medium.txt" && \
    test -s "$P/10-million-password-list-top-10000.txt"; \
    rm -rf /var/lib/apt/lists/*

# Offline rev helper: jdb needs a full JDK (Java debug attach); ghidra covers
# the headless-decompile path (custom VM binaries), exposed as ghidra-analyze —
# the name agents actually reach for.
RUN --mount=type=cache,id=tsec-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=tsec-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    apt-get -y install --no-install-recommends openjdk-21-jdk-headless ghidra && \
    A=$(find /usr/share/ghidra -name analyzeHeadless 2>/dev/null | head -1) && \
    ln -sf "$A" /usr/local/bin/ghidra-analyze && \
    rm -rf /var/lib/apt/lists/* && \
    test -x /usr/local/bin/ghidra-analyze

# Python venv: the pwn/crypto stack + symbolic execution (angr) + the client
# libs the run missed (telnetlib was dropped from py3.13; AI-service targets
# wanted gradio/ws/yaml). Pillow backs image handling beside tesseract;
# flask-unsign[wordlist] is the b-03 solve path — the run pip-installed it
# at runtime while the box still had egress, which the offline eval won't.
RUN --mount=type=cache,id=tsec-pip,target=/root/.cache/pip,sharing=locked \
    python3.13 -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install \
      pwntools pycryptodome pycryptodomex gmpy2 z3-solver capstone pyelftools \
      scapy requests angr \
      telnetlib3 gradio_client websockets pyyaml aiohttp pymysql \
      Pillow 'flask-unsign[wordlist]'

# App executable: single binary embedding the Bun runtime, the web SPA and the
# baseline migrations (see containers/app-build). SDK path is fixed.
COPY --from=aegisx/app-build:latest /app/dist/aegisx /opt/aegisx/aegisx
COPY apps/sdk/python /opt/aegisx-sdk
COPY --from=knowledges /opt/solver/knowledges /opt/solver/knowledges
COPY --from=knowledges /opt/nuclei-templates /usr/share/nuclei-templates
# nuclei auto-discovers ~/nuclei-templates — the symlink keeps it offline
# (otherwise the first run tries to download templates and fails).
RUN ln -sf /usr/share/nuclei-templates /root/nuclei-templates

# PYTHONPATH must point at the in-image SDK: solver bash execs inherit the
# server process env (local backend has no container-ENV indirection), and
# prompts promise `import aegisx` just works. UNATTENDED: boot recovery must
# not pause events with visible queue items — nobody can resume them mid-eval.
ENV AEGISX_DATA_DIR=/data \
    AEGISX_EXEC_BACKEND=local \
    AEGISX_BOOTSTRAP=1 \
    AEGISX_UNATTENDED=1 \
    AEGISX_API_URL=http://127.0.0.1:3000 \
    PYTHONPATH=/opt/aegisx-sdk \
    HOST=0.0.0.0 \
    PORT=3000

VOLUME /data
EXPOSE 3000
WORKDIR /workspace
CMD ["/opt/aegisx/aegisx"]

# === tsecbench target =========================================================
FROM toolchain AS tsecbench
COPY containers/appliance/tsecbench/preset.json /opt/aegisx-preset/preset.json
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

# === xihulunjian target =======================================================
FROM toolchain AS xihulunjian
# Legacy JDK 8 runtime for jar targets that install a SecurityManager at boot
# (removed in modern JDKs; QL_again local reproduction).
RUN curl -sL -o /tmp/t8.tar.gz \
      'https://api.adoptium.net/v3/binary/latest/8/ga/linux/x64/jre/hotspot/normal/eclipse?project=jdk' && \
    mkdir -p /opt/jdk8 && tar xzf /tmp/t8.tar.gz -C /opt/jdk8 --strip-components=1 && \
    rm /tmp/t8.tar.gz && test -x /opt/jdk8/bin/java && \
    ln -sf /opt/jdk8/bin/java /usr/local/bin/java8

# Rehearsal-proven extras on the shared venv: pyzbar+libzbar0 back the QR-code
# misc/rev path (QRCodeWorld solver); cysignals/fpylll back the lattice paths.
RUN --mount=type=cache,id=tsec-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=tsec-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=tsec-pip,target=/root/.cache/pip,sharing=locked \
    apt-get update -qq && \
    apt-get -y install --no-install-recommends libzbar0 && \
    rm -rf /var/lib/apt/lists/* && \
    /opt/venv/bin/pip install pyzbar cysignals fpylll

# 西湖论剑解题知识库：初赛 60 题 + 决赛测试新题的 runbook（题名/附件 sha256 定位）。
COPY containers/appliance/xihulunjian/kb /opt/solver/knowledges/xihulunjian
COPY containers/appliance/xihulunjian/preset.json /opt/aegisx-preset/preset.json
# Environment doc offline rewrite — finals sandbox flavour.
RUN --mount=type=bind,src=containers/solver/gen-environment.py,target=/tmp/gen-environment.py \
    python3 /tmp/gen-environment.py > /opt/solver/ENVIRONMENT.md && \
    python3 - <<'PY'
import re
p = "/opt/solver/ENVIRONMENT.md"
s = open(p).read()
offline = """## 离线环境（重要）

本镜像为断网决赛沙箱构建: 没有公网, 只有平台网关（LLM）与 DASCTF 平台可达。
**不要尝试 `pip install` / `apt-get install`** — 会直接失败。
预装工具见上文清单; 缺工具时换不需要该工具的技术路线, 不要在安装上耗时。
"""
s = re.sub(r"## 缺工具时的安装 SOP.*?(?=\n## |\Z)", offline, s, flags=re.S)
open(p, "w").write(s)
PY
RUN echo xihulunjian > /opt/solver/VARIANT && \
    test -s /opt/solver/knowledges/xihulunjian/INDEX.md
# Event name is explicit because bootstrap's platform-bound default is the
# tsecbench name.
ENV AEGISX_EVENT_NAME=xihulunjian-finals

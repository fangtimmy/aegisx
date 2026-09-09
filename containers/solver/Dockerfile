# build context = repo root. Three shippable tiers share the base stage; build
# with --target minimal | essential | full (see containers/solver/README.md):
#   docker buildx build -f containers/solver/Dockerfile --target full -t aegisx/solver:full .
# Each leaf ends with the same volatile tail (SDK + env doc + caps strip) so an
# SDK change never re-runs the heavy toolchain layers of the other tiers.

FROM --platform=linux/amd64 kalilinux/kali-rolling@sha256:3d3bc4c089371ea48d269893c3fa44421e47d3e4c974a1c93ea6c73879b8e8cf AS base

ARG KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
ARG PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/web/simple

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH="/opt/venv/bin:${PATH}" \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    KNOWLEDGES_DIR=/opt/solver/knowledges \
    TOOLS_DIR=/opt/solver/tools \
    VENV_BIN=/opt/venv/bin/python \
    PYTHONPATH=/opt/aegisx-sdk

# === Base toolchain (shared by all tiers) ===
# core/files · net/tunnel · binary/pwn triage · python venv core
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    echo 'path-exclude=/usr/share/doc/*' > /etc/dpkg/dpkg.cfg.d/excludes && \
    echo 'path-exclude=/usr/share/man/*' >> /etc/dpkg/dpkg.cfg.d/excludes && \
    echo 'path-exclude=/usr/share/locale/*' >> /etc/dpkg/dpkg.cfg.d/excludes && \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    sed -Ei "s@https?://http\.kali\.org/kali@${KALI_MIRROR}@g" /etc/apt/sources.list.d/kali.sources && \
    apt-get update && \
    apt-get -y install --no-install-recommends eatmydata && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends \
      ca-certificates git curl wget less \
      jq yq ripgrep fd-find rlwrap bsdextrautils bc file unzip 7zip-rar \
      binutils strace patchelf \
      iputils-ping netcat-openbsd ncat socat chisel sshpass openssh-client \
      procps psmisc \
      gdb checksec \
      python3.13-venv && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd

RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    python3.13 -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install \
      pwntools requests pycryptodome pycryptodomex gmpy2 sympy z3-solver \
      capstone ropper ropgadget pyelftools scapy && \
    ln -sfn /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sfn /opt/venv/bin/python /usr/local/bin/python && \
    mkdir -p /opt/solver/knowledges /opt/solver/tools

RUN printf 'set follow-fork-mode child\nset pagination off\n' >> /root/.gdbinit && \
    printf 'alias ll="ls -la"\nexport PWNLIB_NOTES=true\n' >> /root/.bashrc

# === minimal: a few hundred MB. Base toolchain + agent SDK, no CTF breadth.
# Anything missing goes through the in-image "缺工具 SOP" (pip / apt at solve time).
FROM base AS minimal
COPY apps/sdk/python /opt/aegisx-sdk
RUN --mount=type=bind,src=containers/solver/gen-environment.py,target=/tmp/gen-environment.py \
    python3 /tmp/gen-environment.py > /opt/solver/ENVIRONMENT.md
RUN echo minimal > /opt/solver/VARIANT && \
    getcap -r / 2>/dev/null | cut -d' ' -f1 | xargs -r -n1 setcap -r && \
    test -z "$(getcap -r / 2>/dev/null)"
WORKDIR /workspace
CMD ["sleep", "infinity"]

# === essential: full CTF-category coverage offline, minus the heavyweight
# long-tail (ghidra/wine/chromium/AD suite/memory forensics). Curated kali
# packages instead of the kali-linux-headless metapackage (the single biggest
# size item, ~10G layer).
FROM base AS essential
COPY containers/solver/solver-cache.py /usr/local/bin/solver-cache.py

# build/files · web · forensics/stego · bruteforce · binary/pwn · databases · OCR/docs · windows-lite · runtimes(ruby/php)
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends \
      build-essential pkg-config cmake fonts-noto-cjk \
      nmap masscan sqlmap wfuzz ffuf nikto \
      dirsearch feroxbuster httpx-toolkit nuclei seclists wordlists \
      binwalk foremost steghide pngcheck imagemagick libimage-exiftool-perl \
      sleuthkit testdisk \
      john fcrackzip rarcrack \
      rizin upx-ucl qemu-user-binfmt \
      smbclient enum4linux-ng tcpdump \
      redis-tools sqlite3 \
      poppler-utils tesseract-ocr zbar-tools libzbar0 \
      php8.4-cli php8.4-gd php8.4-mbstring php8.4-xml php8.4-zip php8.4-curl php8.4-sqlite3 php8.4-imagick \
      ruby && \
    (gzip -df /usr/share/wordlists/rockyou.txt.gz 2>/dev/null) && \
    test -s /usr/share/wordlists/rockyou.txt && \
    rm -rf /usr/share/seclists/Fuzzing && \
    rm -rf /usr/share/seclists/Passwords /usr/share/seclists/Miscellaneous /usr/share/seclists/Usernames

RUN gem sources --add https://mirrors.ustc.edu.cn/rubygems/ --remove https://rubygems.org/ && \
    gem install --no-document one_gadget zsteg

# wsrx · katana · naabu · dalfox · cloudfox · kerbrute · bkcrack · dddd · fscan · pwninit
RUN --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-downloads core && \
    D=/var/cache/solver/downloads && \
    tar -xzf "$D/wsrx.tar.gz" -C /usr/local/bin && \
    unzip -q "$D/katana.zip" katana -d /usr/local/bin && \
    unzip -q "$D/naabu.zip" naabu -d /usr/local/bin && \
    tar -xzf "$D/dalfox.tar.gz" -C /tmp && mv /tmp/dalfox-linux-amd64 /usr/local/bin/dalfox && \
    unzip -q "$D/cloudfox.zip" cloudfox/cloudfox -d /tmp && mv /tmp/cloudfox/cloudfox /usr/local/bin/cloudfox && \
    install -m755 "$D/kerbrute" /usr/local/bin/kerbrute && \
    tar -xzf "$D/bkcrack.tar.gz" -C /tmp && install -m755 /tmp/bkcrack-*/bkcrack /usr/local/bin/bkcrack && \
    install -m755 "$D/dddd" /usr/local/bin/dddd && \
    install -m755 "$D/fscan" /usr/local/bin/fscan && \
    install -m755 "$D/pwninit" /usr/local/bin/pwninit && \
    rm -rf /tmp/cloudfox /tmp/bkcrack-*

# === Knowledges ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-knowledges core && \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +

RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-tools && \
    /opt/venv/bin/pip install -r /opt/solver/tools/jwt_tool/requirements.txt

# === Python venv additions ===
RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    /opt/venv/bin/pip install \
      pillow pefile lief fpylll uncompyle6 pyzbar pypdf pdfminer.six \
      mnemonic base58 eth-account pysmx gmssl mido \
      impacket ldap3 git-dumper mitmproxy \
      cryptography pyOpenSSL pyjwt flask-unsign cysignals setuptools yara-x

# === pycdc (py3.9+ bytecode decompiler; uncompyle6 tops out at 3.8) ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py clone https://github.com/zrax/pycdc.git /tmp/pycdc-src /var/cache/solver/git && \
    cmake -S /tmp/pycdc-src -B /tmp/pycdc-build && \
    cmake --build /tmp/pycdc-build -j"$(nproc)" && \
    install -m755 /tmp/pycdc-build/pycdc /tmp/pycdc-build/pycdas /usr/local/bin && \
    rm -rf /tmp/pycdc-src /tmp/pycdc-build

COPY apps/sdk/python /opt/aegisx-sdk
RUN --mount=type=bind,src=containers/solver/gen-environment.py,target=/tmp/gen-environment.py \
    python3 /tmp/gen-environment.py > /opt/solver/ENVIRONMENT.md
RUN echo essential > /opt/solver/VARIANT && \
    getcap -r / 2>/dev/null | cut -d' ' -f1 | xargs -r -n1 setcap -r && \
    test -z "$(getcap -r / 2>/dev/null)"
WORKDIR /workspace
CMD ["sleep", "infinity"]

# === full: everything. = essential + kali headless suite + heavy long-tail
# (ghidra/wine/chromium/AD suite/memory forensics/java-golang runtimes).
FROM essential AS full

ENV PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright

# kali-linux-headless suite · rev/forensics heavy · java/golang runtimes
# seclists --reinstall restores the Passwords/Miscellaneous/Usernames dirs
# pruned in essential; pwndbg lives here (its bundled python env is ~1.1G).
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends \
      kali-linux-headless \
      default-jdk-headless golang-go llvm-21 jadx apktool \
      ffmpeg tshark hashcat krb5-user && \
    apt-get -y install --reinstall --no-install-recommends seclists && \
    rm -rf /usr/share/seclists/Fuzzing && \
    ln -sf /usr/bin/llvm-pdbutil-21 /usr/local/bin/llvm-pdbutil

# === Knowledges (full-only additions) ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-knowledges full && \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +

# ghidra · ysoserial · dwarf2json · pwndbg (deb ships its own gdb+python env)
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    apt-get update -qq && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    python3 /usr/local/bin/solver-cache.py sync-downloads full && \
    D=/var/cache/solver/downloads && \
    unzip -q "$D/ghidra.zip" -d /opt && \
    ln -sfn /opt/ghidra_*/support/analyzeHeadless /usr/local/bin/ghidra-analyze && \
    install -m755 "$D/dwarf2json" /usr/local/bin/dwarf2json && \
    cp "$D/ysoserial.jar" /opt/solver/tools/ysoserial.jar && \
    apt-get -y install --no-install-recommends "$D/pwndbg.deb"

RUN PWNDBG_GDBINIT=$(find / -name "gdbinit.py" -path "*pwndbg*" 2>/dev/null | head -1) && \
    if [ -n "$PWNDBG_GDBINIT" ]; then PWNDBG_SITE=$(dirname "$(dirname "$PWNDBG_GDBINIT")") && \
    printf 'python import sys; sys.path.insert(0, "%s")\nsource %s\n' "$PWNDBG_SITE" "$PWNDBG_GDBINIT" >> /root/.gdbinit; fi

# === Python venv additions (heavy) ===
RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    /opt/venv/bin/pip install \
      numpy scipy opencv-python-headless \
      angr playwright volatility3 pyshark \
      bloodyAD certipy-ad coercer pypykatz

# === Playwright Chromium ===
# Browsers download into the cache mount (network skip on rebuilds) and are
# copied into the layer — cache-mount contents do not ship in the image.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=solver-playwright,target=/root/.cache/ms-playwright,sharing=locked \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright playwright install --with-deps chromium && \
    mkdir -p /opt/ms-playwright && \
    cp -a /root/.cache/ms-playwright/. /opt/ms-playwright/

# === Volatile package additions ===
# Kept out of the bulk layer so adding tools later does not re-trigger the
# ~15-min bulk unpack; dpkg state carries over from the parent layer.
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends wine64

# wine: the Debian wine64 trampoline locates the real loader relative to its
# own path, so PATH symlinks fail with "could not exec the wine loader" —
# wrap with an absolute-path exec instead.
RUN printf '#!/bin/sh\nexec /usr/lib/wine/wine64 "$@"\n' > /usr/local/bin/wine64 && \
    chmod 755 /usr/local/bin/wine64 && \
    ln -sf wine64 /usr/local/bin/wine && \
    ln -sf /usr/lib/wine/wineserver /usr/local/bin/wineserver && \
    test -x /usr/lib/wine/wine64 && test -x /usr/lib/wine/wineserver

# === Field-report additions ===
# Gaps observed in the 2026-09-08 TSecBench run (agent invocations, not guesses):
#  - telnetlib was removed from the stdlib in Python 3.13; telnet targets need
#    telnetlib3 as the replacement.
#  - AI-service targets (Gradio/ComfyUI) and YAML/JSON-heavy web apps went
#    without their client libraries — agents fell back to hand-rolled protocol
#    code over requests.
#  - /usr/bin/time (the `time` package) was reached for and missing.
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update -qq && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends time

RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    /opt/venv/bin/pip install \
      telnetlib3 gradio_client websockets pyyaml aiohttp pymysql

# Wordlist name aliases: agents consistently ask for the seclists canonical
# names, while the image ships the DirBuster-2007_* / xato-net-* variants.
# Symlinks (no copies) so both spellings resolve.
RUN W=/usr/share/seclists/Discovery/Web-Content && \
    P=/usr/share/seclists/Passwords/Common-Credentials && \
    ln -sf "$W/DirBuster-2007_directory-list-2.3-small.txt"  "$W/directory-list-2.3-small.txt" && \
    ln -sf "$W/DirBuster-2007_directory-list-2.3-medium.txt" "$W/directory-list-2.3-medium.txt" && \
    ln -sf "$P/xato-net-10-million-passwords-1000.txt"  "$P/10-million-password-list-top-1000.txt" && \
    ln -sf "$P/xato-net-10-million-passwords-10000.txt" "$P/10-million-password-list-top-10000.txt" && \
    test -s "$W/directory-list-2.3-medium.txt" && \
    test -s "$P/10-million-password-list-top-10000.txt"

# The image COPYs apps/sdk/python — run `bun run test:sdk` before rebuilding so
# a stale in-image SDK never drifts against the server it talks to.
COPY apps/sdk/python /opt/aegisx-sdk
RUN --mount=type=bind,src=containers/solver/gen-environment.py,target=/tmp/gen-environment.py \
    python3 /tmp/gen-environment.py > /opt/solver/ENVIRONMENT.md
RUN echo full > /opt/solver/VARIANT && \
    getcap -r / 2>/dev/null | cut -d' ' -f1 | xargs -r -n1 setcap -r && \
    test -z "$(getcap -r / 2>/dev/null)"
WORKDIR /workspace
CMD ["sleep", "infinity"]

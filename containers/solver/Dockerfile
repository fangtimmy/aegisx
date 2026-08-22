FROM --platform=linux/amd64 kalilinux/kali-rolling@sha256:3d3bc4c089371ea48d269893c3fa44421e47d3e4c974a1c93ea6c73879b8e8cf

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
    PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright

# === Packages ===
# meta · base/files · net/tunnel · web · binary/pwn · forensics/stego · net-analysis · windows/ad · databases · bruteforce · crypto/math · docs/ocr · runtimes
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
      kali-linux-headless \
      python3.13-venv build-essential pkg-config cmake fonts-noto-cjk \
      bsdextrautils bc file unzip 7zip-rar jq yq ripgrep fd-find rlwrap \
      iputils-ping sshpass ncat netcat-openbsd chisel \
      dirsearch feroxbuster httpx-toolkit nuclei seclists \
      gdb checksec rizin qemu-user-binfmt jadx apktool llvm-21 \
      patchelf strace upx-ucl \
      foremost steghide pngcheck ffmpeg imagemagick \
      libimage-exiftool-perl \
      tshark \
      smbclient krb5-user enum4linux-ng \
      redis-tools sqlite3 \
      fcrackzip rarcrack \
      poppler-utils tesseract-ocr zbar-tools libzbar0 \
      php8.4-gd php8.4-mbstring php8.4-xml php8.4-zip php8.4-curl php8.4-sqlite3 php8.4-imagick \
      default-jdk-headless nodejs npm golang-go ruby && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
    ln -sf /usr/bin/llvm-pdbutil-21 /usr/local/bin/llvm-pdbutil && \
    (gzip -df /usr/share/wordlists/rockyou.txt.gz 2>/dev/null || true) && \
    rm -rf /usr/share/seclists/Fuzzing

# Build context = repo root: docker buildx build -f containers/solver/Dockerfile -t aegisx/solver:kali .
COPY containers/solver/solver-cache.py /usr/local/bin/solver-cache.py

# === Knowledge Base ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-knowledges && \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +

# === GitHub Release Binary ===
# ghidra · wsrx · katana · naabu · dalfox · cloudfox · kerbrute · bkcrack · dddd · fscan · pwninit · dwarf2json
RUN --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    D=/var/cache/solver/downloads && \
    python3 /usr/local/bin/solver-cache.py sync-downloads && \
    unzip -q "$D/ghidra.zip" -d /opt && \
    ln -sfn /opt/ghidra_*/support/analyzeHeadless /usr/local/bin/ghidra-analyze && \
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
    install -m755 "$D/dwarf2json" /usr/local/bin/dwarf2json && \
    rm -rf /tmp/cloudfox /tmp/bkcrack-*

# === pwndbg ===
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends /var/cache/solver/downloads/pwndbg.deb

# === Python venv ===
RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    python3.13 -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install \
      pwntools ropper ropgadget capstone requests \
      pycryptodome pycryptodomex gmpy2 sympy z3-solver numpy scipy \
      pillow pefile fpylll uncompyle6 pyelftools lief \
      pyzbar pypdf pdfminer.six pyshark \
      mnemonic base58 eth-account pysmx gmssl mido \
      opencv-python-headless \
      angr impacket ldap3 git-dumper playwright volatility3 \
      cryptography pyOpenSSL pyjwt flask-unsign scapy \
      bloodyAD certipy-ad coercer pypykatz cysignals setuptools yara-x && \
    ln -sfn /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sfn /opt/venv/bin/python /usr/local/bin/python

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

# === Java/Web Tools ===
RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-tools && \
    cp /var/cache/solver/downloads/ysoserial.jar /opt/solver/tools/ysoserial.jar && \
    /opt/venv/bin/pip install -r /opt/solver/tools/jwt_tool/requirements.txt

# === Ruby Tools ===
RUN gem sources --add https://mirrors.ustc.edu.cn/rubygems/ --remove https://rubygems.org/ && \
    gem install --no-document one_gadget zsteg

# === pycdc (py3.9+ bytecode decompiler; uncompyle6 tops out at 3.8) ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py clone https://github.com/zrax/pycdc.git /tmp/pycdc-src /var/cache/solver/git && \
    cmake -S /tmp/pycdc-src -B /tmp/pycdc-build && \
    cmake --build /tmp/pycdc-build -j"$(nproc)" && \
    install -m755 /tmp/pycdc-build/pycdc /tmp/pycdc-build/pycdas /usr/local/bin && \
    rm -rf /tmp/pycdc-src /tmp/pycdc-build

RUN PWNDBG_GDBINIT=$(find / -name "gdbinit.py" -path "*pwndbg*" 2>/dev/null | head -1) && \
    if [ -n "$PWNDBG_GDBINIT" ]; then PWNDBG_SITE=$(dirname "$(dirname "$PWNDBG_GDBINIT")") && \
    printf 'python import sys; sys.path.insert(0, "%s")\nsource %s\n' "$PWNDBG_SITE" "$PWNDBG_GDBINIT" >> /root/.gdbinit; fi && \
    printf 'set follow-fork-mode child\nset pagination off\n' >> /root/.gdbinit && \
    printf 'alias ll="ls -la"\nexport PWNLIB_NOTES=true\n' >> /root/.bashrc

# === Pi Coding Agent ===
RUN --mount=type=cache,id=solver-npm,target=/root/.npm,sharing=locked \
    npm config set registry https://registry.npmmirror.com && \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.7 && \
    mkdir -p /root/.pi/agent/skills

# Cache politics: everything below changes often (SDK, docs, package tweaks)
# and is kept last so the heavy toolchain above stays layer-cached.
# === AegisX Agent SDK ===
# The in-image SDK is the production path (PYTHONPATH preset; the agent
# runtime injects AEGISX_EVENT_ID / AEGISX_API_URL / per-exec identity).
# Host-side dev override: set AEGISX_SDK_PATH on the server to bind-mount a
# live source tree over /opt/aegisx-sdk.
COPY apps/sdk/python /opt/aegisx-sdk
ENV KNOWLEDGES_DIR=/opt/solver/knowledges \
    TOOLS_DIR=/opt/solver/tools \
    VENV_BIN=/opt/venv/bin/python \
    PYTHONPATH=/opt/aegisx-sdk
COPY containers/solver/ENVIRONMENT.md /opt/solver/ENVIRONMENT.md

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
    ln -sf /usr/lib/wine/wineserver /usr/local/bin/wineserver

# Under no-new-privileges, exec of a file-capability binary dies with EPERM at
# exec time whenever its caps exceed the container bounding set (NET_RAW only)
# — nmap ships net_bind_service+net_admin+net_raw. NET_RAW is granted at the
# container level, so no packaged binary needs file caps: strip them all after
# the last apt layer and assert none remain.
RUN getcap -r / 2>/dev/null | cut -d' ' -f1 | xargs -r -n1 setcap -r && \
    test -z "$(getcap -r / 2>/dev/null)"

WORKDIR /workspace

CMD ["sleep", "infinity"]

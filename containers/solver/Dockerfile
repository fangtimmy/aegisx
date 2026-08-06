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
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    sed -i "s@http://http.kali.org/kali@${KALI_MIRROR}@g" /etc/apt/sources.list.d/kali.sources && \
    apt-get update && \
    apt-get -y install --no-install-recommends eatmydata && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends \
      kali-linux-headless \
      python3-venv build-essential pkg-config cmake fonts-noto-cjk \
      bsdextrautils file unzip 7zip-rar jq yq ripgrep fd-find rlwrap \
      iputils-ping sshpass ncat netcat-openbsd chisel \
      dirsearch feroxbuster httpx-toolkit nuclei seclists \
      gdb checksec rizin qemu-user-binfmt jadx apktool \
      patchelf strace upx-ucl \
      foremost steghide pngcheck ffmpeg imagemagick \
      libimage-exiftool-perl \
      tshark \
      smbclient krb5-user enum4linux-ng \
      redis-tools sqlite3 \
      fcrackzip rarcrack \
      poppler-utils tesseract-ocr zbar-tools libzbar0 \
      default-jdk-headless nodejs npm golang-go ruby && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
    (gzip -dk /usr/share/wordlists/rockyou.txt.gz 2>/dev/null || true)

ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so

# Strip package-provided file capabilities from network binaries. The solver
# container runs with --cap-drop ALL + no-new-privileges, under which exec of a
# file-capability binary (e.g. nmap's cap_net_raw=eip) is refused with EPERM at
# exec time — before any privileged op. NET_RAW is granted to the *container*
# instead (see container-manager.ts), so these binaries work via inherited caps
# once their own file caps are gone. Runtime setcap is impossible (no CAP_SETFCP
# in the container), so this must happen at build time.
RUN setcap -r /usr/lib/nmap/nmap /usr/bin/fping 2>/dev/null || true

COPY solver-cache.py /usr/local/bin/solver-cache.py
COPY ENVIRONMENT.md /opt/solver/ENVIRONMENT.md

ENV KNOWLEDGES_DIR=/opt/solver/knowledges \
    TOOLS_DIR=/opt/solver/tools \
    VENV_BIN=/opt/venv/bin/python

# === Knowledge Base ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-knowledges && \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +

# === GitHub Release Binary + outguess ===
# ghidra · wsrx · katana · naabu · dalfox · cloudfox · kerbrute · bkcrack · dddd · fscan
RUN --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    D=/var/cache/solver/downloads && \
    python3 /usr/local/bin/solver-cache.py sync-downloads && \
    unzip -q "$D/ghidra.zip" -d /opt && \
    ln -sf /opt/ghidra_12.1.2_PUBLIC/support/analyzeHeadless /usr/local/bin/ghidra-analyze && \
    tar -xzf "$D/wsrx.tar.gz" -C /usr/local/bin && \
    unzip -q "$D/katana.zip" katana -d /usr/local/bin && \
    unzip -q "$D/naabu.zip" naabu -d /usr/local/bin && \
    tar -xzf "$D/dalfox.tar.gz" -C /tmp && mv /tmp/dalfox-linux-amd64 /usr/local/bin/dalfox && \
    unzip -q "$D/cloudfox.zip" cloudfox/cloudfox -d /tmp && mv /tmp/cloudfox/cloudfox /usr/local/bin/cloudfox && \
    install -m755 "$D/kerbrute" /usr/local/bin/kerbrute && \
    tar -xzf "$D/bkcrack.tar.gz" -C /tmp && install -m755 /tmp/bkcrack-*/bkcrack /usr/local/bin/bkcrack && \
    install -m755 "$D/dddd" /usr/local/bin/dddd && \
    install -m755 "$D/fscan" /usr/local/bin/fscan && \
    rm -rf /tmp/cloudfox /tmp/bkcrack-*

# === pwndbg ===
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends /var/cache/solver/downloads/pwndbg.deb

# === Python venv ===
RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    python3 -m venv /opt/venv && \
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
      bloodyAD certipy-ad coercer pypykatz && \
    ln -sfn /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sfn /opt/venv/bin/python /usr/local/bin/python

# === Playwright Chromium ===
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    playwright install --with-deps chromium

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

RUN PWNDBG_GDBINIT=$(find / -name "gdbinit.py" -path "*pwndbg*" 2>/dev/null | head -1) && \
    if [ -n "$PWNDBG_GDBINIT" ]; then printf 'source %s\n' "$PWNDBG_GDBINIT" >> /root/.gdbinit; fi && \
    printf 'set follow-fork-mode child\nset pagination off\n' >> /root/.gdbinit && \
    printf 'alias ll="ls -la"\nexport PWNLIB_NOTES=true\n' >> /root/.bashrc

# === Pi Coding Agent ===
RUN --mount=type=cache,id=solver-npm,target=/root/.npm,sharing=locked \
    npm config set registry https://registry.npmmirror.com && \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.7 && \
    mkdir -p /root/.pi/agent/skills

WORKDIR /workspace

CMD ["sleep", "infinity"]

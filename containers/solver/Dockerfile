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
# meta · base/files · net/tunnel · web · binary/pwn · forensics · net-analysis · windows/ad · databases · bruteforce · runtimes
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    sed -i "s@http://http.kali.org/kali@${KALI_MIRROR}@g" /etc/apt/sources.list.d/kali.sources && \
    apt-get update && \
    apt-get -y install --no-install-recommends eatmydata && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends \
      kali-linux-headless \
      python3-venv build-essential pkg-config fonts-noto-cjk \
      bsdextrautils file unzip 7zip-rar jq yq ripgrep fd-find rlwrap \
      iputils-ping sshpass ncat netcat-openbsd chisel \
      dirsearch feroxbuster httpx-toolkit nuclei seclists \
      gdb checksec rizin qemu-user-binfmt jadx apktool \
      foremost steghide pngcheck ffmpeg \
      tshark \
      smbclient krb5-user enum4linux-ng \
      redis-tools sqlite3 \
      fcrackzip rarcrack \
      default-jdk-headless nodejs npm golang-go ruby && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
    (gzip -dk /usr/share/wordlists/rockyou.txt.gz 2>/dev/null || true)

ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so

COPY solver-cache.py /usr/local/bin/solver-cache.py
COPY ENVIRONMENT.md /opt/solver/ENVIRONMENT.md

ENV KNOWLEDGES_DIR=/opt/solver/knowledges \
    TOOLS_DIR=/opt/solver/tools \
    VENV_BIN=/opt/venv/bin/python

# === Knowledge Base ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-knowledges && \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +

# === GitHub Release Binary ===
RUN --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    python3 /usr/local/bin/solver-cache.py sync-downloads && \
    unzip -q /var/cache/solver/downloads/ghidra.zip -d /opt && \
    ln -sf /opt/ghidra_12.1.2_PUBLIC/support/analyzeHeadless /usr/local/bin/ghidra-analyze && \
    tar -xzf /var/cache/solver/downloads/wsrx.tar.gz -C /usr/local/bin && \
    unzip -q /var/cache/solver/downloads/katana.zip katana -d /tmp && mv /tmp/katana /usr/local/bin/ && \
    unzip -q /var/cache/solver/downloads/naabu.zip naabu -d /tmp && mv /tmp/naabu /usr/local/bin/ && \
    tar -xzf /var/cache/solver/downloads/dalfox.tar.gz -C /tmp && mv /tmp/dalfox-linux-amd64 /usr/local/bin/dalfox && \
    unzip -q /var/cache/solver/downloads/cloudfox.zip cloudfox/cloudfox -d /tmp && mv /tmp/cloudfox/cloudfox /usr/local/bin/cloudfox && \
    cp /var/cache/solver/downloads/kerbrute /usr/local/bin/kerbrute && chmod +x /usr/local/bin/kerbrute && \
    rm -rf /tmp/cloudfox

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
      pycryptodome pycryptodomex gmpy2 sympy z3-solver \
      angr impacket ldap3 git-dumper playwright volatility3 \
      cryptography pyOpenSSL pyjwt flask-unsign scapy \
      bloodyAD certipy-ad coercer pypykatz

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

WORKDIR /workspace

CMD ["sleep", "infinity"]

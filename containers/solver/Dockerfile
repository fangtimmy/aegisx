FROM --platform=linux/amd64 kalilinux/kali-rolling@sha256:3d3bc4c089371ea48d269893c3fa44421e47d3e4c974a1c93ea6c73879b8e8cf

# === 构建参数 ===
ARG KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
ARG PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/web/simple

# === 运行时环境 ===
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH="/opt/venv/bin:${PATH}" \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright

# === 1. 基础层: apt 镜像源 + eatmydata + kali-linux-headless + 显式补充 + rockyou ===
# 已剔除 headless 提供的重叠包: 7zip · wpscan · libimage-exiftool-perl · python3-scapy
# 包分组(序): meta · base/files · net/tunnel · web · binary/pwn · forensics · net-analysis · windows/ad · databases · bruteforce · runtimes
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
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

# === 2. 知识库(大体积 ~2GB, 稳定, 尽早层以便后续改动不触发重新克隆) ===
# agent grep 参考源: payload/技战术/libc 偏移/vulhub 漏洞环境
# libc-database 仅克隆脚本, 需要时手动 ./download; pwntools 内置 libcdb 可在线查 libc.rip
RUN mkdir -p /workspace/knowledges && cd /workspace/knowledges && \
    git clone --depth=1 --single-branch https://github.com/swisskyrepo/PayloadsAllTheThings.git && \
    git clone --depth=1 --single-branch https://github.com/swisskyrepo/InternalAllTheThings.git && \
    git clone --depth=1 --single-branch https://github.com/HackTricks-wiki/hacktricks.git && \
    git clone --depth=1 --single-branch https://github.com/HackTricks-wiki/hacktricks-cloud.git && \
    git clone --depth=1 --single-branch https://github.com/niklasb/libc-database.git && \
    git clone --depth=1 --single-branch https://github.com/vulhub/vulhub.git && \
    find /workspace/knowledges -name .git -type d -prune -exec rm -rf {} +

# === 3. ghidra: headless 反编译(JDK 已装); analyzeHeadless 软链到 PATH ===
RUN curl -fsSL "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.2_build/ghidra_12.1.2_PUBLIC_20260605.zip" -o /tmp/ghidra.zip && \
    unzip -q /tmp/ghidra.zip -d /opt && \
    rm /tmp/ghidra.zip && \
    ln -sf /opt/ghidra_12.1.2_PUBLIC/support/analyzeHeadless /usr/local/bin/ghidra-analyze

# === 4. pwndbg: 官方 .deb(Kali 兼容), 提供 pwndbg 命令; gdb 集成放第 10 层统一处理 ===
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    curl -fsSL "https://github.com/pwndbg/pwndbg/releases/download/2026.02.18/pwndbg_2026.02.18_amd64.deb" -o /tmp/pwndbg.deb && \
    apt-get update && \
    apt-get install -y --no-install-recommends /tmp/pwndbg.deb && \
    rm /tmp/pwndbg.deb

# === 5. GitHub 二进制: tunnel · web recon · AD · cloud ===
RUN cd /tmp && \
    curl -fsSLO https://github.com/XDSEC/WebSocketReflectorX/releases/download/0.5.17/wsrx-cli-0.5.17-linux-gnu-x86_64.tar.gz && \
    tar -xzf wsrx-cli-0.5.17-linux-gnu-x86_64.tar.gz -C /usr/local/bin && \
    curl -fsSLO https://github.com/projectdiscovery/katana/releases/download/v1.5.0/katana_1.5.0_linux_amd64.zip && \
    unzip -q katana_1.5.0_linux_amd64.zip katana && mv katana /usr/local/bin/ && \
    curl -fsSLO https://github.com/projectdiscovery/naabu/releases/download/v2.3.4/naabu_2.3.4_linux_amd64.zip && \
    unzip -q naabu_2.3.4_linux_amd64.zip naabu && mv naabu /usr/local/bin/ && \
    curl -fsSLO https://github.com/hahwul/dalfox/releases/download/v2.12.0/dalfox-linux-amd64.tar.gz && \
    tar -xzf dalfox-linux-amd64.tar.gz && mv dalfox-linux-amd64 /usr/local/bin/dalfox && \
    curl -fsSLO https://github.com/BishopFox/cloudfox/releases/download/v2.0.1/cloudfox-linux-amd64.zip && \
    unzip -q cloudfox-linux-amd64.zip cloudfox/cloudfox && mv cloudfox/cloudfox /usr/local/bin/cloudfox && \
    curl -fsSLO https://github.com/ropnop/kerbrute/releases/download/v1.0.3/kerbrute_linux_amd64 && \
    chmod +x kerbrute_linux_amd64 && mv kerbrute_linux_amd64 /usr/local/bin/kerbrute && \
    rm -rf /tmp/*.zip /tmp/*.tar.gz /tmp/cloudfox

# === 6. Python venv: 共享隔离环境(等价 pipx, 但保留多库可相互 import, 适配 CTF 脚本场景) ===
# 不再使用 --break-system-packages/--ignore-installed, 系统 Python 保持干净
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir \
      pwntools ropper ropgadget capstone requests \
      pycryptodome pycryptodomex gmpy2 sympy z3-solver \
      angr impacket ldap3 git-dumper playwright volatility3 \
      cryptography pyOpenSSL pyjwt flask-unsign scapy \
      bloodyAD certipy-ad coercer pypykatz

# === 7. Playwright 浏览器(独立层, 失效缓存友好) ===
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    playwright install --with-deps chromium

# === 8. Java/Web 工具: ysoserial(反序列化) · jwt_tool(JWT 攻击) · jdwp-shellifier(JDWP RCE) ===
# jwt_tool 依赖装入共享 venv, jwt_tool.py 直接可用 /opt/venv/bin/python 运行
RUN mkdir -p /workspace/tools && cd /workspace/tools && \
    curl -fsSL "https://github.com/frohoff/ysoserial/releases/download/v0.0.6/ysoserial-all.jar" -o ysoserial.jar && \
    git clone --depth=1 https://github.com/ticarpi/jwt_tool.git && \
    /opt/venv/bin/pip install --no-cache-dir -r jwt_tool/requirements.txt && \
    git clone --depth=1 https://github.com/IOActive/jdwp-shellifier.git

# === 9. Ruby 工具(--no-document: 跳过 ri/rdoc 编译) ===
RUN gem sources --add https://gems.ruby-china.com --remove https://rubygems.org/ && \
    gem install --no-document one_gadget zsteg

# === 10. 配置: pwndbg gdb 集成 + QoL ===
# 动态查找 pwndbg gdbinit.py 路径(.deb 实际安装位置), 不依赖固定路径
RUN PWNDBG_GDBINIT=$(find / -name "gdbinit.py" -path "*pwndbg*" 2>/dev/null | head -1) && \
    if [ -n "$PWNDBG_GDBINIT" ]; then printf 'source %s\n' "$PWNDBG_GDBINIT" >> /root/.gdbinit; fi && \
    printf 'set follow-fork-mode child\nset pagination off\n' >> /root/.gdbinit && \
    printf 'alias ll="ls -la"\nexport PWNLIB_NOTES=true\n' >> /root/.bashrc

WORKDIR /workspace

CMD ["sleep", "infinity"]

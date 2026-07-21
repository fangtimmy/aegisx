FROM --platform=linux/amd64 kalilinux/kali-rolling:latest

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    sed -i "s@http://http.kali.org/kali@http://mirrors.ustc.edu.cn/kali@g" /etc/apt/sources.list.d/kali.sources && \
    apt-get update && \
    apt-get -y install --no-install-recommends eatmydata nala && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    nala install -y --no-install-recommends kali-linux-headless && \
    gzip -dk /usr/share/wordlists/rockyou.txt.gz

ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so

# 包按领域分组(顺序): base/files · net/tunnel · web · binary/pwn · forensics · net-analysis · windows/ad · databases · bruteforce · runtimes
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && \
    nala install -y --no-install-recommends \
      python3-venv build-essential pkg-config fonts-noto-cjk \
      bsdextrautils file unzip 7zip 7zip-rar jq yq ripgrep fd-find rlwrap \
      iputils-ping sshpass ncat netcat-openbsd chisel \
      dirsearch feroxbuster httpx-toolkit nuclei wpscan seclists \
      gdb checksec rizin qemu-user-binfmt jadx apktool \
      foremost steghide libimage-exiftool-perl pngcheck ffmpeg \
      python3-scapy tshark \
      smbclient krb5-user enum4linux-ng \
      default-mysql-client redis-tools sqlite3 \
      fcrackzip rarcrack \
      default-jdk-headless nodejs npm golang-go ruby && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd

# GitHub 二进制: tunnel · web recon · AD · cloud
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

RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    pip3 config set global.index-url https://mirrors.ustc.edu.cn/pypi/web/simple && \
    pip3 install --break-system-packages --ignore-installed \
      pwntools ropper ropgadget capstone requests \
      pycryptodome pycryptodomex gmpy2 sympy z3-solver \
      angr impacket ldap3 git-dumper playwright volatility3 \
      cryptography pyOpenSSL pyjwt flask-unsign \
      bloodyAD certipy-ad coercer pypykatz && \
    apt-get update && playwright install --with-deps chromium

RUN gem install one_gadget zsteg

# RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
#     --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
#     git clone --depth=1 https://github.com/pwndbg/pwndbg /opt/pwndbg && \
#     cd /opt/pwndbg && DEBIAN_FRONTEND=noninteractive ./setup.sh

# RUN GHIDRA_URL=$(curl -fsSL https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/tags/Ghidra_12.1.2_build \
#       | jq -r '.assets[].browser_download_url' | grep '\.zip$' | head -n1) && \
#     curl -fsSL "$GHIDRA_URL" -o /tmp/ghidra.zip && \
#     unzip -q /tmp/ghidra.zip -d /opt && \
#     rm /tmp/ghidra.zip && \
#     ln -sf /opt/ghidra_*/support/analyzeHeadless /usr/local/bin/ghidra-analyze

# RUN mkdir -p /workspace/tools && cd /workspace/tools && \
#     curl -fsSL "https://github.com/frohoff/ysoserial/releases/download/v0.0.6/ysoserial-all.jar" -o ysoserial.jar && \
#     git clone --depth=1 https://github.com/ticarpi/jwt_tool.git && \
#     cd jwt_tool && pip3 install --break-system-packages -r requirements.txt && \
#     cd /workspace/tools && git clone --depth=1 https://github.com/IOActive/jdwp-shellifier.git

# RUN mkdir -p /workspace/knowledges && cd /workspace/knowledges && \
#     git clone --depth=1 --single-branch https://github.com/swisskyrepo/PayloadsAllTheThings.git && \
#     git clone --depth=1 --single-branch https://github.com/swisskyrepo/InternalAllTheThings.git && \
#     git clone --depth=1 --single-branch https://github.com/HackTricks-wiki/hacktricks.git && \
#     git clone --depth=1 --single-branch https://github.com/HackTricks-wiki/hacktricks-cloud.git && \
#     git clone --depth=1 --single-branch https://github.com/niklasb/libc-database.git && \
#     git clone --depth=1 --single-branch https://github.com/vulhub/vulhub.git && \
#     find /workspace/knowledges -name .git -type d -prune -exec rm -rf {} +

# RUN printf 'set follow-fork-mode child\nset pagination off\n' >> /root/.gdbinit && \
#     printf 'alias ll="ls -la"\nexport PWNLIB_NOTES=true\n' >> /root/.bashrc

WORKDIR /workspace

CMD ["sleep", "infinity"]

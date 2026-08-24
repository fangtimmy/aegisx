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
    PIP_NO_INPUT=1

# === Packages ===
# Curated core (no kali meta package): essentials · build · web-lite ·
# pwn · forensics/stego-lite. See README.md for the full/minimal tradeoff.
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    sed -Ei "s@https?://http\.kali\.org/kali@${KALI_MIRROR}@g" /etc/apt/sources.list.d/kali.sources && \
    apt-get update && \
    apt-get -y install --no-install-recommends eatmydata && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends \
      ca-certificates curl wget git unzip zip 7zip bzip2 xz-utils \
      file jq ripgrep fd-find procps bsdextrautils less rlwrap \
      build-essential cmake pkg-config python3.13-venv ruby \
      iputils-ping netcat-openbsd nmap \
      sqlmap ffuf gdb checksec patchelf strace \
      binwalk foremost libimage-exiftool-perl pngcheck fcrackzip && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd

ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so

COPY containers/solver/solver-cache.py /usr/local/bin/solver-cache.py
RUN mkdir -p /opt/solver/tools /opt/solver/knowledges

ENV KNOWLEDGES_DIR=/opt/solver/knowledges \
    TOOLS_DIR=/opt/solver/tools \
    VENV_BIN=/opt/venv/bin/python

# === GitHub Release binaries (subset: pwndbg · pwninit) ===
RUN --mount=type=cache,id=solver-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=solver-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=solver-downloads,target=/var/cache/solver/downloads,sharing=locked \
    D=/var/cache/solver/downloads && \
    python3 /usr/local/bin/solver-cache.py download https://github.com/pwndbg/pwndbg/releases/download/2026.02.18/pwndbg_2026.02.18_amd64.deb "$D/pwndbg.deb" && \
    python3 /usr/local/bin/solver-cache.py download https://github.com/io12/pwninit/releases/download/3.3.3/pwninit "$D/pwninit" && \
    apt-get update -qq && \
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libeatmydata.so && \
    apt-get -y install --no-install-recommends "$D/pwndbg.deb" && \
    install -m755 "$D/pwninit" /usr/local/bin/pwninit

# === Knowledge Base (subset) ===
RUN --mount=type=cache,id=solver-git,target=/var/cache/solver/git,sharing=locked \
    python3 /usr/local/bin/solver-cache.py clone https://github.com/swisskyrepo/PayloadsAllTheThings.git /opt/solver/knowledges/PayloadsAllTheThings /var/cache/solver/git && \
    python3 /usr/local/bin/solver-cache.py clone https://github.com/swisskyrepo/InternalAllTheThings.git /opt/solver/knowledges/InternalAllTheThings /var/cache/solver/git && \
    find /opt/solver/knowledges -name .git -type d -prune -exec rm -rf {} +

# === Python venv ===
RUN --mount=type=cache,id=solver-pip,target=/root/.cache/pip,sharing=locked \
    python3.13 -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install \
      pwntools ropper ropgadget capstone requests scapy \
      pycryptodome pycryptodomex gmpy2 sympy z3-solver numpy pillow \
      pyelftools lief pyjwt cryptography flask-unsign setuptools && \
    ln -sfn /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sfn /opt/venv/bin/python /usr/local/bin/python

# === Ruby Tools ===
RUN gem sources --add https://mirrors.ustc.edu.cn/rubygems/ --remove https://rubygems.org/ && \
    gem install --no-document one_gadget zsteg

# === pycdc (py3.9+ bytecode decompiler) ===
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

# Under no-new-privileges, exec of a file-capability binary dies with EPERM at
# exec time whenever its caps exceed the container bounding set (NET_RAW only)
# — nmap ships net_bind_service+net_admin+net_raw. NET_RAW is granted at the
# container level, so no packaged binary needs file caps: strip them all after
# the last apt layer and assert none remain.
RUN getcap -r / 2>/dev/null | cut -d' ' -f1 | xargs -r -n1 setcap -r && \
    test -z "$(getcap -r / 2>/dev/null)"

WORKDIR /workspace

CMD ["sleep", "infinity"]

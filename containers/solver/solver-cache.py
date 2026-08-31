import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

DOWNLOAD_CACHE = "/var/cache/solver/downloads"
GIT_CACHE = "/var/cache/solver/git"

# 预下载文件清单 (文件名 -> URL)；Dockerfile 通过 $DOWNLOAD_CACHE/<name> 引用。
# CORE 随 essential 档同步，FULL 仅 full 档在其之上额外同步 (ghidra/pwndbg/内存取证/Java 反序列化)。
DOWNLOADS_CORE = {
    "wsrx.tar.gz": "https://github.com/XDSEC/WebSocketReflectorX/releases/download/0.5.17/wsrx-cli-0.5.17-linux-gnu-x86_64.tar.gz",
    "katana.zip": "https://github.com/projectdiscovery/katana/releases/download/v1.5.0/katana_1.5.0_linux_amd64.zip",
    "naabu.zip": "https://github.com/projectdiscovery/naabu/releases/download/v2.3.4/naabu_2.3.4_linux_amd64.zip",
    "dalfox.tar.gz": "https://github.com/hahwul/dalfox/releases/download/v2.12.0/dalfox-linux-amd64.tar.gz",
    "cloudfox.zip": "https://github.com/BishopFox/cloudfox/releases/download/v2.0.1/cloudfox-linux-amd64.zip",
    "kerbrute": "https://github.com/ropnop/kerbrute/releases/download/v1.0.3/kerbrute_linux_amd64",
    "bkcrack.tar.gz": "https://github.com/kimci86/bkcrack/releases/download/v1.8.1/bkcrack-1.8.1-Linux-x86_64.tar.gz",
    "dddd": "https://github.com/SleepingBag945/dddd/releases/download/v2.0.1/dddd_linux64",
    "fscan": "https://github.com/shadow1ng/fscan/releases/download/v2.2.0/fscan_2.2.0_linux_x64",
    "pwninit": "https://github.com/io12/pwninit/releases/download/3.3.3/pwninit",
}
DOWNLOADS_FULL = {
    "ghidra.zip": "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.2_build/ghidra_12.1.2_PUBLIC_20260605.zip",
    "pwndbg.deb": "https://github.com/pwndbg/pwndbg/releases/download/2026.02.18/pwndbg_2026.02.18_amd64.deb",
    "ysoserial.jar": "https://github.com/frohoff/ysoserial/releases/download/v0.0.6/ysoserial-all.jar",
    "dwarf2json": "https://github.com/volatilityfoundation/dwarf2json/releases/download/v0.9.0/dwarf2json-linux-amd64",
}

# Git 仓库清单 (名字 -> URL)；目标路径 = <base_dir>/<名字>。
# CORE 随 essential 档同步，FULL 仅 full 档在其之上额外同步 (云渗透/环境复现)。
KNOWLEDGES_CORE = {
    "PayloadsAllTheThings": "https://github.com/swisskyrepo/PayloadsAllTheThings.git",
    "InternalAllTheThings": "https://github.com/swisskyrepo/InternalAllTheThings.git",
    "hacktricks": "https://github.com/HackTricks-wiki/hacktricks.git",
    "libc-database": "https://github.com/niklasb/libc-database.git",
}
KNOWLEDGES_FULL = {
    "hacktricks-cloud": "https://github.com/HackTricks-wiki/hacktricks-cloud.git",
    "vulhub": "https://github.com/vulhub/vulhub.git",
}

# Git 仓库工具清单 (名字 -> URL)，所有档共享 (essential 起预置)
TOOLS = {
    "jwt_tool": "https://github.com/ticarpi/jwt_tool.git",
    "jdwp-shellifier": "https://github.com/IOActive/jdwp-shellifier.git",
}


def download(url: str, destination: str) -> None:
    path = Path(destination)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and path.stat().st_size:
        print(f"[solver-cache] download hit {path.name} ({path.stat().st_size} bytes)", flush=True)
        return

    print(f"[solver-cache] downloading {path.name} <- {url}", flush=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        urllib.request.urlretrieve(url, temporary)
        temporary.replace(path)
        print(f"[solver-cache] download ok {path.name} ({path.stat().st_size} bytes)", flush=True)
    except Exception as e:
        print(f"[solver-cache] download fail {path.name}: {e}", flush=True)
        raise
    finally:
        temporary.unlink(missing_ok=True)


def clone(url: str, destination: str, cache_root: str) -> None:
    """Cache mount holds a working tree; if present, copy only (no network)."""
    target = Path(destination)
    cache = Path(cache_root) / target.name
    cache.parent.mkdir(parents=True, exist_ok=True)

    if not cache.is_dir() or not any(cache.iterdir()):
        print(f"[solver-cache] git clone {target.name}", flush=True)
        shutil.rmtree(cache, ignore_errors=True)
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo"}
        subprocess.run(
            ["git", "clone", "--depth=1", "--single-branch", url, str(cache)],
            check=True,
            env=env,
        )
    else:
        print(f"[solver-cache] git cache hit {target.name}", flush=True)

    if target.exists():
        shutil.rmtree(target)
    subprocess.run(["cp", "-a", str(cache), str(target)], check=True)


def sync_downloads(tier: str) -> None:
    spec = {"core": DOWNLOADS_CORE, "full": DOWNLOADS_FULL}[tier]
    for name, url in spec.items():
        download(url, f"{DOWNLOAD_CACHE}/{name}")


def sync_git(spec: dict, base_dir: str) -> None:
    Path(base_dir).mkdir(parents=True, exist_ok=True)
    for name, url in spec.items():
        clone(url, f"{base_dir}/{name}", GIT_CACHE)


match sys.argv[1:]:
    case ["download", url, destination]:
        download(url, destination)
    case ["clone", url, destination, cache_root]:
        clone(url, destination, cache_root)
    case ["sync-downloads", tier]:
        sync_downloads(tier)
    case ["sync-knowledges", tier]:
        sync_git({"core": KNOWLEDGES_CORE, "full": KNOWLEDGES_FULL}[tier], "/opt/solver/knowledges")
    case ["sync-tools"]:
        sync_git(TOOLS, "/opt/solver/tools")
    case _:
        raise SystemExit(
            f"usage: {sys.argv[0]} [download URL DEST | clone URL DEST CACHE | "
            f"sync-downloads core|full | sync-knowledges core|full | sync-tools]"
        )

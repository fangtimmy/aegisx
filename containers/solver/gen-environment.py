"""构建时自省生成 /opt/solver/ENVIRONMENT.md。

在每个叶子 stage 的全部工具层之后运行 (Dockerfile 用 bind mount 挂入, 不落层),
只描述当前文件系统真实存在的内容: 缺失工具的章节与条目自动消失, venv 清单来自
pip freeze。文档不出现档位概念 — agent 读到的就是对自己环境的直接描述。
"""

import os
import shutil
import subprocess
import urllib.parse
from pathlib import Path


def has(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def norm(name: str) -> str:
    return name.strip().lower().replace("_", "-")


def venv_packages() -> set[str]:
    out = subprocess.run(
        ["/opt/venv/bin/pip", "freeze", "--disable-pip-version-check"],
        capture_output=True, text=True, check=True,
    ).stdout
    return {norm(line.split("==")[0]) for line in out.splitlines() if "==" in line}


VENV = venv_packages()


def vp(pkg: str) -> bool:
    return norm(pkg) in VENV


def subdirs(path: str) -> list[str]:
    p = Path(path)
    return sorted(d.name for d in p.iterdir() if d.is_dir()) if p.is_dir() else []


# ---------------------------------------------------------------- 关键路径

def section_paths() -> str:
    rows = ["| `/workspace` | 工作区: 题目附件 + agent 产出 | 读写 |"]
    knowledges = subdirs("/opt/solver/knowledges")
    if knowledges:
        rows.append(f"| `/opt/solver/knowledges` | 只读参考资料 ({', '.join(knowledges)}) | 只读 |")
    tools = subdirs("/opt/solver/tools")
    if tools:
        rows.append(f"| `/opt/solver/tools` | 只读工具源码 ({', '.join(tools)}) | 只读 |")
    rows.append("| `/opt/venv` | Python 共享环境 | 读写 |")
    if has("ghidra-analyze"):
        rows.append("| `/opt/ghidra_*` | Ghidra 安装目录 | 只读 |")
    rows.append("| `/tmp` | tmpfs (默认 1GB, 可执行)。容器重建即清空 — 需要留存的产物放工作目录 | 读写 |")
    note = ""
    if "libc-database" in knowledges:
        note = "\n\n> libc-database 只含检索脚本, 未预置 libc 库 (libc/、db/ 为空) — 用时先 `cd /opt/solver/knowledges/libc-database && ./get <distro>` 联网拉取, 或直接用在线 libc.rip。"
    table = "\n".join(rows)
    return f"## 关键路径\n\n| 路径 | 用途 | 读写 |\n|---|---|---|\n{table}{note}"


# ---------------------------------------------------------------- Python

VENV_DISPLAY = [
    "pwntools", "angr", "impacket", "pycryptodome", "pycryptodomex", "gmpy2",
    "fpylll", "sympy", "z3-solver", "numpy", "scipy", "capstone", "ropper",
    "ropgadget", "pyelftools", "scapy", "pillow", "pefile", "lief",
    "uncompyle6", "pyzbar", "pypdf", "pdfminer.six", "pyshark", "mnemonic",
    "base58", "eth-account", "pysmx", "gmssl", "mido", "opencv-python-headless",
    "cryptography", "pyOpenSSL", "pyjwt", "flask-unsign", "mitmproxy", "ldap3",
    "git-dumper", "playwright", "volatility3", "bloodyAD", "certipy-ad",
    "coercer", "pypykatz", "yara-x", "setuptools", "cysignals", "requests",
]


def wrap(names: list[str], width: int = 88) -> str:
    lines, line = [], ""
    for name in names:
        piece = f"{name} / " if name is not names[-1] else name
        if line and len(line) + len(piece) > width:
            lines.append(line.rstrip())
            line = ""
        line += piece
    if line:
        lines.append(line.rstrip())
    return "\n".join(lines)


def section_python() -> str:
    installed = [name for name in VENV_DISPLAY if vp(name)]
    listing = wrap(installed) if installed else "(无预装 CTF 库)"
    return f"""## Python (重要)

`python` / `python3` 已指向 `/opt/venv` (PATH + `/usr/local/bin` 软链)。当前 venv 已预装:

{listing}

完整列表用 `pip list` 自查; 缺包直接 `pip install` (见缺工具 SOP)。

```bash
python3 script.py
# 等价
/opt/venv/bin/python script.py
```"""


# ---------------------------------------------------------------- 特殊命令入口

def section_commands() -> str:
    rows: list[tuple[str, str]] = []
    if has("ghidra-analyze"):
        rows.append(("`ghidra-analyze`", "Ghidra headless 反编译 (软链到 `/opt/ghidra_*/support/analyzeHeadless`)"))
    if has("fd"):
        rows.append(("`fd`", "等价 `fdfind` (ripgrep 家族文件搜索)"))
    if has("gdb"):
        desc = "gdb 启动自动加载 pwndbg 集成" if has("pwndbg") else "裸 gdb (无插件)"
        rows.append(("`gdb`", desc))
    if has("pwninit"):
        rows.append(("`pwninit`", "自动配对附件自带 libc/ld 并 patch 二进制 (pwn 题附件带 libc 时先跑它)"))
    if has("llvm-pdbutil"):
        rows.append(("`llvm-pdbutil`", "PDB 调试信息解析 (Windows .pdb)"))
    if has("dwarf2json"):
        rows.append(("`dwarf2json`", "vmlinux DWARF → volatility3 ISF 符号表"))
    if has("bkcrack"):
        rows.append(("`bkcrack`", "ZipCrypto known-plaintext 攻击"))
    if has("wine64"):
        rows.append(("`wine64` / `wine`", "运行 64 位 x86 Windows PE (见下节)"))
    if has("pycdc"):
        rows.append(("`pycdc` / `pycdas`", "Python 字节码反编译/反汇编; pycdc 对 3.13 退化 (调用语句变形, 此时以 `pycdas` 为准); ≤3.8 用 uncompyle6"))
    if Path("/opt/solver/tools/jwt_tool").is_dir():
        rows.append(("`jwt_tool.py`", "不在 PATH: `python3 /opt/solver/tools/jwt_tool/jwt_tool.py`"))
    body = "\n".join(f"| {cmd} | {desc} |" for cmd, desc in rows)
    return f"## 特殊命令入口\n\n| 命令 | 说明 |\n|---|---|\n{body}"


# ---------------------------------------------------------------- Windows exe (wine)

def section_wine() -> str:
    if not has("wine64"):
        return ""
    return """## Windows exe (wine)

`wine64 xxx.exe`（`wine` 同义），交互程序正常吃 stdin。首次运行会初始化 `~/.wine`（几秒）。

- **仅 64 位 x86 PE**：32 位 PE 没有可用运行时（Rosetta 无 32 位 x86，wine 包不带 wow64 DLL），只能静态分析。
- 输出中夹带的 `rosetta error: ...`、`failed to open ...syswow64\\rundll32.exe` 等行是翻译层噪音，可忽略。
- **兼容性有限**：个别二进制启动即 `Trace/breakpoint trap` (SIGTRAP，伴随 gdt 报错)——Rosetta 翻译层对部分启动路径 (如 Go 运行时定时器线程) 有 bug，随基础库版本漂移。遇到即转静态分析，不要重试。"""


# ---------------------------------------------------------------- 工具分类速查

def categories() -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []

    def items(pairs: list[tuple[str, bool]]) -> str:
        return ", ".join(label for label, ok in pairs if ok)

    web = items([
        ("nmap", has("nmap")), ("masscan", has("masscan")), ("sqlmap", has("sqlmap")),
        ("wfuzz", has("wfuzz")), ("ffuf", has("ffuf")), ("dirsearch", has("dirsearch")),
        ("feroxbuster", has("feroxbuster")), ("httpx", has("httpx-toolkit")),
        ("nuclei", has("nuclei")), ("katana", has("katana")), ("naabu", has("naabu")),
        ("dalfox", has("dalfox")), ("nikto", has("nikto")), ("dddd", has("dddd")),
        ("fscan", has("fscan")), ("wsrx", has("wsrx")), ("mitmproxy (venv)", has("mitmproxy")),
    ])
    if web:
        result.append(("Web", web))

    pwn = items([
        ("gdb (pwndbg 集成)", has("pwndbg")), ("gdb", has("gdb") and not has("pwndbg")),
        ("ropper (venv)", vp("ropper")), ("ropgadget (venv)", vp("ropgadget")),
        ("rizin", has("rizin")), ("checksec", has("checksec")),
        ("qemu-user", has("qemu-x86_64")), ("one_gadget", has("one_gadget")),
        ("pwninit", has("pwninit")), ("patchelf", has("patchelf")), ("strace", has("strace")),
        ("upx", has("upx")), ("bkcrack", has("bkcrack")), ("jadx", has("jadx")),
        ("apktool", has("apktool")),
    ])
    if pwn:
        result.append(("Binary/Pwn", pwn))

    seclists = subdirs("/usr/share/seclists")
    forensics = items([
        ("binwalk", has("binwalk")), ("foremost", has("foremost")),
        ("steghide", has("steghide")), ("zsteg", has("zsteg")), ("pngcheck", has("pngcheck")),
        ("exiftool", has("exiftool")), ("ffmpeg", has("ffmpeg")),
        ("imagemagick (`convert`/`identify`)", has("convert")),
        ("sleuthkit (`fls`/`mmls`)", has("fls")), ("testdisk/photorec", has("testdisk")),
        ("volatility3 (venv)", vp("volatility3")), ("dwarf2json", has("dwarf2json")),
    ])
    if forensics:
        result.append(("Forensics/Stego", forensics))

    ocr = items([
        ("tesseract", has("tesseract")), ("pdfinfo/pdftotext (poppler)", has("pdftotext")),
        ("zbarimg", has("zbarimg")), ("pillow/pyzbar/pypdf/pdfminer (venv)",
                                      any(vp(p) for p in ("pillow", "pyzbar", "pypdf", "pdfminer.six"))),
    ])
    if ocr:
        result.append(("OCR/Docs/QR", ocr))

    ad = items([
        ("smbclient", has("smbclient")), ("enum4linux-ng", has("enum4linux-ng")),
        ("kerbrute", has("kerbrute")), ("impacket (venv)", vp("impacket")),
        ("netexec", has("netexec")), ("evil-winrm", has("evil-winrm")),
        ("responder", has("responder")), ("bloodyAD (venv)", vp("bloodyAD")),
        ("certipy-ad (venv)", vp("certipy-ad")), ("coercer (venv)", vp("coercer")),
        ("pypykatz (venv)", vp("pypykatz")),
    ])
    if ad:
        result.append(("AD/Windows", ad))

    crypto = items([
        ("pycryptodome", vp("pycryptodome")), ("gmpy2", vp("gmpy2")), ("sympy", vp("sympy")),
        ("z3-solver", vp("z3-solver")), ("fpylll", vp("fpylll")), ("pysmx", vp("pysmx")),
        ("gmssl", vp("gmssl")), ("mnemonic", vp("mnemonic")), ("eth-account (venv)", vp("eth-account")),
        ("numpy/scipy (venv)", vp("numpy")),
    ])
    if crypto:
        result.append(("Crypto", crypto))

    rev = items([
        ("uncompyle6", has("uncompyle6")), ("pycdc/pycdas", has("pycdc")),
        ("pefile", vp("pefile")), ("lief", vp("lief")), ("pyelftools", vp("pyelftools")),
        ("llvm-pdbutil", has("llvm-pdbutil")), ("angr (venv)", vp("angr")),
        ("opencv (venv)", vp("opencv-python-headless")),
    ])
    if rev:
        result.append(("Rev helpers", rev))

    if has("cloudfox"):
        result.append(("Cloud", "cloudfox"))

    java = items([
        ("ysoserial.jar (`/opt/solver/tools/`)", Path("/opt/solver/tools/ysoserial.jar").is_file()),
        ("jdwp-shellifier (`/opt/solver/tools/`)", Path("/opt/solver/tools/jdwp-shellifier").is_dir()),
        ("jadx", has("jadx")), ("jdk", has("javac")),
    ])
    if java:
        result.append(("Java", java))

    if has("ruby") or has("zsteg"):
        result.append(("Ruby", "one_gadget, zsteg" if has("one_gadget") and has("zsteg") else "zsteg"))

    if has("php"):
        result.append(("PHP", "php8.4 CLI, 常用扩展已预装 (gd / mbstring / xml / zip / curl / sqlite3 / imagick); 本地起服务用 `php -S 127.0.0.1:<port>`"))

    brute = items([
        ("john", has("john")), ("hashcat", has("hashcat")),
        ("fcrackzip", has("fcrackzip")), ("rarcrack", has("rarcrack")),
    ])
    wordlists = []
    if Path("/usr/share/wordlists/rockyou.txt").is_file():
        wordlists.append("字典 rockyou (`/usr/share/wordlists/rockyou.txt`)")
    if seclists:
        wordlists.append(f"seclists ({', '.join(seclists)})")
    if brute or wordlists:
        parts = [brute] + wordlists
        result.append(("Bruteforce/字典", "; ".join(p for p in parts if p)))

    misc = items([
        ("jq", has("jq")), ("yq", has("yq")), ("rg", has("rg")), ("fd", has("fd")),
        ("bc", has("bc")), ("7z", has("7z")), ("unzip", has("unzip")), ("file", has("file")),
        ("rlwrap", has("rlwrap")), ("chisel", has("chisel")), ("ncat", has("ncat")),
        ("socat", has("socat")), ("dig", has("dig")), ("masscan", has("masscan")),
        ("tcpdump", has("tcpdump")), ("sqlite3", has("sqlite3")),
        ("redis-cli", has("redis-cli")), ("cmake", has("cmake")),
        ("binutils (objdump/strings/readelf)", has("objdump")),
    ])
    if misc:
        result.append(("Misc", misc))

    return result


def section_categories() -> str:
    blocks = [f"- **{title}**: {body}" for title, body in categories()]
    if not blocks:
        return ""
    intro = "不是完整列表, 用 `which <tool>` / `ls /usr/local/bin` / `compgen -c` 自行探."
    return "## 工具分类速查\n\n" + intro + "\n\n" + "\n".join(blocks)


# ---------------------------------------------------------------- Workspace / SOP / volatility3

def section_workspace() -> str:
    return """## Workspace 约定

- 子 agent 共享 `/workspace`, 用不同文件名避免互相覆盖.
- 远程响应落盘后再分析, 不要重复拉取."""


def section_sop() -> str:
    mirror = urllib.parse.urlparse(os.environ.get("PIP_INDEX_URL", "")).netloc or "公共 PyPI"
    return f"""## 缺工具时的安装 SOP

按顺序尝试, 通常一两分钟到位:

1. **Python 包** → `pip install <pkg>` (已配 {mirror}, wheel 秒装; 装进共享 venv, 同题容器内所有 agent 立即可用).
2. **系统包** → 允许直接 apt 安装: 容器出厂**没有 apt 索引**, 先 `apt-get update -qq` 再 `apt-get install -y <pkg>` (kali-rolling).
3. **装完必剥 file caps** → 新装的系统包可能自带 file capabilities (如 tcpdump 的 `cap_net_admin`), 而 no-new-privileges 下 exec 带 caps 的二进制直接 EPERM. 装完立即检查并剥离 (容器已授予 SETFCAP, `setcap -r` 可正常执行):

   ```bash
   getcap -r /usr/bin /usr/sbin /usr/local/bin /opt 2>/dev/null
   setcap -r <path>   # 对上一条每个命中路径各执行一次
   ```

4. 安装只对**当前题容器**生效, 容器重建即丢; 源码编译类大活放后台 (`nohup ... > build.log 2>&1 &`) 再轮询日志.
5. 装不上就换不需要该工具的思路 — 不要在安装上耗过解题本身."""


def section_volatility() -> str:
    if not (has("vol") or vp("volatility3")):
        return ""
    return """## volatility3 符号表 (内存取证)

`vol` 自带 yara-x (python 模块 `yara_x`)。符号表 (ISF) 不预置, 按镜像类型自备:

- **Linux**: `strings <dump> | grep -m1 "Linux version"` 取内核版本 → 找到带 DWARF 的 vmlinux/调试符号包 → `dwarf2json linux --elf <vmlinux> > <kernel>.isf` → 放入 `/root/.cache/volatility3/symbols/`。
- **Windows**: vol 自动下载对应 PDB 生成 ISF (需外网; `windows.info` 报 symbol 相关错误时先确认网络)。
- 符号表拿不到时, strings / 手工 carving 仍是可行路径。"""


def main() -> None:
    sections = [
        section_paths(),
        section_python(),
        section_commands(),
        section_wine(),
        section_categories(),
        section_workspace(),
        section_sop(),
        section_volatility(),
    ]
    print("# AegisX Solver Environment\n")
    print("本文档由镜像构建时自动生成, 只描述当前镜像实际包含的内容与用法。\n")
    print("\n\n".join(s for s in sections if s))


if __name__ == "__main__":
    main()

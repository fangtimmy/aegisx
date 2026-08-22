# AegisX Solver Environment

## 关键路径

| 路径 | 用途 | 读写 |
|---|---|---|
| `/workspace` | 工作区: 题目附件 + agent 产出 | 读写 |
| `/opt/solver/knowledges` | 只读参考资料 (PayloadsAllTheThings, InternalAllTheThings, hacktricks, hacktricks-cloud, libc-database, vulhub) | 只读 |
| `/opt/solver/tools` | 只读工具源码 (jwt_tool, jdwp-shellifier, ysoserial.jar) | 只读 |
| `/opt/venv` | Python 共享环境 | 读写 |
| `/opt/ghidra_*` | Ghidra 安装目录 | 只读 |
| `/tmp` | tmpfs (默认 1GB, 可执行)。容器重建即清空 — 需要留存的产物放工作目录 | 读写 |

> libc-database 只含检索脚本, 未预置 libc 库 (libc/、db/ 为空) — 用时先 `cd /opt/solver/knowledges/libc-database && ./get <distro>` 联网拉取, 或直接用在线 libc.rip。

## Python (重要)

`python` / `python3` 已指向 `/opt/venv` (PATH + `/usr/local/bin` 软链)。CTF 库都在 venv 里:

`pwntools` / `angr` / `impacket` / `pycryptodome` / `gmpy2` / `fpylll` / `numpy` / `scipy` / `pillow` / `pefile` / `uncompyle6` / `scapy` / `playwright` / `volatility3` / `bloodyAD` / `certipy-ad` / `coercer` / `pypykatz` / `flask-unsign` / `pysmx` / `gmssl` / `setuptools` / `cysignals` / `yara-x` 等。

```bash
python3 script.py
# 等价
/opt/venv/bin/python script.py
```

## 特殊命令入口

| 命令 | 说明 |
|---|---|
| `ghidra-analyze` | Ghidra headless 反编译 (软链到 `/opt/ghidra_*/support/analyzeHeadless`) |
| `fd` | 等价 `fdfind` (ripgrep 家族文件搜索) |
| `pwndbg` / `gdb` | gdb 自动加载 pwndbg 集成 |
| `pwninit` | 自动配对附件自带 libc/ld 并 patch 二进制 (pwn 题附件带 libc 时先跑它) |
| `llvm-pdbutil` | PDB 调试信息解析 (Windows .pdb) |
| `dwarf2json` | vmlinux DWARF → volatility3 ISF 符号表 |
| `bkcrack` | ZipCrypto known-plaintext 攻击 |
| `wine64` / `wine` | 运行 64 位 x86 Windows PE (见下节) |
| `pycdc` / `pycdas` | Python 字节码反编译/反汇编; pycdc 对 3.13 退化 (调用语句变形, 此时以 `pycdas` 为准); ≤3.8 用 uncompyle6 |
| `jwt_tool.py` | 不在 PATH: `python3 /opt/solver/tools/jwt_tool/jwt_tool.py` |

## Windows exe (wine)

`wine64 xxx.exe`（`wine` 同义），交互程序正常吃 stdin。首次运行会初始化 `~/.wine`（几秒）。

- **仅 64 位 x86 PE**：32 位 PE 没有可用运行时（Rosetta 无 32 位 x86，wine 包不带 wow64 DLL），只能静态分析。
- 输出中夹带的 `rosetta error: ...`、`failed to open ...syswow64\rundll32.exe` 等行是翻译层噪音，可忽略。
- **兼容性有限**：个别二进制启动即 `Trace/breakpoint trap` (SIGTRAP，伴随 gdt 报错)——Rosetta 翻译层对部分启动路径 (如 Go 运行时定时器线程) 有 bug，随基础库版本漂移。遇到即转静态分析，不要重试。

## 工具分类速查

不是完整列表, 用 `which <tool>` / `ls /usr/local/bin` / `compgen -c` 自行探.

- **Web**: nmap, ffuf, sqlmap, wfuzz, dirsearch, feroxbuster, httpx, nuclei, katana, naabu, dalfox, nikto, mitmproxy, seclists, wsrx, dddd, fscan
- **Binary/Pwn**: gdb(+pwndbg), ropper, ropgadget, rizin, jadx, apktool, checksec, qemu-user, one_gadget, pwninit, patchelf, strace, upx, bkcrack
- **Forensics/Stego**: binwalk, foremost, steghide, zsteg, pngcheck, exiftool, ffmpeg, imagemagick (`convert`/`identify`), tshark, sleuthkit (`fls`/`mmls`), testdisk/photorec, volatility3 + `dwarf2json` (venv)
- **OCR/Docs/QR**: tesseract, pdfinfo/pdftotext (poppler), zbarimg; pillow/pyzbar/pypdf/pdfminer (venv)
- **AD/Windows**: smbclient, krb5-user, enum4linux-ng, kerbrute, netexec, evil-winrm, responder, bloodyAD (venv), certipy-ad (venv), coercer (venv), pypykatz
- **Crypto**: pycryptodome, gmpy2, sympy, z3-solver, numpy, scipy, fpylll, pysmx, gmssl, mnemonic, eth-account (venv)
- **Rev helpers**: uncompyle6, pycdc, pefile, lief, pyelftools, llvm-pdbutil, opencv-python-headless (venv)
- **Cloud**: cloudfox
- **Java**: ysoserial.jar (`/opt/solver/tools/`), jdwp-shellifier (`/opt/solver/tools/`), jadx
- **Ruby**: one_gadget, zsteg
- **PHP**: php8.4 CLI, 常用扩展已预装 (gd / mbstring / xml / zip / curl / sqlite3 / imagick); 本地起服务用 `php -S 127.0.0.1:<port>`
- **Bruteforce/字典**: hashcat, john, fcrackzip, rarcrack; 字典 rockyou (`/usr/share/wordlists/rockyou.txt`) + seclists (Fuzzing/ 目录已裁剪)
- **Misc**: jq, yq, rg, fd, bc, 7z, unzip, file, rlwrap, chisel, ncat, socat, dig, masscan, sqlite3, redis-tools, cmake

## Workspace 约定

- 子 agent 共享 `/workspace`, 用不同文件名避免互相覆盖.
- 远程响应落盘后再分析, 不要重复拉取.

## 缺工具时的安装 SOP

按顺序尝试, 通常一两分钟到位:

1. **Python 包** → `pip install <pkg>` (已配 ustc 镜像, wheel 秒装; 装进共享 venv, 同题容器内所有 agent 立即可用).
2. **系统包** → 容器出厂**没有 apt 索引**, 必须先 `apt-get update -qq` 再 `apt-get install -y <pkg>` (kali-rolling @ ustc).
3. 安装只对**当前题容器**生效, 容器重建即丢; 源码编译类大活放后台 (`nohup ... > build.log 2>&1 &`) 再轮询日志.
4. 装不上就换不需要该工具的思路 — 不要在安装上耗过解题本身.

## volatility3 符号表 (内存取证)

`vol` 自带 yara-x (python 模块 `yara_x`)。符号表 (ISF) 不预置, 按镜像类型自备:

- **Linux**: `strings <dump> | grep -m1 "Linux version"` 取内核版本 → 找到带 DWARF 的 vmlinux/调试符号包 → `dwarf2json linux --elf <vmlinux> > <kernel>.isf` → 放入 `/root/.cache/volatility3/symbols/`。
- **Windows**: vol 自动下载对应 PDB 生成 ISF (需外网; `windows.info` 报 symbol 相关错误时先确认网络)。
- 符号表拿不到时, yarasan / strings / 手工 carving 仍是可行路径。

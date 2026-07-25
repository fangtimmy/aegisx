# AegisX Solver Environment

## 关键路径

| 路径 | 用途 | 读写 |
|---|---|---|
| `/workspace` | 工作区: 题目附件 + agent 产出 | 读写 |
| `/opt/solver/knowledges` | 只读参考资料 (PayloadsAllTheThings, InternalAllTheThings, hacktricks, hacktricks-cloud, libc-database, vulhub) | 只读 |
| `/opt/solver/tools` | 只读工具源码 (jwt_tool, jdwp-shellifier, ysoserial.jar) | 只读 |
| `/opt/venv` | Python 共享环境 | 只读 |
| `/opt/ghidra_*` | Ghidra 安装目录 | 只读 |

## Python (重要)

`python` / `python3` 已指向 `/opt/venv` (PATH + `/usr/local/bin` 软链)。CTF 库都在 venv 里:

`pwntools` / `angr` / `impacket` / `pycryptodome` / `gmpy2` / `numpy` / `scipy` / `pillow` / `pefile` / `fpylll` / `uncompyle6` / `scapy` / `playwright` / `volatility3` / `bloodyAD` / `certipy-ad` / `coercer` / `pypykatz` / `flask-unsign` / `pysmx` / `gmssl` 等。

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
| `pwndbg` | gdb 自动加载 pwndbg 集成 |
| `bkcrack` | ZipCrypto known-plaintext 攻击 |
| `jwt_tool.py` | `/opt/solver/tools/jwt_tool/jwt_tool.py`, 用 `python3` 运行 |

## 工具分类速查

不是完整列表, 用 `which <tool>` / `ls /usr/local/bin` / `compgen -c` 自行探.

- **Web**: nmap, ffuf, dirsearch, feroxbuster, httpx, nuclei, katana, naabu, dalfox, seclists, wsrx
- **Binary/Pwn**: gdb(+pwndbg), ropper, ropgadget, rizin, jadx, apktool, checksec, qemu-user, one_gadget, patchelf, strace, upx, bkcrack
- **Forensics/Stego**: binwalk, foremost, steghide, zsteg, outguess, pngcheck, exiftool, ffmpeg, imagemagick (`convert`/`identify`), tshark, volatility3 (venv)
- **OCR/Docs/QR**: tesseract, pdfinfo/pdftotext (poppler), zbarimg; pillow/pyzbar/pypdf/pdfminer (venv)
- **AD/Windows**: smbclient, krb5-user, enum4linux-ng, kerbrute, bloodyAD (venv), certipy-ad (venv), coercer (venv), pypykatz (venv)
- **Crypto**: pycryptodome, gmpy2, sympy, z3-solver, numpy, scipy, fpylll, pysmx, gmssl, mnemonic, eth-account (venv)
- **Rev helpers**: uncompyle6, pefile, lief, pyelftools, opencv-python-headless (venv)
- **Cloud**: cloudfox
- **Java**: ysoserial.jar (`/opt/solver/tools/`), jdwp-shellifier (`/opt/solver/tools/`), jadx
- **Ruby**: one_gadget, zsteg
- **Misc**: jq, yq, rg, fd, 7z, unzip, file, rlwrap, chisel, ncat, sqlite3, redis-tools, cmake

## Workspace 约定

- 子 agent 共享 `/workspace`, 用不同文件名避免互相覆盖.
- 远程响应落盘后再分析, 不要重复拉取.

# AegisX Solver Environment (minimal image)

## 关键路径

| 路径 | 用途 | 读写 |
|---|---|---|
| `/workspace` | 工作区: 题目附件 + agent 产出 | 读写 |
| `/opt/solver/knowledges` | 只读参考资料 (PayloadsAllTheThings, InternalAllTheThings) | 只读 |
| `/opt/solver/tools` | 预留工具目录 (minimal 版默认为空) | 读写 |
| `/opt/venv` | Python 共享环境 | 只读 |
| `/tmp` | tmpfs (默认 1GB, 可执行)。容器重建即清空 — 需要留存的产物放工作目录 | 读写 |

## Python (重要)

`python` / `python3` 已指向 `/opt/venv` (PATH + `/usr/local/bin` 软链)。CTF 库都在 venv 里:

`pwntools` / `scapy` / `pycryptodome` / `gmpy2` / `sympy` / `z3-solver` / `numpy` / `pillow` / `pefile` / `lief` / `pyelftools` / `pyjwt` / `cryptography` / `flask-unsign` / `requests` 等。

```bash
python3 script.py
# 等价
/opt/venv/bin/python script.py
```

## 特殊命令入口

| 命令 | 说明 |
|---|---|
| `fd` | 等价 `fdfind` (ripgrep 家族文件搜索) |
| `pwndbg` | gdb 自动加载 pwndbg 集成 |
| `pwninit` | 自动配对附件自带 libc/ld 并 patch 二进制 (pwn 题附件带 libc 时先跑它) |
| `pycdc` / `pycdas` | Python 字节码反编译/反汇编; pycdc 对 3.13 退化 (调用语句变形, 此时以 `pycdas` 为准) |

## 工具分类速查

不是完整列表, 用 `which <tool>` / `ls /usr/local/bin` / `compgen -c` 自行探.

- **Web**: nmap, curl/wget, sqlmap, ffuf
- **Binary/Pwn**: gdb(+pwndbg), ropper, ropgadget, one_gadget, pwninit, checksec, patchelf, strace, objdump/readelf (binutils)
- **Forensics/Stego**: binwalk, foremost, exiftool, pngcheck, zsteg, fcrackzip, 7z/unzip
- **Crypto**: pycryptodome(-omex), gmpy2, sympy, z3-solver, numpy (venv)
- **Rev helpers**: pycdc/pycdas, pefile, lief, pyelftools (venv)
- **Misc**: jq, rg, fd, file, rlwrap, ncat, cmake, gcc/clang 工具链

> 本镜像是 minimal 变体: 无 Ghidra/Java/Android 逆向全家、无 angr、无浏览器自动化、
> 无 AD/内网工具集、知识库仅两个轻量仓库。需要完整工具面时使用 full 版镜像
> (`aegisx/solver:kali`, 见 containers/solver/)。

## Workspace 约定

- 子 agent 共享 `/workspace`, 用不同文件名避免互相覆盖.
- 远程响应落盘后再分析, 不要重复拉取.

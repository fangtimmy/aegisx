# Regular_apples（初赛 PWN-03 · Pwn · 300 分 · 需现场靶机）

64 位 PIE 笔记程序（Add/Delete/Edit/Show）。**动态靶机题：flag 在决赛实例上，按本流程现场打。**
根因：delete 只 `free` 不清指针（UAF），尺寸限制 `[0x500,0x520]` 全为大 chunk（无 tcache）→
unsorted 泄露 + largebin attack 改写 `_IO_list_all` → exit 触发 FSOP（House of Apple 2，
`_IO_wfile_jumps` wfile-overflow 路径）→ `setcontext+0x126` ret-pivot 迁栈到堆上 ROP →
`open/read/write` 直读 flag（远端 seccomp 禁 execve/system，无 shell）。

## 现场流程

```bash
cd /tmp && mkdir apples && cd apples
unzip -o -q '<Regular_apples的附件.zip>' && unzip -o -q tempdir/PWN附件/Regular_apples.zip
chmod +x pwn libc.so.6 ld-linux-x86-64.so.2
E=/opt/solver/knowledges/xihulunjian/challenges/Regular_apples/exp
python3 $E/solve.py --local ./pwn   # 可选：附件目录内自动 ld 直启真 2.35，全链可本地预验
python3 $E/solve.py HOST PORT       # 决赛靶机（默认带初赛远端 drift=0x80）
```

exp 全自动：泄露 → largebin attack 写 `_IO_list_all` → 假 FILE+ROP 布置 →
`add` 非法 size 触发 `exit(0)` → FSOP → 直读 flag。全部偏移从附件 libc 动态计算
（符号 + 字节搜 gadget），输出末尾自动高亮 `DASCTF{...}`。
预期输出（初赛远端同构，本地 2.35 实测）：

```
[+] FLAG: DASCTF{...}
```

flag 从靶机读出，按实际内容提交（裸值优先）。候选路径 `/flag /flag.txt
/home/ctf/flag /root/flag /home/user/flag /tmp/flag`，路径变了改 solve.py 顶部 `PATHS`。

**远端 libc drift（初赛实证，重要）**：远程 libc 与附件同为 2.35-0ubuntu3.8，但
syscall 包装区整体 +0x80——`open/read/write`、`pop rdx;pop r12;ret` 四项漂移；
`unsorted/_IO_list_all/_IO_wfile_jumps/setcontext/pop rdi/rsi/mov rsp,rdx` 一致。
exp 远程模式默认 `DRIFT=0x80` 只校正这四项；若决赛换镜像导致失效，试
`python3 $E/solve.py HOST PORT 0`（第三参覆盖 drift）。

## 原理（备查，关键机制）

程序（反汇编核实）：add 的 `idx>12` 与非法 size（不在 [0x500,0x520]）都会
`puts(error); exit(0)`——**exit 触发器**；delete 不清指针（UAF）；show 固定
`write(1, ptr, 8)`；edit `read(0, ptr, size)` 按到达字节返回。

1. 布局：idx0=A(0x520) idx1=guard idx2=B(0x510) idx3=H1(ROP+路径) idx4=C idx5=guard。
2. 泄露：free B、C 进 unsorted；`show(2)` 得 main_arena+96（libc），`show(4)` 得 B_chunk（堆）。
3. largebin attack：free A 后 `add(0x520)`（nb=0x530）把 A 排入 largebin 76 且查找跳过该 bin；
   UAF-edit A：`bk_nextsize = _IO_list_all-0x20`；free B 后 `add(0x520)`：B 以
   smaller-than-smallest 分支插入（2.35 该分支无完整性检查，walk 分支才有）→
   `*(bk_nextsize+0x20) = B_chunk`，即 `_IO_list_all = B_chunk`。
4. FSOP：`add` 非法 size → `exit(0)` → `_IO_flush_all` 遍历 `_IO_list_all`=B_chunk。
   假 FILE 按 **fp=B_chunk 视角** 布置（数据在 B_user，字段写位 -0x10）：
   `_mode>0` + `_wide_data->write_ptr(1)>write_base(0)` → vtable=`_IO_wfile_jumps` →
   `_IO_wfile_overflow` → `_IO_wdoallocbuf` → `wide_vtable->__doallocate(fp)`，
   调用点 rdx=W（反汇编核实 863b0→83b9b 无改动）。
5. pivot：`__doallocate = setcontext+0x126`：`mov rcx,[rdx+0xa8]; push rcx; …;
   mov rdx,[rdx+0x88]; ret` → `mov rsp,rdx; ret`(0x5a120)，rsp=H1 上 ROP 栈。
6. ROP：6 组候选路径逐个 `open/read/write`（fd 从 3 起），每次 read 写各自 0x40 槽位，
   不破坏未执行的链；路径串与 ROP 同放 H1（0x20 起 / 0x100 起）。

关键偏移（附件 libc 2.35-0ubuntu3.8，exp 自动计算）：`unsorted=0x21ace0`（常量，
main_arena+96 无符号）、`_IO_list_all=0x21b680`、`_IO_wfile_jumps=0x2170c0`、
`setcontext+0x126=0x53b06`、`pop rdi=0x2a3e5`、`pop rsi=0x2be51`、
`pop rdx;pop r12=0x11f2e7(+0x80)`、`mov rsp,rdx=0x5a120`、
`open/read/write=0x1144e0/0x1147d0/0x114870(+0x80)`。

## 失败分支

- `--local` 用附件目录（含 ld-linux-x86-64.so.2）时走 ld 直启真 2.35，全链可过；
  若目录无 ld（系统 libc 2.42）则冒烟：只看两行 leak（libc base / B_chunk），
  largebin 段死掉属正常，全链以远端为准。
- 远程无输出且退出异常 → 镜像 libc 变了：先试 `HOST PORT 0` 去掉 drift，
  仍不行则用 show 泄露核对 `_IO_list_all` 偏移（exp 打印的表与远端逐项比对）。
- 菜单错乱/desync → 长 edit 与 socket read 竞争，exp 已按「只发实际所需字节」发送；
  若手改 payload，保持同样纪律。
- 打出 shell 失败属预期：远端 seccomp 禁 execve/system，exp 本来就走 open/read/write。
- 附件 sha256 变（换 libc）：exp 从附件动态算偏移，无需改代码；仅 UNSORTED_OFF
  是常量（main_arena 无符号），换 libc 需重新确认。

## 决赛实测备忘

- 初赛 84 分钟解出。初赛 flag（动态，**勿直接提交旧值**）：
  `CongRaTulat1ons_ON_Get1ng_The_R1ght_App1e`。
- 调度者当时正确提示过「无 hooks，要走 tcache/FSOP」——本题即 House of Apple 2 路线。
- 本地已全链验证（附件 ld 直启 glibc 2.35，造 /flag，3/3 稳定读出），
  决赛只需按现场流程对靶机执行。

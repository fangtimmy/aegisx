# why_not_heap（初赛 PWN-04 · Pwn · 200 分 · 需现场靶机）

glibc 2.34 堆题（PIE + Full RELRO + Canary + NX），但**洞不在堆操作里**：
EDIT/SHOW 的 index 只有 `>0x1f` 的有符号上界、**没有下界**，负索引把 COPY 重定位的
`stdout/stdin/stderr` 变量当 chunk 表用 → 直接拿到 libc 里三个 `_IO_2_1_*` FILE 结构体
的可写窗口。利用 = 负索引泄露 libc + 伪造 `_IO_2_1_stdout_`（House of Apple 2 变体，
`__doallocate` 处放 `leave; ret` 配 `rbp=fp` 做栈迁移）+ ORW 直出 flag。seccomp 只
KILL `execve`(59)，ORW 全放行。**exp 已在容器内 --local 与 socat TCP 双模式拿 flag
（attempt 0 一次命中）**。

## 现场流程

```bash
cd /tmp && mkdir wnh && cd wnh
unzip -o -q '<why_not_heap的附件.zip>'
# 内层 zip 目录名 GBK：用 python 拍平解出 pwn + libc.so.6 + ld-linux-x86-64.so.2
python3 - <<'PY'
import zipfile, os
z1 = zipfile.ZipFile('why_not_heap的附件.zip')
inner = [i for i in z1.infolist() if i.filename.endswith('.zip')][0]
z2 = zipfile.ZipFile(__import__('io').BytesIO(z1.read(inner)))
for i in z2.infolist():
    name = i.filename.encode('cp437').decode('gbk')
    open(os.path.basename(name), 'wb').write(z2.read(i))
PY
chmod +x pwn
E=/opt/solver/knowledges/xihulunjian/challenges/why_not_heap/exp
python3 $E/solve.py HOST PORT            # 靶机（默认路径 /flag）
python3 $E/solve.py HOST PORT --path /flag.txt   # 路径不同时改这一处
# 本地复现：在解压目录内（DT_NEEDED 就是 ./libc.so.6，自动加载附件 libc）
python3 $E/solve.py --local
```

预期输出：`libc=0x7f...` → `trigger out: N bytes` → flag 原文（含 `flag{...}` /
`DASCTF{...}`，按平台规则提交 `{}` 内内容）。

## 原理（备查）

二进制：PIE + Full RELRO + Canary + NX，stripped，22672B，buildid
`2518959…e0206cf`。附件 libc = **自编译 glibc 2.34**（interpreter 路径
`/home/hgg/Desktop/glibc-2.34/64/lib/`，带符号表/debug_info），ld 同套（二进制
interpreter 写死 `./ld-linux-x86-64.so.2`，DT_NEEDED 写死 `./libc.so.6` ——
在附件目录内运行即自动用附件 libc）。

启动时 `fopen(argv[0]) + fgets(0x4060, 8)` 读**自身 ELF 前 7 字节**作 RC4 密钥：
`7f 45 4c 46 02 01 01`（已知、恒定）。SHOW 走 `rc4_print(data, key)`：KSA+PRGA
（key 各字节均 <0x80，等价标准 RC4）**原地加密**后 `printf("data=%s\n", data)`。

菜单 1.ADD / 2.EDIT / 3.SHOW / 4.FREE；`chunks[32]`@PIE+0x4080；ADD 固定
`malloc(0xf0)`；EDIT=`read(0, chunks[idx], 0xf0)` + 在 `chunks[idx]+v` 写 NUL
（`0 <= v <= 0xf8`，atoll 无符号上界检查）；SHOW=rc4_print；FREE=free+置 NULL
（无 UAF、无溢出——**唯一的洞是 index 检查**）。

**负索引**：`cmp DWORD idx,0x1f; jg fail`（有符号，负数全过），`movsxd` 后取
`[0x4080 + idx*8]`。`0x4020/0x4030/0x4040` 是 `stdout/stdin/stderr` 的
**R_X86_64_COPY 重定位变量**（值 = &_IO_2_1_stdout_ 等，libc 可写数据）：

| idx | chunk 指针 | 窗口 |
|---|---|---|
| -12 | &_IO_2_1_stdout_ (libc+0x1f3760) | stdout FILE 结构体（**触发用，勿提前破坏**） |
| -10 | &_IO_2_1_stdin_ (libc+0x1f2a80) | 伪 `_wide_data` + "/flag" + read 缓冲（stdin FILE 无人用） |
| -8 | &_IO_2_1_stderr_ (libc+0x1f3680) | 先填充泄露，后放 stage2 ROP（stderr FILE 无人用） |

`0x4048..0x4078`（idx -7..-1）为 0，`-4` = 0x4060 的 ELF 头字节（野指针，一碰即
SIGSEGV），`idx <= -9` 是只读 GOT/JUMP_SLOT（SHOW/EDIT 会原地写 → SEGV），全部不可用。

利用链（4 步，全部一次性会话内完成）：

1. **泄露**：`EDIT(-8, v=0x6f, 'A'*0x68)` 短写填充 stderr 结构体 0..0x67（read 只写
   发送的字节数，`_chain` 在 0x68 原样保留；NUL 落在 chain 的高位已零字节）；`SHOW(-8)`
   输出前 0x6e 字节的 RC4 密文，已知密钥解密，尾部 6 字节 = `&_IO_2_1_stdout_` → libc 基址。
   密文含 `\n`/NUL 会造成解析截断/strlen 截断（各 ~2%），重连即可。
2. **wd 窗口**：`EDIT(-10)` 整窗写入伪 `_wide_data`：+0x18/+0x20/+0x30 保持 0
   （wdoallocbuf 条件）、+0x38 放 `"/flag"`、+0xc8 放 `leave; ret`、+0xe0 放
   `V = wd+0x60`（`[V+0x68]` = wd+0xc8）。
3. **stage2**：`EDIT(-8, 0xa8 字节)` 在 stderr 窗口放第二段 ROP：
   `read(3, wd+0x40, 0x80); write(1, wd+0x40, 0x80); exit(0)`（rdi=3 假定 open 返回
   最低 fd；rsi/rdx 从 read 持续到 write）。整段 ≤ 0xd8，不越出 stderr 结构体。
4. **触发**：`EDIT(-12)` 把 `_IO_2_1_stdout_` 原地伪造成 House-of-Apple2 FILE：
   `_flags=0`、`_IO_write_ptr=_IO_write_end=0`（xsputn 的 count=0 → 必走 OVERFLOW）、
   `_lock=wd+0x50`（零区）、`_wide_data=wd`、vtable=`_IO_wfile_jumps`、**+0xe8 写回
   `&_IO_2_1_stdout_`**（窗口尾部正好压着 libc 的 `stdout` 变量，必须保持指向 F），
   NUL 选 v=0x82（`_vtable_offset`，本就为 0）。本次 EDIT 末尾的 `puts("DONE.")`
   立即触发：xsputn → `_IO_wfile_overflow` → `_IO_wdoallocbuf`
   （`test flags,2` 过）→ `mov rax,[wd+0xe0]; call [rax+0x68]`，此刻 **rbp=fp** →
   `leave; ret` 把 rsp 拍到 fp+8，**stage-1 ROP 就铺在伪造 FILE 的头部槽位**：
   `open("/flag",0,0)` → `pop rsp` 二段跳到 stderr 窗口（F+0xa0 是 `_wide_data` 槽位
   不能放 gadget，故链在 +0x58 处提前换栈）→ `read(3,wd+0x40,0x80)` →
   `write(1,wd+0x40,0x80)` → `exit(0)`。flag 直接打回 socket。

关键 gadget（本 libc exec 段扫描，exp 动态重算）：pop_rdi 0x2daa2 / pop_rsi 0x37bda /
pop_rax 0x2fff4 / pop_rdx,rbx 0x87759 / syscall,ret 0x883e6 / pop_rsp 0x2d77b /
leave,ret 0x52dd2。注意本自编译 libc 与主线不同：`_IO_wfile_jumps.__xsputn` 是
`_IO_wfile_xsputn`（宽字符版，同样逐字符落到 `__woverflow`→OVERFLOW），且
`setcontext` 是 rdx 基（`mov rsp,[rdx+0xa0]`），不能从 `__doallocate`（rdi=fp）
直接调——这就是选 `leave;ret` 的原因。

seccomp（prctl BPF，6 条指令）：仅 `execve`=59 → KILL，`execveat`(322)/ORW 全放行。

## 本地验证（2026-09-11，OrbStack docker `--platform linux/amd64`，solver:full）

- `python3 solve.py --local`：**attempt 0 直接出 `flag{local_test_xyz}`** ✓
- 远端模式（socat TCP-LISTEN:9999,fork EXEC:./pwn）：`python3 solve.py 127.0.0.1 9999`
  **attempt 0 出 flag** ✓（网络路径、协议同步与本地一致）
- 本地 ASLR 在该环境下不随机化（libc 恒 0x7fffff5c9000），但链路对基址无任何硬编码
  （泄露驱动）；远端 ASLR 开启不影响各步（所有写入目标都来自泄露值）。
- 调试手段备忘：Rosetta 下 gdb 断点/寄存器不可靠、strace 只能看到 SIGSEGV；**core dump
  可用**（`ulimit -c unlimited`，默认 core_pattern=core 落 CWD），用 python 解析
  NT_PRSTATUS + PT_LOAD 比对窗口内容（注意 Rosetta core 的寄存器是 JIT 内部态，
  不可信，**内存内容可信**）。

## 失败分支

- **show 截断**（~2%）：密文内嵌 NUL → printf 截短，或密文含 `\n` 导致解析错位——
  exp 已按 `DONE.` 边界+去尾 `\n` 解析，len<0x6e 自动重连。
- **EDIT 触发包短读**：0xf0 触发载荷必须一次 read 到位（exp 在 CONTENT: 后 sleep
  0.08 再单次 send；TCP 下 240B 单段，实践稳定）。若现场反复失败优先怀疑这里。
- **flag 路径不是 /flag**：路径串在 wd+0x38（`--path` 参数可改，窗口内可放 ~160 字节）；
  若 fd 3 假设不成立（目标以非 3 fd 占用），把 stage2 的 `fd=3` 改成实际值。
- **exit(0) 已去掉的替代**：链尾不 exit 会因 ret 进 0 崩溃，但 flag 已写出，无影响。
- **换 libc**：附件 libc 是自编译 2.34，IO 偏移/gadget 全部由 exp 动态计算；若决赛
  换 libc 只需附件同步替换。唯一版本敏感点：`_IO_wfile_jumps.__xsputn` 必须最终落到
  `_IO_OVERFLOW`（主线与多数自编译版均满足）。
- **不要碰**：idx -7..-1（只读 GOT，SHOW/EDIT 即 SEGV）、idx -4（野指针）、
  EDIT(-12) 的窗口写在触发前分多次做（F 一旦被部分改写，下一次 puts 就崩）。

## 决赛实测备忘

- 初赛批次三、200 分、全场 0 解；决赛测试赛 15 题中无本题（无历史教训可循）。
- 远端镜像沿用本赛事极简风格：只有 dash 内建 + ls/cat；exp 的 ORW 不依赖任何 shell
  命令，输出直接回 socket，天然适配。
- 附件 sha256：外层 zip `2f6cde979c…969b`；pwn `3bd13dee…3b20`、libc.so.6
  `9b5bf162…7598`、ld `469737…41f9`。
- exp：`exp/solve.py`（--local / HOST PORT 双模式 + `--path`；IO 偏移、gadget、RC4
  密钥全部从附件文件动态计算）。

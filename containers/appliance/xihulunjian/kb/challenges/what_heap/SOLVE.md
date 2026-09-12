# what_heap（初赛 PWN-01 · Pwn · 200 分 · 需现场靶机）

glibc 2.27 堆题，隐藏菜单 + 有符号检查绕过。**决赛测试赛已实证全链**（4 次尝试、
147 分钟）：核心利用链由 agent 085e4870 本地开发，agent 4ce114c9 复用并换多线程
驱动远端暴力 brk-ASLR 命中后拿 root shell。本 KB 的 exp/solve.py 与实证链字节兼容
（偏移改为从附件 libc 动态计算）。整链拿 shell 实证于远端靶机；本地复现受运行时
限制（见「本地验证」——OrbStack/Rosetta 下三种 2.27 运行姿势均止步于魔法写）。

## 现场流程

```bash
cd /tmp && mkdir what_heap && cd what_heap
unzip -o -q '<what_heap的附件.zip>'
# 内层 zip 目录名是 GBK 编码，macOS unzip 直接报错；用 python 拍平解出 what_heap + libc.so.6:
python3 - <<'PY'
import zipfile, os
z = zipfile.ZipFile('tempdir/PWN附件/题目附件.zip')
for i in z.infolist():
    open(os.path.basename(i.filename.encode('cp437').decode('gbk')), 'wb').write(z.read(i))
PY
chmod +x what_heap

E=/opt/solver/knowledges/xihulunjian/challenges/what_heap/exp
python3 $E/solve.py HOST PORT 32 3600    # 决赛靶机：brk-ASLR 暴力，32 线程，命中自动出 flag
```

本地冒烟（2026-09-11 实测，OrbStack docker `--platform linux/amd64`；只验证链条
机制，**整链拿 shell 需原生 Linux，OrbStack 下三种姿势均不可达**，见下节）：

```bash
# glibc 2.27 运行环境：ld-2.27.so 取自 launchpad deb（sha256 da5e0c51…80fdcb），
# libc.so.6 直接用附件自带那份
curl -sL -o libc27.deb 'http://launchpad.net/ubuntu/+archive/primary/+files/libc6_2.27-3ubuntu1.6_amd64.deb'
mkdir deb && cd deb && ar x ../libc27.deb && tar -xf data.tar.* ./lib/x86_64-linux-gnu/ld-2.27.so && cd ..
# **不要用 patchelf**（Rosetta 的 ELF mapper 对改过 interpreter 的 ET_EXEC 直接崩，
# 见失败分支），用 ld 直启 wrapper：
printf '#!/bin/sh\nexec "$PWD"/deb/lib/x86_64-linux-gnu/ld-2.27.so --library-path "$PWD" "$PWD"/what_heap\n' > wh_local
chmod +x wh_local
python3 $E/solve.py --local ./wh_local
```

远端预期输出（测试赛实证形态）：

```
*** HIT wid=N base=0x603000 attempt=... ***
leak=0x7f...e090 libc=0x7f... free_hook=0x7f... system=0x7f...
SHELL OK -> hit_<ts>.bin
FLAG FOUND: DASCTF{...}      # 也在 FLAG.txt / hit_<ts>.bin
[+] SUBMIT THIS : <{}内原始内容>
```

flag 实证位置：环境变量 `FLAG`/`DASFLAG`（`set` 可见）与 `/flag` 各一份；
按平台规则只提交 `{}` 内原始内容。远端镜像极简（仅 dash 内建 + ls + cat，
无 id/env/tr/find/grep，/proc 未挂载），exp 的 shell 命令清单已按此裁剪。

## 本地验证（2026-09-11，OrbStack docker 实测）

链条的线性写窗口只有 `[0x602190, 0x6036b0)`（魔法 read 起点固定 .bss 尾、payload
长 0x1520），**堆必须落在窗内（唯一满足页 = 0x603000）整链才成立**。三种 2.27
运行姿势实测：

- **ld 直启**（`ld-2.27.so --library-path . ./what_heap`，上一节 wrapper）：prologue
  正常（K_LEAK=0x3ec090 / system=0x4f420 / __free_hook=0x3ed8e8 全对，泄露
  0x555555555370）。堆基 0x555555554000——ld 被 exec 成 main，brk 跟随 **ld.so** 的
  bss（Rosetta 恒落 ET_DYN_BASE，与 randomize_va_space=2 无关），/proc/maps 实证
  目标 .bss 页 0x602000-0x603000 之后没有 heap。窗口罩不住堆 → exp 带诊断退出
  （替代旧版误导性的 "ASLR off / setarch -R?" 提示）。强行越过诊断：magic1 写不
  生效（真实内核 partial-copy 只落进 .bss 尾页就 EFAULT），链死在 libc 泄露校验。
  **结论：ld 直启只能冒烟 prologue/泄露机制，整链数学上不可达。**
- **qemu-x86_64 -L <prefix>**：布局反而正确——qemu 把 guest brk 放在 .bss 尾，
  泄露 heap=0x603000，exp 判定命中并以真实堆基驱动整链；但魔法 `read(0, 0x602190,
  0xFFFFFFFF)` 被 qemu-user **整段缓冲预校验** EFAULT（C 探针实测：native 内核
  partial-copy 返回 16 且数据落盘；qemu 返回 -1 且一字节不写、不从 stdin 消费）→
  payload 滞留 stdin，菜单 scanf 吃 NUL 死循环，链死在 magic1 后。**整链同样不可达。**
  注意 qemu 必须跑容器 fs 里的副本：OrbStack virtiofs 挂载上的 ET_EXEC 直接报
  "Error while loading: Exec format error"（ET_DYN 不受影响）；-L prefix 要同时备好
  `lib64/ld-linux-x86-64.so.2` 与 `usr/lib/x86_64-linux-gnu/libc.so.6`（glibc 默认
  搜索路径逐条前缀重定向）。
- **patchelf**：改 interpreter 后执行即崩，OrbStack/Rosetta 的 ElfMapper 断言
  `first load segment does not span the elf header size`（ElfMapper.cpp:401）——
  Rosetta ELF 加载器 bug，与 patchelf 版本、文件在 virtiofs 还是容器 fs 均无关。

`--local` 的达标线（prologue 泄露 → 真实堆基传递给 payload 构造 → 可达性判定）
已在 ld 直启与 qemu 两种姿势实测通过；**真正的本地整链拿 shell 需要原生 Linux**
（真实 partial-copy 语义 + patchelf 后堆恰在 0x603000），即测试赛 agent 的复现环境。

## 原理（备查，关键偏移）

二进制（逆向核实）：non-PIE 0x400000、Partial RELRO、Canary、NX、stripped，
buildid `7a09f737…`；附件 libc = Ubuntu GLIBC 2.27-3ubuntu1.6（buildid `f7307432…`）。

菜单 1 add / 2 edit / 3 delete / 4 show / 6 exit，跳转表另藏 **5 = "?"**：

- add@0x40097b：ptrs[16]@0x602100 找空槽，size 存 sizes@0x6020c0，校验
  `0<=size<=0x100`（有符号），malloc。**不读内容**（打印 "input >>" 纯摆设）。
- edit@0x400b3e：`read(0, ptrs[i], sizes[i])`，长度==分配，无溢出。
- delete@0x400a9b：free + 置 NULL，无 UAF/双 free。
- show@0x400bf2：`puts(ptrs[i])`。
- magic@0x400c60：`scanf("%d",&n)` 后 **`cmp eax,0x20; jle`（有符号）→ n<0 通过**；
  计数器@0x602180 限用 3 次；`read(0, 0x602190, (u32)n)` → n=-1 得 ~4GB 线性写，
  起点为 .bss 尾 0x602190。

堆布局：非 PIE 下 brk 紧随 .bss，brk-ASLR 偏移 R=0 时堆恰在 0x603000 ——
4GB 写覆盖**整个堆**（含 tcache_perthread_struct@0x603010，2.27 布局 64×1B counts +
64×8B entries）。R≠0 时写起点落进 gap，只写到空页，无害但无效果。
远端 ASLR 开启：R 均匀分布于 32MB/8192 页，**P(R=0)≈1/8192（实测 ~1/10700），
必须多线程撞**；Rosetta 容器实测 brk 不随机化（本地恒命中，勿据此推断远端）。

利用链（远端实证同款；本地整链复现需原生 Linux，OrbStack 下的边界见「本地验证」）：

1. prologue（8 次堆操作零写入）：add(256)×2 → 双双 free 进 tcache → add 取回 A，
   其 tcache fd=B → show0 泄 `heap+0x370`，**兼作 R=0 探测器**（0x370 页偏移特征）。
2. magic #1：清零 tcache + 伪造 A.size=0x421、B/top=0x100001、+0x670/+0x690 处
   0x21 作 free 校验的 next-size 链。
3. delete(0)：A(0x420) 入 unsorted；add(256)：unsorted→largebin→split 取回 A，
   mem 残留 largebin[64] 头指针 → show0 泄 libc。
4. magic #2：tcache counts[0]=1、entries[0]=&`__free_hook`。
5. add(8) 直接返回 `__free_hook`（idx1）→ edit(1)=system → edit(0)="/bin/sh" →
   delete(0) 触发 `system("/bin/sh")` → root shell。

libc 偏移全部从附件 libc.so.6 动态计算：`system`/`__free_hook` 取 dynsym
（0x4f420 / 0x3ed8e8）；K_LEAK = `__malloc_hook`+0x10+0x450 = **0x3ec090**
（main_arena+0x450 = largebin[64] 头，本地实测 leak−libc 严格吻合）。

scanf 细节（坑）：无缓冲 stdin 下 scanf 逐字节 read(1)，前导空格被消耗不进缓冲 →
用 3000 空格把裸 read() 推迟到整个 payload 进 socket（防 TCP 短读）；数字 token
（`-`+300 个 `0`+`1`）必须 <1024 字符，否则 scanf 内部 malloc(2048)+realloc(4096)
在被破坏的堆上直接 `realloc(): invalid next size` 崩溃。

## 失败分支

- **本地验证姿势选错（OrbStack/Rosetta 专属坑）**：patchelf 改 interpreter 后执行即崩
  （Rosetta ElfMapper 断言，见「本地验证」），应改用 ld 直启 wrapper；但 ld 直启下
  brk 跟随 ld.so（堆落 0x555555554000），线性写罩不住堆，只能冒烟泄露不能跑整链；
  qemu 布局对但对 4GB read 整段校验 EFAULT，同样跑不动整链。本地整链 = 原生 Linux。
- **R≠0 是常态**（测试赛教训）：远端堆不与 bss 相接时链条必然无效，唯一出路是
  多连接暴力 R=0。测试赛数据：16/32 线程、~60 conn/s，胜者在中奖前累计 ~1/10700
  次连接（自家 923 次/16s 命中是运气好）。3600s 内不出可加倍线程或延 tmax。
- **n 填 -1 以外的大负数**或超长 scanf token → realloc abort / 半截写，按 exp 现值来。
- **magic 只能用 3 次**（计数器 0x602180 >2 即 exit），链条恰好用 2 次，无余量试错。
- **leak 被 NUL 截断**（libc 基址 byte1==0，~1/256）：puts 停在内嵌 NUL，exp 判
  len<6 弃权换下一连接，不要在原连接上重试（堆状态已破坏）。
- **决赛换 libc**（附件 sha256 变）：system/free_hook/K_LEAK 自动重算，但堆布局
  常量（0x250/0x360/0x470/0x670/0x690、prologue、两个 magic payload）是 2.27 专属
  （tcache 结构、无 PROTECT_PTR），需重推后改 exp 顶部常量。
- **靶机起不动**（测试赛第 1 个 agent 遇 "target did not become ready"）：平台侧
  自愈型故障，先本地推进 + 稍后重试 start_target，不要干等。

## 决赛实测备忘

- 初赛 200 分 Pwn 未解；决赛测试赛（2026-09-10）4 次尝试解出：前 3 个 agent
  （085e4870/4b1b2d84/b439d177）完成逆向与本地全链但远端超时，第 4 个
  （4ce114c9）直接复用频道沉淀的 exp、只重写多线程驱动，26 分钟撞出 R=0 拿 flag
  ——「成果沉淀→后来者复用」链路首次实证，KB 即为此固化。
- 测试赛 flag（动态，**勿直接提交**）：`99662910051854216523180535035538`。
- 附件 sha256：外层 zip `be0f999e…865332b`；解包后 what_heap `97cd6291…cca16e`、
  libc.so.6 `acf8ac6d…988666`；冒烟用 ld-2.27.so `da5e0c51…80fdcb`。

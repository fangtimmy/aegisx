# wish（初赛 PWN-05 · Pwn · 200 分 · dynamic flag）

**状态：未解。** 初赛全场 0 解；决赛测试赛（2026-09-10/11）9 个 agent 约 800 分钟、0 提交。
这是全场投入最大仍未解出的题，决赛大概率原题重现。
本文是攻防研究档案：逆向结论、远端校准数据、已走通原语、已证伪路线全部确定性沉淀。
决赛 agent 应从「已走通的路径」直接续写利用链，**不要重走「失败路线清单」里的任何一条**。

预算意识：本题已烧掉两个场次仍差最后一跳（把固定值写变成任意值写）。
若决赛现场 2 小时内未能基于「建议路线」跑通，考虑止损升级调度者。

## 一、已确认事实

### 程序结构（c44af6a9 完成全量逆向，KB 已复测）

- 检查项（KB 2026-09-11 docker 实测，与 transcript 一致）：
  **Partial RELRO（BIND_NOW + 无 `GNU_RELRO` 段首标志，GOT 不可改）、NX（GNU_STACK RW）、PIE、无 canary。**
  注意：`__stack_chk_fail` 不在 .dynsym 中——各 handler 分析里说的「canary 槽位」实际只是栈上普通 8 字节，**程序并没有 stack protector**。这不影响 choice7 泄露配方（泄露价值来自 stale 数据本身），但意味着 choice6 的栈溢出理论上不需要过 canary（见「卡点」）。
- 附件：`wish`（PIE, BuildID d01df57f…）+ `libc.so.6`（Ubuntu GLIBC **2.27-3ubuntu1.6**，BuildID f7307432a8b162377e77a182b6cc2e53d771ec4b）。内层 zip 解出后两个文件。
- 程序是「许愿十次」菜单：主循环固定 **10 次迭代**；全局 `wishes`（.data 0x203010，初值 10）在 1/2/3/5/6/9 号操作尾部自减、为 0 时 exit。**choice7/choice8 不消耗 wishes**（choice7 只执行 `wishes = min(wishes, 3)` 并占 1 次主循环迭代）。
- 有效预算因此是：**至多 9 个消耗型 op + 1 次 choice7 泄露**，且 choice7 之后只剩 3 个消耗型 op，必须排布成「第 10 次主循环恰好是第 3 个收尾 op」。
- money（0x2030b0，int，初值 0）：choice1 加 50/100/150（非法输入清零）；choice2 加 `rand()%600`（`srand(time(0))`）；choice9 扣 500 或 800；choice6 扣 0x1000000。

菜单功能表（prompts 为实测原文）：

| choice | 功能 | 关键行为 |
|---|---|---|
| 1 | 要钱 | money += 50/100/150 |
| 2 | 随机钱 | money += rand()%600（choice9 的钱主要靠它，≥500 概率约 91%，可重连刷） |
| 3 | 买房 | size ∈ [0x81,0x4ff]；`calloc(1,size)` 存入 `houses[0..9]`（数组 0x203060），随后 `read(0,ptr,size)` 精确读 |
| 4 | 白日梦 | 打印后 `exit(0)` |
| 5 | 弃房 | `free(houses[idx]); houses[idx]=0`，随后**附加 `calloc(1,0x20)`**（孤儿分配，会触发 unsorted-bin 处理/切分） |
| 6 | 买车 | 逐字节 read 入栈缓冲 `[rbp-0x140]`，字节数上限 ≈ `money/100`；结束后 money -= 0x1000000 |
| 7 | 问世界 | 3 次 `read(0,[rbp-0x60],0x60)`，前 2 次后各 `puts(buf)`；结束打印 "Now you have the last two wishes" 并把 wishes 钳到 3 |
| 8 | 放弃 | 打印碎片串（"tw un"/"s0n"/"re"/"ck"/"0"/"at"/"bin t"/"t l"，即 **"two snoreck0atbin tt l"** 类乱序——多 agent 判读为提示 **t w u n s 0 n r e c k 0 a t b i n t** → **unsorted bin attack** 的字符串碎片），`exit(0)` |
| 9 | 装修 | 选 idx（0..10）与 500/800 两档；需 `money > 档位-1`；`read(0, houses[idx], 500或800)` —— **堆溢出** |

`houses[10]` 越界别名 money 全局（choice5/choice9 的 idx 上界是 10 而非 9）：choice5(10) = `free((void*)(int64)money)`（money 为小整数必然崩）；choice9(10) = 往 `(void*)(int64)money` 读 500 字节（money 是 32 位值，当不了合法地址；把 money 做大后等于往固定小地址写→段错误）。

### 漏洞三元组

1. **choice9 堆溢出**：house 最小 0x81（chunk 0x90，usable 0x88），choice9 却往里读 **500 或 800 字节**。0x81 house + 500 档溢出 364 字节，可完整覆盖后续多个 chunk 的 size/fd/bk。溢出源 chunk 必须还在 `houses[]`（choice5 会把指针清零）。
2. **choice7 stale 栈泄露**：`read(0,buf,0x60)` 是**短读语义**——只送 N 字节，`buf[N..0x60)` 保留前一个栈帧的陈旧数据，随后 `puts(buf)` 无 NUL 终止一路打印。配方（远端已验证）：
   - 第 1 读送 `'A'*0x18` → print1 尾部 6 字节 = `libc+0x8d3b3`（**`_IO_file_overflow+0x103`**，函数头 0x8d2b0；早期 agent 误标为 `__libc_start_main+231`，**不要减 0x21c87**）
   - 第 2 读送 `'B'*0x28` → print2 尾部 6 字节 = `libc+0x3ec760`（`_IO_2_1_stdout_`）
   - 第 2 读送 `'B'*0x38` → 尾部 6 字节 = `libc+0x80b12`（`puts+0x1a2`）
   - 另有 slot+0x30 = `PIE+0x1c20`、slot+0x40 = `buf+0x60`（栈地址，buf = leak−0x60）
   - **libc base = slot18 − 0x8d3b3**，双槽指纹 `DELTA(slot28−slot18) = 0x35f3ad`（页内偏移 0x3b3/0x760 亦可当指纹）
3. **libc 2.27 有 hooks**：`__free_hook`/`__malloc_hook`/`global_max_fast` 全在，且 2.27 无 tcache key/double-free 检查、unsorted 循环无 `bck->fd != victim` 检查（该检查 2.29 才引入）——这是 BREAKTHROUGH 原语的前提。

### libc 偏移表（相对 base；KB 用 readelf 对附件逐一复核通过）

| 符号 | 偏移 |
|---|---|
| system | 0x4f420 |
| "/bin/sh" | 0x1b3d88 |
| __free_hook | 0x3ed8e8 |
| __malloc_hook | 0x3ebc30 |
| _IO_2_1_stdout_ | 0x3ec760 |
| _IO_list_all | 0x3ec660 |
| global_max_fast | 0x3ed940 |
| setcontext | 0x52050 |
| __libc_start_main | 0x21ba0（+231=0x21c87，**不是**泄露点偏移） |
| unsorted bin head（= main_arena+0x60） | 0x3ebca0 |
| one_gadget（KB 实测 one_gadget 工具输出） | 0x4f302 / 0xe5388 / 0xe5502 / 0x10a2fc |

### 远端校准（ad446f53 出证、05e80b81 独立复测）

- 测试赛远端 `1.14.76.59:22658` 的 libc **== 附件 libc == 2.27-3ubuntu1.6**：三条独立证据（slot18 页内 0x3b3、slot28=0x3ec760 精确匹配、同进程 DELTA=0x35f3ad），PIE 槽 low12=0xc20 证明远端二进制也与附件一致。决赛若复现环境，**泄露后直接套上表偏移**；仍建议先跑 `leak7.py` 验指纹（1 次连接、不消耗 wishes）。
- 提交规则（平台级）：只提交 `{}` 内裸值，大小写敏感，每题 50 次预算。

### 本地运行（KB 2026-09-11 实测通过）

附件不带 ld；用 Ubuntu 18.04 的 `libc6_2.27-3ubuntu1.6_amd64.deb` 解出配套 `ld-2.27.so` 后：

```sh
python3 - <<'EOF'  # process(['./ld-2.27.so','./wish'], env={'LD_LIBRARY_PATH':'.'})
EOF
```

完整 docker 复测命令见文末。菜单九项、choice7 三槽泄露、DELTA 指纹、页对齐 base 全部按 transcript 复现成功（容器无 ASLR 时 libc base 固定 0x7ffffefde000）。

## 二、已走通的路径

### A. choice7 一次连接三泄露（libc + PIE + stack）

见上文配方；封装在 `exp/wlib.py::leak_libc`，校准脚本 `exp/leak7.py`。**不消耗 wishes，随时可插**。

### B. BREAKTHROUGH：clean unsorted-bin attack 原语（1770c5f4，本地实验确证）

**效果：把固定值 `libc+0x3ebca0`（unsorted head）写到任意地址 T，进程不崩、可继续用。**

原理：2.27 `_int_malloc` unsorted 循环的 **exact-fit 分支**先执行 `bck->fd = unsorted_chunks(av)`（即 `*(bk+0x10) = libc+0x3ebca0`）然后**立即 return**（汇编 `0x94629/0x9462d → je 0x948d0`），跳过了循环继续前对 victim->size 的合法性检查——所以伪造 bk 不会触发 `malloc(): unsorted double linked list corrupted` abort。

操作序列（编号=消耗型 op 序号，可在 10 次主循环内排下）：

1. money：choice2 刷 rand()%600 ≥ 500（choice9 的 500 档要求 money>499）。
2. `choice3(0x88)` → A @ house0（forge 源）。
3. `choice3(0x4f8)` → B @ house1（0x500 大 chunk）。
4. `choice3(0x88)` → C @ house2（guard，防 R 与 top 合并）。
5. `choice5(house1)`：free(B)。程序附加的 `calloc(1,0x20)`（0x30 chunk）从 B 头部切走，**余量 R(0x4d0) 留在 unsorted bin，且 last_remainder=R**（ht3 实验确证）。此刻堆布局：`A_chunk | orphan(0x30) | R(0x4d0) | C`，R chunk 头 = A_user+0xa8。
6. （可放 leak 前或后）`choice9(house0, 500, payload)`：payload = `'A'*0xa8 + p64(prev_size) + p64(0x4d1) + p64(fd) + p64(T-0x10)`——即伪写 R 的 size（0x4d1|PREV_INUSE，必须是合法值防其它检查）与 **bk = T−0x10**。
7. `choice3(0x4c0)`（nb=0x4d0，与伪造 size 精确相等）：calloc 走 unsorted 循环，victim=R，exact-fit 写 `*T = libc+0x3ebca0` 并返回 R+0x10。**实测 houses[9] 被写成 0x7fffff3c9ca0 = libc+0x3ebca0，进程存活。**

### C. 关键负面事实（同样「已走通」地证伪，多 agent 重复验证）

- **calloc 绕过 tcache**（1770c5f4 两次实验 + 9203a91b 源码确认）：2.27 的 tcache fast path 在 `__libc_malloc`，而 `__libc_calloc` 直连 `_int_malloc`。free 进 tcache 的 chunk 取不回。
- **GOT 全 RELRO**，覆盖 GOT 不可行。
- `__free_hook` 附近 0x3ed300–0x3ed8e8 全 0，伪造不出合法 size 过 fastbin/小 bin 检查。
- top-chunk 借位写 `av->top` 到 `__free_hook-8` 需同时改 `av->top` 与 `system_mem`（相距 0x828），单次 500/800 溢出覆盖不到。

## 三、卡点（测试赛终局 4 个 agent 的具体停滞处）

- **1770c5f4**（BREAKTHROUGH 作者，后被 2h 超时 park、resume 后继续）：clean unsorted 原语到手后，卡在「写值是常数 `libc+0x3ebca0`，不是 system」。转向 largebin attack（可写 heap 指针→完全可控 fake FILE→exit FSOP→one_gadget），终局仍困在：**触发写需要先有一个 ≥0x400 的 chunk 进 largebin（bin 须非空才不自插）、还要一个 post-leak 可 free 的 victim，两者连同 forge/alloc 全塞不进 3 个收尾 op**；终局还在用 trap-patch libc 验证 split/park 路径的汇编行为。
- **9203a91b**：沿「固定值写扫目标」路线，扫描 libc 可写区找「值为 0x3ebca0 时即等于跳转/hook 生效」的落点；逐一否掉 `_IO_list_all`（main_arena+0x60 当 FILE 时 `_mode` 等字段过不了 flush 检查）、stdout vtable（`_IO_vtable_check` 拦截）、`__printf_function_table`（house of husk，写值非空表导致规格化越界）；终局在跑 libc 全量 T 候选扫描，未出结果。
- **9b23b492 / cba26221**：并行推进 largebin→FSOP 全链设计（fake FILE 字段、`_wide_data`、vtable 合法性、setcontext+53 / one_gadget 0x4f302 的约束核对），卡点同样是 **op 预算排布**——5 个堆块 + 2 次 free + 2 次 overflow + money 共 11+ op，比 10 次主循环多 1，反复尝试用 top 前向合并、guard 复用等技巧省 op，均未闭合；同时大量时间耗在 2.27 largebin 插入两个写原语（`*(E->bk+0x10)=V`、`*(E->bk_nextsize+0x20)=V`）与 `_IO_wfile_overflow` 调用链的约束核对上。
- **b7e7d4f6**：终局仍在用 ud2-patch libc 逐指令定位 split 路径行为（确认 choice5 孤儿 calloc 的 split 会设置 last_remainder、Gprev 值等），为 largebin 链路铺路，未到 exploit。

共同结论：**情报（泄露、原语、偏移、行为）已齐，缺一个「任意值写」或「省 op 的触发器」把链闭合。**

## 四、建议路线

综合全部 transcript，决赛 agent 应按以下优先级推进。每步都标注证据来源。

### 路线 1（首选）：unsorted 固定值写 `global_max_fast` → fastbin 越界 → `__free_hook=system`

这是 BREAKTHROUGH 之后 1770c5f4 自己给出的 next step（L44777："global_max_fast(libc+0x3ed940) 用 unsorted attack 覆写为巨大值 → 解锁 fastbin 路径 + tcache stash"），且 cba26221 L13163 有更具体的机制分析，但**两个会话都停在提出、没做实验**——这是全场留下的最大空白，也是决赛的首要工作。

1. 泄露：choice7（配方见上）→ libc/PIE/stack base。（ad446f53 权威）
2. 原语：按「已走通 B」7 步，把 `*global_max_fast` 写成 `libc+0x3ebca0`（一个远大于任何 chunk size 的值）。（1770c5f4 已验证写任意 T 不崩）
3. `global_max_fast` 巨大后，`free(chunk)` 对**任意 size** 都走 fastbin 路径：`fastbin_index(size)=size>>4-2` 越过 10 项数组，`*fb = victim->fd` 类写落在 `fastbinsY` 之后的 `top/last_remainder/bins[]` 区——可把 **`av->top` 改写成 heap 指针**（cba26221 L13163 的推演）。后续：伪造 top 指向 `__free_hook-0x10` 附近 → choice3 返回 `__free_hook` → `read` 写 `system`（choice3 的 read 本身就是任意写落点，1770c5f4 早期已确立这一点）。
4. 触发：某 house 内放 `"/bin/sh"`，choice5 free 它 → `system("/bin/sh")`。注意 choice5 free 前会先调用 hook，参数 rdi = houses[idx]（house 指针，故 house 内容须以 "/bin/sh" 开头）。触发源也可用 libc 常量 `libc+0x1b3d88`（free(该地址) 不可行——choice5 只 free house；故用 house 存串）。
5. 风险：fastbin 越界写的副作用（free 时 `chunksize(victim->fd)` 检查等）需要本地 trap-patch 实验先行验证——b7e7d4f6 的 ud2-patch 方法（L35331）可直接复用。

### 路线 2（并行验证）：largebin attack 写 heap 指针 → `_IO_list_all` → exit FSOP

- 机制：2.27 largebin 排序插入对已存在的 chunk E 使用 `*(E->bk+0x10)=V` 与 `*(E->bk_nextsize+0x20)=V`，**V 是新插入 chunk 的地址（heap 指针）**；若 E 的字段被 choice9 forge、V 的 payload 又是 choice3 写入的 fake FILE，则 `_IO_list_all = V` → 主循环耗尽 `exit → _IO_flush_all_lockp` → `__overflow`（9b23b492/cba26221 已核对 `_IO_wfile_overflow` → `_IO_wdoallocbuf` → `call *(wide_vtable+0x68)` 调用链，宽字符分支可绕 `_IO_vtable_check`——vtable 指向 heap 的合法性在 2.27 需实测）。
- 终端跳转：fake FILE 里放 `setcontext+53`（0x52050+0x35，`mov rsp,[rdi+0xa0]` 系列已由 cba26221 反汇编核对）或 one_gadget 0x4f302（`[rsp+0x40]==NULL` 约束）。
- **核心未解算题（直接继承，勿重推）**：预算。需要 E（先入 largebin、bin 非空才不自插）+ V（post-leak 可 free 且 payload 可写）+ forge + 触发 free + money，>10 op。9b23b492 终局探索的两个省 op 方向：V 的前向邻居做成 free chunk 让 free(V) 合并后 size 仍落同一 bin index（可省 guard 分配）；choice5 自带孤儿 calloc(0x20) 复用为 bin 成员。**决赛先把这两个方向各做一次实验，再决定是否放弃。**

### 路线 3（快速验证，半天内可证真/证伪）：choice6 栈溢出 + ROP

KB 复测新事实：**二进制无 canary**。这使早期被放弃的 choice6 路线重新成立：

1. 需要把 money 抬到 ≈ `(0x148+ROP长度)*100` ≈ 5–7 万。money 是 int，choice2 每次最多 +599，10 次迭代内靠 choice2 不可达（老结论，成立）。**但**：choice6 结束 `money -= 0x1000000`——money 变大负数后，后续 choice6 的读上限比较是 `counter < money`（有符号比较）直接不读；choice5/choice9 的 `money>499` 检查也失败。要看汇编确认负数是否真的锁死（01ea837d 尾部正在推这条路："manipulate money via OOB → huge money → option6 overflow → ROP"，未完成）。
2. money 抬升候选：`houses[10]` 别名——choice5 free(10) 崩、choice9(10) 需 money 已是指针；装满 10 个 house 后第 11 次 choice3 会把堆指针写进 `houses[10]`（=money 低 32 位 + 高 32 位），money 变成「堆地址低 32 位」的大正数（c44af6a9 L2141 发现，未深挖）。若 money 因此 ≥ 5 万，choice6 立即可溢出：0x148 padding + ROP（libc 已知：`pop rdi; ret` + `/bin/sh` + system）。**11 次 choice3 也超预算（10 次主循环），需结合 choice7 不占 wishes 的特性精算迭代次数**——10 次迭代里 3 次 choice3 后 house 未满，此路大概率仍不通，但半天即可定论。

### 决赛执行顺序建议

1. 起 target，跑 `exp/leak7.py` 验远端 libc 指纹（1 连接）。
2. 本地（附件 + ld-2.27.so）搭好复现环境，复跑「已走通 B」确认原语仍成立。
3. 主攻路线 1：先 trap-patch 实验验证 fastbin 越界写的落点与检查，再串全链。
4. 路线 2 的两个省 op 实验作为备选；路线 3 只花半天做定论性验证。
5. 任何一步得到 shell：`cat /flag*`，按平台规则提交裸值。

## 五、失败路线清单（已被证伪，勿重走）

| # | 路线 | 证伪原因 | 证据 |
|---|---|---|---|
| 1 | tcache poisoning → `__free_hook` | **calloc 绕过 tcache**，free 进 tcache 的 chunk 永远取不回 | 1770c5f4 两次实验 + 9203a91b 源码确认（tcache fast path 只在 `__libc_malloc`） |
| 2 | unsorted 固定值写 `__free_hook`/`__malloc_hook` | 写值固定 `libc+0x3ebca0`（数据地址），不是 system/one_gadget；one_gadget 全在 .text（0x4f302 等），距离不可达 | 1770c5f4/9203a91b 反复核算 |
| 3 | unsorted 固定值写 `_IO_list_all`（House of Orange 变体） | `_IO_list_all = main_arena+0x60` 当 FILE：`_mode` 等字段读出非零大数，过不了 flush 检查 | 9203a91b L26340 区段 |
| 4 | 覆盖 stdout vtable | 写值非 `__libc_IO_vtables` 区内地址，`_IO_vtable_check` fatal | 9203a91b |
| 5 | house of husk（`__printf_function_table`） | 固定值写入后 arginfo 表非空越界，不可控 | 9203a91b |
| 6 | House of Force | choice3 尺寸上限 0x4ff，无法做把 top 推到目标的巨量分配 | 9203a91b L2530 |
| 7 | 伪造 chunk size 直接 free 进 unsorted 取 libc 泄露 | **没有任何读堆内容的输出原语**（choice3/9 只写，choice5 只 free）；唯一泄露是 choice7 栈 | c44af6a9 |
| 8 | choice6 栈溢出（旧版结论） | 当时认为 canary 挡路 + money 上限 ~6000 不足 0x148*100 ≈ 52000 | c44af6a9 L2103；**注意 canary 部分已被 KB 复测推翻**（见路线 3，只剩 money 问题） |
| 9 | unsorted fd 部分覆写（2 字节）指向 `__free_hook`/`__malloc_hook` | unsorted 分配不走 fd 取块（exact-fit 返回 victim 本身），部分覆写 fd 无分配效果；bk 只能写固定值 | c44af6a9 L5018-5227 长推演 |
| 10 | choice9 idx=10（money 当指针）任意写 | money 是 int，做不成合法可写地址 | c44af6a9 L1609/4396 |
| 11 | exit 时自动 free stdout 缓冲触发 `__free_hook` | `setvbuf(_IONBF)` 下 `_IO_buf_base` 指向 FILE 内 `_shortbuf` 或 NULL，无堆缓冲可 free | c44af6a9 L4643-5182 |

## 附：本地复现命令（KB 2026-09-11 全部跑通）

```sh
# 附件解包（双层 zip）：wish + libc.so.6；另从 Ubuntu 18.04 libc6_2.27-3ubuntu1.6_amd64.deb
# 解出配套 ld-2.27.so 放同目录，然后：
docker run --rm --platform linux/amd64 -v "<附件目录>":/w -w /w aegisx/solver:full \
  bash -c "chmod +x wish libc.so.6 ld-2.27.so; python3 <KB>/wish/exp/verify_local.py"
# 期望输出：slot+0x18 low12=0x3b3, slot+0x28 low12=0x760, DELTA=0x35f3ad,
#          base 页对齐（no-ASLR 容器内为 0x7ffffefde000）—— 与远端校准数据一致。
# 偏移复核：python3 <KB>/wish/exp/verify_libc_offsets.py（readelf 对附件 libc 逐符号核对）
```

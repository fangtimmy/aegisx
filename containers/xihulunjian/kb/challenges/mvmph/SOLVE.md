# mvmph（初赛 PWN-02 · Pwn · 300 分 · 需现场靶机）

VM 字节码解释器逃逸。**动态靶机题：flag 在决赛实例上，按本流程现场打。**
根因：宿主调用后的错误回写只覆盖 `r0` 低 32 位（32 位写不碰高位），与 `r6`（真堆指针）
的高 32 位拼出完整 `&vm->r0` → 宿主 read/write 任意地址 → 泄漏 PIE/libc/栈 →
覆盖自身 saved RIP 进 ROP。

## 现场流程

```bash
cd /tmp && mkdir mvmph && cd mvmph
unzip -o -q '<mvmph的附件.zip>' && unzip -o -q tempdir/PWN附件/change.zip
cd change && chmod +x vvmm
E=/opt/solver/knowledges/xihulunjian/challenges/mvmph/exp
python3 $E/solve.py --local ./vvmm   # 可选冒烟：验证 PIE/puts 泄漏阶段（见下注意）
python3 $E/solve.py HOST PORT        # 决赛靶机地址
```

exp 全自动：泄漏 → 定位 saved RIP → 覆盖 → `system("/bin/sh")` → `cat /flag*`。
预期输出（初赛远端实证）：

```
[+] PIE base  = 0x5586797e9000
[+] libc base = 0x7fdd06be1000
[+] environ   = 0x7fffdd4dc5f8
[+] return slot = 0x7fffdd4dc458
DASCTF{...}
```

flag 从靶机 `/flag*` 读出，按实际内容提交（裸值优先）。

## 原理（备查，关键偏移）

- VM：`first_byte = (op<<2)|mode`；op 0x03=mov 0x0a=add 0x0b=sub 0x33=host_call；
  host_call 0/1 = read/write(r0,r1,r2) 直接用 VM 寄存器作**宿主指针**（mode 0 版）。
- 拼指针：`mov r0,r6; host_call 99`（无效号，无副作用）→ `r0 = r6.high32 | (&r0).low32`
  （PIE 与 brk 堆同处 0x55xx 高 32 位）→ `mov r4,r0` 永久保存。
- 泄漏：write(1, r4-0x10, 0x60) 拿 vm.code → PIE = code−0x50e0；
  write(1, r4−0x108, 8) 拿 puts@GOT（PIE+0x4f88，提示已 puts 过必已解析）→ libc。
- 栈定位：read(0, &r3=r4+0x18, 8) 可交互喂地址；environ→栈；0x4000 窗口内用
  **三段特征** `[PIE+0x195b, +0x30: PIE+0x2bc3, +0x60: PIE+0x2d8f]` 唯一确定当前
  dispatcher 帧 saved RIP（泄漏与覆盖走同一 handler，调用深度相同）。
- 终局：read(0, saved_rip, 40) 覆盖为 `ret; pop rdi; "/bin/sh"; system; exit`，
  同包尾随 `cat /flag*; exit` 作 shell stdin。

## 失败分支

- `--local` 冒烟：容器 glibc(2.42) ≠ 附件 2.35，environ 阶段之后必失败属正常，
  冒烟只看 PIE/libc 两行泄漏是否出现；全链验证以远端为准。
- 三段特征匹配 0/多候选：栈窗口没盖住当前帧——把 STACK_WINDOW 调大（0x6000）重跑。
- 远端打不通先检查：banner 是否仍是 `Please input your opcodes:`（换题则停），
  `pc<=0x800` 限制 exp 已满足（断言保护）。
- 若决赛换了 libc（附件 sha256 变）：exp 用附件 libc 自动重算全部偏移，无需改代码。

## 决赛实测备忘

- 初赛 300 分 Pwn（glibc 2.35，Full RELRO + NX + PIE，无 canary）。
  初赛 flag（动态，**勿直接提交**）：`67126353521039200926297497409404`。

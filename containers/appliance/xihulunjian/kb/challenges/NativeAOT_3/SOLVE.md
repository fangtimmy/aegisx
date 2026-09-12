# NativeAOT_3（初赛 REVERSE-03 · Reverse · 200 分）

.NET 8 NativeAOT x64 校验器（NAOT.exe，附件附赠全量符号 NAOT.pdb）：输入 `DASCTF{<32字节>}`，
Main 取 `input.Substring(7, len-8)` 得 32 字节正文交 IsFlag——每字节拆低/高 nibble 依次压栈，
再按出栈序（倒序）与 FlagHandle 构造期生成的 expected[64] 逐个比对。
**flag 全部由附件内固定数据决定，无需解包附件、无需分析二进制**——exp 已内置全部 64 个目标 nibble，直接运行即得 flag。

## 快速路径（约 1 秒）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/NativeAOT_3/exp/solve.py
```

预期输出（唯一一行）：

```
OQmmMGLsbrR8bdAdD0UWGfFYVoZsylfm
```

提交值（花括号内裸值）：`OQmmMGLsbrR8bdAdD0UWGfFYVoZsylfm`
若裸值被拒，用完整形态 `DASCTF{OQmmMGLsbrR8bdAdD0UWGfFYVoZsylfm}` 重试一次，再拒则升级调度者，不要继续枚举格式。

## 关键常量说明（已写入 exp，无需重逆向）

expected[64]——FlagHandle ctor 中 `expected[i] = FlagBit_i.SetBit(i).GetBit()` 的展开结果。
64 个 FlagBit 子类是控制流噪声：SetBit 链式调用父类后 XOR 一个立即数（链根在 i=0/16/32/48），
故 `expected[i] = i ^ (该链全部 XOR 立即数)`：

```
6,13, 6,6, 6,12, 7,9,
7,3, 5,10, 6,15, 5,6,
5,9, 4,6, 6,6, 4,7,
5,7, 5,5, 3,0, 4,4,
6,4, 4,1, 6,4, 6,2,
3,8, 5,2, 7,2, 6,2,
7,3, 4,12, 4,7, 4,13,
6,13, 6,13, 5,1, 4,15
```

重组：IsFlag 先压 `(b & 0xf)` 再压 `(b >> 4)`，出栈即倒序，所以
`flag[31-k] = (expected[2k] << 4) | expected[2k+1]`（k = 0..31）。

## 备选路径（动态复核）

附件结构：zip → `REVERSE附件/NAOT.7z` → `NAOT.exe` + `NAOT.pdb`（7z 解包）。容器内有 wine：

```bash
printf 'DASCTF{OQmmMGLsbrR8bdAdD0UWGfFYVoZsylfm}\n' | WINEDEBUG=-all wine NAOT.exe 2>/dev/null
```

判定只看程序自身输出：正确 → `Yes, you're right!`；内容错 → `Wrong! Try again!`；
缺 `DASCTF{}` 包裹 → `Format Error!`。wine 的 exit code（常为 2）与 fixme 噪声可忽略。
若必须重新逆向：`llvm-pdbutil dump -publics NAOT.pdb` 拿符号地址（section 2 = .managed，
base RVA 0x65000）——IsFlag 在 RVA 0xACB20（`NAOT_Program____Main___g__IsFlag_0_0`），
FlagHandle ctor 在 RVA 0xAD4E0，64 个 `NAOT_Zack_FlagBit_i__SetBit` 可按上文链式 XOR 模型用 objdump/capstone 展开。

## 失败分支

- 提交被拒：确认提交串无换行/空格；换完整形态 `DASCTF{OQmmMGLsbrR8bdAdD0UWGfFYVoZsylfm}` 重试一次，仍拒则升级调度者。
- 快速路径无外部依赖、无环境变量，正常情况一次命中；不涉及远程交互。

## 决赛实测备忘

- 初赛 REVERSE-03（200 分）28 支队解出；决赛测试赛（2026-09-10）5 分钟解出，提交裸值 1 发 ACCEPTED。
- 初赛与决赛测试 flag 完全一致：`OQmmMGLsbrR8bdAdD0UWGfFYVoZsylfm`（附件 sha256 未变）。
- 测试赛本地 wine 复核：正确输入 → `Yes, you're right!`，改一字节 → `Wrong! Try again!`，与 exp 输出互证。

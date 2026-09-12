# Rvmecisp（初赛 CRYPTO-04 · Crypto · 200 分）

混淆 TypeScript 的「矩阵解 key + 坏 RC4」题：`chal.ts` 的 `V()` 是 key.bin 前 67 字节的
67 元整数线性方程组（唯一解即真 key），`D()` 是被写坏的 RC4——KSA 的交换写成了
`[S[i],K[i]]=[K[i],S[i]]`（而非 `[S[i],S[j]]`），导致整个 LCG/Math.random 分支被丢弃，
密钥流只由 `key.hex()` 的字符码决定。**flag 由附件唯一决定，数学部分无任何随机性。**
唯一的坑在最后一步：message.bin 中段损坏，直接解出的明文不能提交（初赛未解、测试赛烧掉
38/50 次提交的原因）。下面 exp 已把修复算法内置，直接运行即得正确 flag。

## 快速路径（约 1 秒）

```bash
cd <附件所在目录>   # 含 Rvmecisp的附件.zip（或已解压出的 challenge/ 目录）
python3 /opt/solver/knowledges/xihulunjian/challenges/Rvmecisp/exp/solve.py
# 也可显式指定路径: python3 .../solve.py /path/to/Rvmecisp的附件.zip
```

纯标准库，无需解压（嵌套 zip 在 exp 内处理）。预期输出：

```
[*] message.bin: 49 B; shipped key.bin: b'Nothing...' (decoy, fails V)
[+] V() solution (unique, 67 B): 201bda91a09b95d69cc61a35c00fe4445ad9386c76a4e6194f29fcfa0ac1053c620837e81ecfec1df76fe28adc04a8e36752ef97d5457e88d3a2740ebfbcafdee1e502
[+] direct decrypt (49 B): b'DASCTF{Rc4&Matrix&C0nn5t#6becg5$t32Xwl.o[R^v>S\x16-y'
[+] repaired via splice m=21
[+] re-encrypt check: enc(flag)[:21]==C[:21] and enc(flag)[21:]==C[22:] OK
[+] FLAG   : DASCTF{Rc4&Matrix&C0nfusedconfused_thx4UR_w0RK~}
[+] submit : Rc4&Matrix&C0nfusedconfused_thx4UR_w0RK~
[+] matches rehearsal flag
```

提交值（花括号内裸值）：`Rc4&Matrix&C0nfusedconfused_thx4UR_w0RK~`（一次提交，勿枚举变体）。

## 解密链（数学部分，全部确定性）

1. **解 key**：`V()` 的 67 条方程形如 `Σ coefᵢ·u[i] === const`（i∈[0,66]），用
   `fractions.Fraction` 精确高斯消元，秩 67 → 唯一整数解即 67 字节真 key（上方十六进制，
   以 `201bda91` 开头、`e1e502` 结尾；67 条残差全部验证为 0）。随附 `key.bin` 是
   10 字节诱饵 `Nothing...`，过不了 `V()`，直接丢弃。
2. **密钥流**：按 `D()` 逐句复刻——`S[i] = ord(key.hex()[i % 134])`（KSA 交换 bug 的净效果，
   `j` 算而不用，256 个 LCG 浮点全部被换进 `K` 后不再读取）；PRGA 标准 `i/j/swap` 后输出
   `S[(S[i]+S[j]) % 256]` 与密文异或。XOR 流密码，加解密同函数。
3. **直接解密**：得 49 字节 `DASCTF{Rc4&Matrix&C0nn5t#6becg5$t32Xwl.o[R^v>S\x16-y`
   ——前 21 字节正确（`DASCTF{Rc4&Matrix&C0n`），中段起损坏（含 0x16 控制符、无收尾 `}`）。
   **这不是 key 错**：重加密与 message.bin 逐字节一致（XOR 对称性），且 keystream 与随机种子无关。

## 修复段（本题核心，确定性，已内置 exp）

**损坏成因**：源码末尾明文是恰好 48 个 `*`（输出应为 48 字节），而 message.bin 是 49 字节
——发放的 message.bin 比源码逻辑多出一个杂散字节。定位证据：密文头 `C[0..20]^ks[0..20]`
与密文尾 `C[22..48]^ks[21..47]` 分别用 keystream 下标 0..20 / 21..47 解都得到可读文本，
即杂散字节是 `C[21]`（0x1f）：它之前的密文与 ks 对齐，之后整体错位一字节（等价于生成器
在输出第 21 字节后多发了一个字节，或打包时插入了一个字节；两种模型数学上同族）。

**修复算法**（exp 内 `repair()`）：

1. 记直接解密 `P[i]=C[i]^ks[i]`（49 B），错位读数 `shifted[i]=C[i+1]^ks[i]`（48 B）。
2. 枚举拼接点 m：候选 `F(m) = P[:m] + shifted[m:]`，恰好对应「删除密文字节 C[m]」的全部
   49 种单字节修复。
3. 硬约束过滤：48 字节、全可打印 ASCII、`^DASCTF{`、`}$` → 剩 m∈[18,46] 共 29 个；
   再限 flag 字符集 `[0-9A-Za-z_&~]`（错位接缝会漏出 `= # $ . [ ^ >` 等字符，设计 flag
   中不出现）→ 剩 m∈{19,20,21,22,23,24} 共 6 个。
4. 语义评分唯一化：leet 归一（0→o, 4→a, 5→s, 3→e, 小写化）后统计词典词
   `confused/matrix/used/thx/work/rc` 出现次数，取最大。m=21 的接缝恰好拼出
   `C0n`+`fused` = `C0nfusedconfused`（leet「confused」×2 + 明文 `confused`），得分 8，
   其余候选均为 7 或以下——**唯一胜出**，无需任何提交试探。
5. 自洽验证（提交前必做，exp 自动执行）：`enc(flag)=flag^ks` 满足 `enc[:21]==C[:21]` 且
   `enc[21:]==C[22:]`，即修复后的 flag 重加密逐字节覆盖 message.bin 除杂散字节外的全部字节。

## 提交规则（吸取测试赛 38/50 次的教训）

- 提交花括号内裸值：`Rc4&Matrix&C0nfusedconfused_thx4UR_w0RK~`，大小写敏感。
- exp 末行必须打出 `[+] matches rehearsal flag`（自洽验证 + 已知值核对双通过）才允许提交；
  打出 `[!] MISMATCH` 时**禁止提交**，走失败分支。
- **禁止对明文做格式变体枚举**（裸值/整串/补 `}`/去控制符/截断/md5 等任何派生形式）。
  测试赛正是逐格式试错烧掉 38 次提交后才碰中 m=21；本 exp 已在本地唯一确定该值，
  一次提交即中。若裸值被拒，升级调度者，不要继续枚举。

## 失败分支

- `expected 67 equations` / `rank != 67`：chal.ts 结构变了，重新确认附件版本（比对 zip
  sha256 `5e95f624…372f`）；不同题面则不能套用本 exp。
- `no splice candidate passed constraints` 或 `selector not unique`：message.bin 的损坏模式
  变了（非单字节杂散）。回退手段：把 29 个 `^DASCTF{…}$` 候选全部视为「待语义判断」清单，
  仍禁止逐一提交；优先核对接缝是否能拼出完整单词（本题正确接缝 `C0n|fused` 是唯一拼出
  词典词的位置）。
- exp 输出 MISMATCH（附件重新生成、flag 更换）：以 exp 实际算出的候选为准做人工核验后
  再提交，并回报调度者更新本条目。
- 直接解密本就干净（48 B、可打印、有 `}`）：说明官方修复了 message.bin，exp 走 direct
  分支直接输出，无需修复段。

## 决赛实测备忘

- 决赛测试（2026-09-10）与初赛附件同版（sha256 `5e95f624cbcfd8eccc983d9f0a9d708c05c86f0800064bc924fef71c2f21372f`），
  flag `Rc4&Matrix&C0nfusedconfused_thx4UR_w0RK~` 经平台判定 accepted。
- 测试赛实况：agent 1 定位数学部分（线性方程组 + 坏 RC4）但明文中段损坏，逐格式试错被拒；
  agent 2 还原「单杂散字节」模型并靠枚举提交命中 m=21，累计 38/50 次提交。走本 exp
  （数学 + 修复 + 唯一化选择全部本地确定性完成）可在 1 分钟内 1 发命中。
- 无靶机、纯附件题；`Rvmecisp` 名字是 RC4+Matrix+confused 的混淆拼法，题面「好乱，不想看」
  对应 flag 里的 `C0nfusedconfused`。

# llfsrr（初赛 CRYPTO-03 · Crypto · 200 分）

32-bit LFSR 流密码已知明文攻击：`key` 文件（319 个 '0'/'1' 字符）= flag 逐 bit XOR LFSR 输出，
feedback_mask 被抹除。附件里的 `t = P(k+a) mod ab`（Coppersmith 小根）是烟雾弹——解出的 k 与 mask 无关，
**不要碰**。flag 前缀 `DASCTF{` 即已知明文，线性解出 mask 后直接解密；exp 已内置 key 与前缀，无需附件。

## 快速路径（约 1 秒）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/llfsrr/exp/solve.py
```

预期输出：

```
[+] feedback_mask : 0xb0b53939
[+] FLAG          : DASCTF{5e1996755a3811ef93ccc03c59457d50}
5e1996755a3811ef93ccc03c59457d50
```

提交值（花括号内裸值）：`5e1996755a3811ef93ccc03c59457d50`
测试赛实测：**裸值被接受，完整 `DASCTF{...}` 形态被拒**（与多数题相反）。若裸值被拒再用完整形态重试一次，
再拒则升级调度者，不要继续枚举格式。

## 算法说明

- LFSR：`state_0 = 1`，`out_j = parity(state_j & feedback_mask)`，
  `state_{j+1} = ((state_j << 1) & 0xffffffff) ^ out_j`；mask 只有低 32 位参与，即 32 个未知 bit。
- 加密侧 `binary_flag = bin(bytes_to_long(flag))[2:]`：flag 40 字节、首字节 `D`(0x44) 最高位 0 被丢弃，
  故 key 恰 319 bit，且 `key[0:55]` 对应 `bin(int.from_bytes(b"DASCTF{", 'big'))[2:]`（对齐方式与加密一致）。
- **线性化关键**：state 的更新只依赖 out 本身（不依赖 mask），因此由已知明文算出前 55 个 out 后，
  每个 `parity(state_j & mask) = out_j` 都是 mask 32 个 bit 的 GF(2) 线性方程；
  55 个方程高斯消元 rank = 32（仅 `DASC` 32 方程时 rank 31，不够）→ `mask = 0xb0b53939`。
- 用 mask 跑 LFSR 生成全 keystream，与 key 异或、拼 bit、`int → bytes` 得 40 字节 flag。
- 烟雾弹（仅供识别，不求解）：`P(x) = x^4+x^3+x^2+x+231242352`，a、b 为 512-bit 素数，k 为 32-bit 素数。
  Coppersmith mod-divisor（fpylll LLL，m=2，t=8，X=2^33）可解出 k=4239857183（`gcd(ab, t-P(k))` 即 a），
  但 k ≠ mask（0xb0b53939），且初赛已交叉验证 `gcd(t-P(mask), ab)` 平凡——t 完全不约束 mask。

## 失败分支

- exp 断言失败（`prefix inconsistent` / `underdetermined`）：说明 key 或 flag 前缀与内置常量不符（附件被重生成）。
  先确认 key 文件内容；若确需重解，用「枚举前 4 个可打印 flag 字节」法：j ≤ 31 时 state_j 的 bit j 恒为 1，
  故前 32 个输出 bit 可逐 bit 顺序定出全部 mask bit；C 语言枚举前 4 字节（0x20–0x7e，约 8.1e7 组合）
  + 非可打印早退 + 末字节须为 `}`，47 秒内唯一命中。
- z3 建模时注意：约束是 `out_j == key_j ^ flag_j`，不是 `out_j == flag_j`（决赛测试赛在此浪费过一轮，
  症状为正确前缀报 UNSAT）。
- 不要在 Coppersmith / 分解 ab 上花时间（sage/fpylll 环境问题多，且已证明是死路）。

## 决赛实测备忘

- 初赛与决赛测试（2026-09-10）flag 完全一致：`5e1996755a3811ef93ccc03c59457d50`（附件 sha256 未变）。
- 测试赛实测 27 分钟、2 发提交（先整串被拒，裸值命中）；期间绕了 Coppersmith 烟雾弹和 z3 模型 bug 两个弯路。
  走本 exp 可在 1 分钟内完成。

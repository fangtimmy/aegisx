# GCD，杠上了（初赛 CRYPTO-09 · Crypto · 300 分）

近似公因子（ACD）问题：tasks.py 注释里 4 个样本 `x_i = p·q_i + e_i`（p 768bit、q_i 1000bit、
|e_i|<2^255），SDA（联立丢番图逼近）格 + LLL 恢复 p，flag = `DASCTF{sha256(hex(p))[:32]}`。
需附件 tasks.py 与 fpylll（镜像已内置）。

## 快速路径（约 10 秒，需附件）

```bash
# 附件定位：题名 GCD，杠上了 / CRYPTO-09；单文件 tasks.py（样本在注释里）
mkdir -p /tmp/gcd && cd /tmp/gcd
unzip -o -q '<GCD，杠上了的附件.zip>'
python3 /opt/solver/knowledges/xihulunjian/challenges/GCD，杠上了/exp/solve.py
```

预期输出：

```
[+] samples: 4 [1767, 1767, 1767, 1767]
[+] p recovered (768 bits) with base sample 0
[+] FLAG : DASCTF{eead8ea2b3519a2273a5292375e31009}
```

提交值（花括号内裸值）：`eead8ea2b3519a2273a5292375e31009`
若裸值被拒，用完整形态 `DASCTF{eead8ea2b3519a2273a5292375e31009}` 重试一次，再拒升级调度者。

## 原理（备查）

- SDA 格（ePrint 2016/215 §3）：行 0 = `(2^256, x_1, x_2, x_3)`，行 i = 对角 `-x_0`；
  目标短向量 `(q_0,q_1,q_2,q_3)·B = (2^256 q_0, q_0 e_1 − q_1 e_0, …)`，范数 ~2^1256
  ≪ det^(1/4) ≈ 2^1390；成功条件 t+1 > (γ−ρ)/(η−ρ) = 1512/512 ≈ 2.95，4 个样本满足。
- 恢复链：归约行首元素整除 2^256 → q_0 → **中心化剩余** e_0（噪声可为负，非负剩余会算出 p−1）
  → `p = (x_0−e_0)/q_0`；用全部样本 `|x_i mod p|（中心化）< 2^256` 自洽校验。
- flag 由 p 唯一决定（附件 sha256 不变则 p 不变），static。

## 失败分支

- exp 已轮换 4 个样本作基样本（x_0）；若都失败，理论上 LLL 精度不足，可改 BKZ(block_size=20)。
- 附件样本数变化：格维度自适应（t = 样本数−1）；但样本 < 4 时 SDA 条件不满足，无解属正常。

## 决赛实测备忘

- 初赛 300 分 Crypto；决赛测试赛未出现此题。flag 初赛实证 accepted：`eead8ea2b3519a2273a5292375e31009`。

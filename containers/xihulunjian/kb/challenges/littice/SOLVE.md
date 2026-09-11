# littice（初赛 CRYPTO-06 · Crypto · 300 分）

RSA phi 近似泄露的 Hidden Number Problem：110 个样本 `w_i ≈ (phi·X_i) mod n`（误差 < n^0.86），
嵌入格 LLL 恢复 s=p+q-1 后分解 n 解密。需附件 challenge.py（数据在文件底部注释行）与 fpylll（镜像已内置）。

## 快速路径（约 20 秒，需附件）

```bash
# 附件定位：题名 littice / CRYPTO-06，单文件 challenge.py（源码+数据注释）
mkdir -p /tmp/lit && cd /tmp/lit
unzip -o -q '<littice的附件.zip>'
python3 /opt/solver/knowledges/xihulunjian/challenges/littice/exp/solve.py
```

exp 从 CWD 递归找 challenge.py（只解析 `#` 开头的数据行）。预期输出：

```
[+] FLAG : DASCTF{R4a11y_n4w_l1ttice!!!}
```

提交值（花括号内裸值）：`R4a11y_n4w_l1ttice!!!`
若裸值被拒，用完整形态 `DASCTF{R4a11y_n4w_l1ttice!!!}` 重试一次，再拒升级调度者。

## 原理（备查）

- `phi = n - s`（s = p+q-1，约 513 bit）；`w_i = phi·X_i − XX_i·n + e_i`，|e_i| < d = n^0.86，
  即 `s·X_i + e_i ≡ −w_i (mod n)`——513-bit 秘密 + 881-bit 噪声的 HNP。
- 嵌入格 dim 112：单位阵 ×n 的 110 行 + `(X_1..X_110, 1, 0)` + `(−w_1..−w_110, 0, 2^886)`。
  目标向量范数 ~2^884 ≪ Gaussian heuristic ~2^1015，LLL 直接归约出来；`s = |v[110]|`。
- 验证：样本一致性 + 判别式 `Δ = (p+q)² − 4n` 为完全平方 → p,q → `d = e⁻¹ mod phi` 解 enc。

## 失败分支

- LLL 未出目标向量（exp 报 embedding vector not found）：重跑一次（LLL 确定性，基本不会）；
  或换 fpylll BKZ(block_size=20)。注意 wp 记录曾有环境需 `pip install cysignals`，镜像内已内置无需。
- 附件数据行变多/变少：exp 按 `#` 注释行前缀自适应，样本数 m 从 len(X) 取，格维度自动跟随。

## 决赛实测备忘

- 初赛 300 分 Crypto；决赛测试赛未出现此题。flag 初赛实证 accepted：`R4a11y_n4w_l1ttice!!!`。

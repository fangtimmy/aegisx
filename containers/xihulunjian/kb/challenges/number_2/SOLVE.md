# number_2（初赛 CRYPTO-05 · Crypto · 300 分）

两层密码学：Part1 RSA 半密钥泄露 + Coppersmith 分解 n；Part2 18 组线性同余核格恢复 (k,b) 后 AES-CBC 解密。
需要附件数据（output.txt）与 fpylll（镜像已内置）。

## 快速路径（约 30 秒，需附件）

```bash
# 附件定位：题名 number_2 / CRYPTO-05，外层 zip 内含 tempdir/CRYPTO附件/number.zip（两层解压）
mkdir -p /tmp/n2 && cd /tmp/n2
unzip -o -q '<外层附件.zip>' && unzip -o -q tempdir/CRYPTO附件/number.zip
python3 /opt/solver/knowledges/xihulunjian/challenges/number_2/exp/solve.py
```

exp 从 CWD 递归找 output.txt，无需指定路径。预期输出：

```
[+] part1: m, p recovered
[+] part2: all equations check: True
[+] FLAG : DASCTF{b157059c-2871-421f-8cec-332b617de4d5}
```

提交值（花括号内裸值）：`b157059c-2871-421f-8cec-332b617de4d5`
若裸值被拒，用完整形态 `DASCTF{b157059c-2871-421f-8cec-332b617de4d5}` 重试一次，再拒升级调度者。

## 原理（备查）

- **Part1**：`m` 为 20 随机字节（<2^160），`x = m^p mod n`、`y = m^q mod n`。
  mod p 时 `x ≡ m`（Fermat），故 `f(T) = (T-x)(T-y) mod n` 有小根 m mod p（p≈n^0.5），
  3×3 格 Coppersmith（X=2^160，界 n^0.25=2^256 内）恢复 m，`p = gcd(x-m, n)`。
- **Part2**：`s,t` 544-bit、`k,b` 480-bit、`q` 1024-bit，`r_i = (s_i·k_i − b_i·t_i)·x⁻¹ mod q`，
  18 组。消去 x 得 17 条齐次同余，36 维解空间模 q 用核格 + LLL/BKZ 归约出唯一的
  全 480-bit 系数向量（信息量 36×480=17280 < 17×1024=17408，余量 128 bit）。
- **解密**：`x2 = (s₀k₀ − b₀t₀)·r₀⁻¹ mod q`；`key = sha256(str(2024·b₀+2023·k₀+x2))[:16]`，
  `iv = sha256(str(p))[:16]`（p/q 两个因子都试），AES-CBC 解 cipher。

## 失败分支

- fpylll 不可用（非本镜像）：`pip install fpylll` 或改用 sage 的 `matrix.Zmod(q).right_kernel()`。
- BKZ 没找到全 480-bit 向量：exp 内已有 LLL→BKZ(20) 两级；再失败可提高 block_size 或
  固定 `row[0]>0` 符号重跑（格归约结果带全局 ±号，exp 已按 s0 归一）。
- 附件 sha256 变化（重新出题）：算法不变，直接重跑 exp 即可——它不依赖任何硬编码常量。

## 决赛实测备忘

- 初赛解出队数少（300 分 Crypto 压轴档）；决赛测试赛未出现此题。flag 为 UUID 裸值形态，
  初赛实证 accepted：`b157059c-2871-421f-8cec-332b617de4d5`。

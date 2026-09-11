# RSA_E（初赛 CRYPTO-07 · Crypto · 200 分）

**状态：researched（未拿到 flag）。** 两段式 RSA：第一阶段（Boneh-Durfee 恢复第二组公钥指数 e）已完全复现、exp 全自动且带自验证；第二阶段（相关消息）在当前数据下被证实计算不可行——e 高达 255 bit（~3e76），FR 所需的多项式 gcd 无已知亚指数算法（Boneh《Twenty Years of Attacks on the RSA》明确列为 open problem）。决赛若实例更新（尤其 e 变小），exp/solve.py 会自动全程跑通。

## 快速路径（约 10 秒，需附件）

```bash
# 附件定位：题名 RSA_E / CRYPTO-07，外层 zip 内含 tempdir/CRYPTO附件/RSA_E.py（单层伪代码+输出）
cd <附件所在目录>     # solve.py 会从 CWD rglob 找 RSA_E.py
python3 /opt/solver/knowledges/xihulunjian/challenges/RSA_E/exp/solve.py
```

预期输出（当前数据，阶段 2 为预期内阻塞）：

```
[+] d (276 bits) = 61563445687990870575106025375638739763325148996798824898019113547002775512700370211
[+] e (255 bits) = 30501842860287594237751063646050142774176396051109425087177513792089913045043
[+] stage 1 verified: pow(e, e_e, e_n) == e_c
[-] stage 2 BLOCKED: exponent e is 255 bits. ...
```

管线自检（无附件，自造 276-bit d 实例端到端验证 BD 管线）：`BD_SELFTEST=1 python3 solve.py` → 打印 `[+] stage 1 verified`。

## 提交规则

flag 未取得。若决赛解出：DASCTF{...} 形态先剥花括号交裸值（UUID/hex），被拒再用完整形态重试一次，再拒升级调度者。

## 原理（备查）

**阶段 1（已复现）：** 伪代码标注 `size(e_d)=276`、`size(e_n)=1024`，即 RSA1 (e_n, e_e) 的私钥指数仅 276 bit，δ=276/1024≈0.2695 < 0.292，Boneh-Durfee 适用。由 `e_e·d = 1 + k·φ(e_n)` 两边 mod e_e 得 `f(x,y) = 1 + x(A+y) ≡ 0 (mod e_e)`，其中 `A = (e_n+1)/2`、根 `(x0,y0) = (2k, -(p+q)/2)`（注意是 **-(p+q)/2**：`1 + 2k(A + y0) = e·d` 精确成立）。格构造（Herrmann-May 重排，u = xy+1 使 f = u + A·x 线性）：x-shifts `x^i·e_e^{m-j}·f^j`（0≤j≤m, 0≤i≤m-j）+ y-shifts `y^j·f^k·e_e^{m-k}`（k ≥ ⌊m/t⌋·j，经 u=x·y+1 完整提升、单项式集收录全部实际出现项）。LLL 后前几行反解（逐项除以界 U^a·X^b·Y^c）得 Z[w,z] 上多项式，resultant → 模大素数取线性因子得 w=2k 候选 → 由 `k·φ ≡ -1 (mod e_e)` 枚举 φ = φ0 + t·e_e (t<4)，判别式 `s²-4N` 为完全平方锁定 φ 与 p,q。最后 `e = e_c^d mod e_n`，`pow(e, e_e, e_n) == e_c` 自验证。参数 (m,t)=(6,3) 稳定命中，LLL <1s。注意 y0 若误取 -(p+q) 方程恒不成立（mimoo 参考实现里 A=(N+1)/2 与 x=2k 配套）。

**阶段 2（阻塞）：** RSA2 同模数 nn、同指数 e 加密相关消息 `c = m^e, cc = (n-m)^e mod nn`，即 Franklin-Reiter：`gcd(x^e - c, (n-x)^e - cc) ≡ x - m (mod nn)`。但 e = 30501…043 ≈ 2^254.6，多项式次数 ~3e76：Euclid 每步次数仅降 1（小实例数值实验证实），half-gcd 也只是拟线性于次数——**任何精确算法都要 Ω(e) 规模的中间对象，不可行**。对称化（s = m(n-m)：`s^e ≡ c·cc` 与幂和 `S_e(s) ≡ c+cc`）只把次数减半，仍 5e75；该"log(e) 时间多项式 gcd"是 Boneh 1999 综述里的公开问题，至今无解。

## 失败分支（全部实测排除）

- **分解 nn**：trial 2e5 / Fermat 2e5 步 / Pollard p-1 (B=2e7) / p+1 / rho 全部无果；nn 非完全幂。
- **素数复用**：e_n 已被 BD 顺带分解（φ 亦得），gcd(e_n/p/q, n, nn) 全为 1；批次内全部 crypto 附件扫出 3 万个大整数与 nn/n/e_n 无公因子。
- **指数结构**：e = 673·947·116725225039·P29·P32（非光滑，P94/P95 两个大素因子，无刻意构造）；gcd(e, φ(e_n))=1、gcd(e, e_n)=1、e 唯一性无歧义。
- **小指数兜底**：数据若由小指数误生成，FR 小指数扫 3..811（奇数）无命中；且与"解出 e 再 FR"的设计自洽性矛盾。
- **数值捷径**：gcd(c±cc, c·cc, …, nn)=1；pow(c/cc/d/e 各种组合, …, nn) 无 flag 迹象；Wiener 不中（δ>0.25）。
- 初赛 AI 阶段 agent 日志同样停在"BD→half-gcd FR"方案（参考 rkm0959/Half_GCD），无人解出；得分板统计批次四 CRYPTO-07 共 5 解（浅行组/光明未来/S1ZURU.N4KAT5U/中国杭州网络安全技能小赛/NeuroSamaIsCute），但平台 info.json `has_solved:false`、AI 阶段 0 解——**5 解与公开知识矛盾，不排除早期实例参数不同（当时 e 可能较小）**。

## 决赛实测备忘

1. 先跑 `solve.py`：10 秒内出 d、e 并自验证。**先看打印的 e 的 bit 长度**。
2. 若决赛实例 e ≤ ~2^20：solve.py 的 FR 段直接出 flag（阈值内自动执行；e ≤ 2^12 用内置稠密实现即可，更大需 half-gcd + FFT 多项式乘法或 sage）。
3. 若 e 仍为 255-bit：重跑快速排除项（gcd(c+cc,nn)、跨题素数复用扫描），然后按 blocked 出口升级调度者，不要在现场重推公开问题。
4. flag 形态未知（未解出）；按 DASCTF{...} 裸值优先规则提交。

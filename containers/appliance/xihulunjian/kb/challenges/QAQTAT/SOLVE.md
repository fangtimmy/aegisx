# QAQTAT（初赛 CRYPTO-08 · Crypto · 300 分）

GF(p²) 上 3×3 矩阵密钥传输方案（Stickel 型），Cayley–Hamilton 把双线性加密降维成
9×9 线性方程组，直接恢复会话密钥矩阵 K。纯 Python 标准库即可解，无需 sage / fpylll。

## 快速路径（约 30 秒，需附件）

```bash
# 附件定位：题名 QAQTAT / CRYPTO-08，外层 zip 内含 tempdir/CRYPTO附件/chall.sage（单文件，无内层 zip）
mkdir -p /tmp/qaqtat && cd /tmp/qaqtat
unzip -o -q '<外层附件.zip>'
python3 /opt/solver/knowledges/xihulunjian/challenges/QAQTAT/exp/solve.py
```

exp 从 CWD 递归找 chall.sage，无需指定路径。预期输出：

```
[+] parsed: p bits=256, ct bits=256
[+] 9x9 linear system solved (unique X)
[+] K = D*S*D recovered (scale checks consistent)
[+] FLAG : QAQ~4_Br0ken_Crypto_Sy5tem~TAT
```

提交值（裸值优先）：`QAQ~4_Br0ken_Crypto_Sy5tem~TAT`
若裸值被拒，用完整形态 `DASCTF{QAQ~4_Br0ken_Crypto_Sy5tem~TAT}` 重试一次，再拒升级调度者。

## 原理（备查）

- **方案**：Q, A 为 GF(p²)（i²=−1）上随机非交换 3×3 矩阵；T=QAQ，S=TAT，G=Q^r1。
  公钥 (A, T, S, G)。加密：D=G^s，E=ATA，公开 F=DED；会话密钥取 K=DSD 全部 9 个
  元素之和，mask=sha256(str(key))（Sage 的 GF(p²) 元素 str 形如 `a*i + b`），ct=m⊕mask。
  解密方用 QFQ=DSD（D 是 Q 的幂、与 Q 交换，故 Q·Q^s·ATA·Q^s·Q = Q^s·TAT·Q^s）。
- **漏洞**：Cayley–Hamilton ⟹ 3×3 矩阵任意幂落在 span{I, G, G²}（系数在 Fp²），
  故 D=a₀I+a₁G+a₂G²。代入 F=DED 得 F=Σᵢⱼ(aᵢaⱼ)·GⁱEGʲ——对秩 1 对称矩阵 X=(aᵢaⱼ)
  **线性**。9 个矩阵元素方程、9 个未知量，唯一解直接解出 X（实测满秩）。
- **恢复 K**：X 的第 k 列 = aₖ·a，得 Dv=aₖD；由 DvEDv=aₖ²F 逐元素求出一致的 aₖ²
  （9 个元素全一致即自校验），K=DvSDv/aₖ²。D 成对出现，正负号不影响 K。
- **坑**：Sage 打印的 GF(p²) 元素 `a*i + b` 中 a 是 i 系数、b 是常数项；解析时存成
  (常数, i 系数) 与算术约定统一，弄反则全程自洽但结果错（首轮实现即栽在这）。
  mask 必须复刻 Sage 的 str（`a*i + b` / `a*i` / `b` / `0` 四种形态）。

## 失败分支

- 9×9 系统奇异（该实例实测满秩，正常不会发生）：改用对称化 6 变量 ansatz
  （X_ij=X_ji，GⁱEGʲ+GʲEGⁱ 作列）重解。
- 找不到 chall.sage：确认外层 zip 已解压，文件在 tempdir/CRYPTO附件/ 下。
- 附件 sha256 变化（重新出题）：算法不变，直接重跑 exp——它不依赖任何硬编码常量。

## 决赛实测备忘

- 初赛实际 36 队解出（300→240 分衰减档），KB 早期快照的「全场未解」记录已过时。
- flag 为裸值形态（明文无 DASCTF{} 包裹）：`QAQ~4_Br0ken_Crypto_Sy5tem~TAT`，
  呼应题名 QAQTAT 的回文拆分（QAQ … TAT）。容器实跑验证通过
  （aegisx/solver:full，2026-09-11）。

# How_many_rot_are_there（初赛 CRYPTO-02 · Crypto · 200 分）

RSA 题（e=65536=2^16），hint `(e*p+e^2)^q mod n` 泄漏分解，明文是 flag 的双层
ROT（ROT13 字母 + ROT5 数字，即 ROT18——标题自答「两层」）。**exp 内置全部常量，
无需附件**。

## 快速路径（约 1 秒，纯标准库）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/How_many_rot_are_there/exp/solve.py
```

预期输出：

```
[+] FLAG : DASCTF{rabbits1sc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3}
[+] submit: rabbits1sc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3
```

提交值（花括号内裸值）：`rabbits1sc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3x1s4w1n1nc0mpl3`
（初赛实证，123 队解出）。

## 原理（备查）

1. 分解：mod p 时 `hint ≡ e^(2q)`，而 `n ≡ q (mod p-1)` → `p = gcd(e^(2n) − hint, n)`；
2. e 次根：`gcd(e,p−1)=gcd(e,q−1)=2` → CRT 后恰 4 个候选，唯一可打印者是 ROT18 后的
   flag 原文 `QNFPGS{enoovgf6fp5zcy8k...}`；
3. ROT13 字母 + ROT5 数字（只做 ROT13 数字不动 → 初赛被拒的形态，别交）。

## 失败分支

- exp 断言失败 = 常量被换（附件重新生成）→ 按上面三步重推，附件内的 task.py 提供
  新 hint/c/n。

## 决赛实测备忘

- 决赛测试赛未出现此题；flag static。

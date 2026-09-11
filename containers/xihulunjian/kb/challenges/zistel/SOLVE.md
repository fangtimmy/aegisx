# zistel（初赛 REVERSE-08 · Reverse · 300 分）

11KB stripped Zig 静态 ELF 的 Feistel 校验器：16 字节输入经 20 轮 Feistel
（密钥种子 dword `"love"`）后与固定 16 字节比较。**flag 由固定常量唯一决定，
无需分析二进制**——exp 已内置密钥表与密文，直接运行即得。

## 快速路径（约 1 秒，纯标准库）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/zistel/exp/solve.py
```

预期输出：

```
[+] FLAG : DASCTF{z1g_I3_S0_Coo0l!}
```

提交值（花括号内裸值）：`z1g_I3_S0_Coo0l!`
初赛实证：`DASCTF{...}` 包装被拒、裸值被接受。若再被拒升级调度者，不要枚举格式。

## 原理（备查）

- 输入 16 字节拆两个 8 字节块，各过 20 轮 Feistel：`(L,R) → (R, L ^ g(w[r], R))`，
  输出 `R20 || L20`；
- 轮函数 `g(w,R) = P(R ^ w) ^ w`，P 是由 w 字节驱动的 4 字节交换置换；
- 密钥表：`w[0] = 0x65766f6c ^ 0xdeadbeef`（种子即 dword "love"），
  `w[1] = w[0] ^ 0xbeefdead`，`w[i] = w[i-2] ^ w[i-1]`；
- 期望密文（0x1000730）：`5831293311027660465f1842296f7463`，逆向轮序解密即 flag。
- 校验只抽查下标 {0,12,8,4} 的 4 个 dword，但 4 个 dword 恰覆盖全部 16 字节。

## 失败分支

- exp 自带回环断言，正常不会失败。若决赛附件 sha256 变（重新出题），按上面锚点
  重提取：期望密文在 `0x1000730`，种子在 `.data 0x1004790`。

## 决赛实测备忘

- 初赛 39 队解出；决赛测试赛未出现。逆向时的坑：`0x10026f0` 看似 bswap 实为
  恒等变换（重建 dword 原序）——重逆向时不要踩。

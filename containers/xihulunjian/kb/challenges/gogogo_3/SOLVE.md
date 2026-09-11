# gogogo_3（初赛 REVERSE-01 · Reverse · 300 分）

Go+Garble 混淆的 Windows PE 校验器：输入 32 字节串依次过 RC4 → XOR → AES-128-CBC 后与固定密文比对。
**flag 全部由附件内固定常量决定，无需分析二进制**——下面 exp 已内置逆向出的全部常量，直接运行即得 flag。

## 快速路径（约 5 秒）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/gogogo_3/exp/solve.py
```

预期输出：

```
[+] AES decrypt : c8ff5282a53d76a1e2231875f804fd951942f0777ca14d1e51f4232b57d5153a
[+] RC4 cipher  : ae922bfb940f45c78f5a6144ca379bf8603bc1454fc7206728c5111831b86c43
[+] FLAG        : DASCTF{WOW_y0u_Find_Me_HaHa_go!}
```

提交值（花括号内裸值）：`WOW_y0u_Find_Me_HaHa_go!`
若裸值被拒，用完整形态 `DASCTF{WOW_y0u_Find_Me_HaHa_go!}` 重试一次，再拒则升级调度者，不要继续枚举格式。

## 备选路径

exp 无外部依赖（纯标准库实现 RC4 + AES 需 pycryptodome；镜像 venv 已含）。若 pycryptodome 缺失，
常量如下可自行实现：目标密文 hex
`1c1c18f8fc5b6c3d36a3fb8893561a906a9fa69c523ac6d3160adbe85e19fee8`，
AES key `qwertyuiopasdfgh`，IV `1234567890zxcvbn`，XOR key `fmyy123`（循环），RC4 key `mysecretkey`。
解密顺序：AES-CBC 解密 → XOR → RC4 解密。

## 决赛实测备忘

- 初赛与决赛测试（2026-09-10）flag 完全一致：`WOW_y0u_Find_Me_HaHa_go!`（附件 sha256 未变）。
- 测试赛实测 41 分钟、1 发命中；走本 exp 可在 1 分钟内完成。

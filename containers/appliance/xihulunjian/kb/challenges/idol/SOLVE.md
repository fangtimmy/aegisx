# idol（初赛 REVERSE-05 · Reverse · 200 分）

CPython 3.9 的 `idol.pyc` 校验器（嵌套 zip 内含 pyc + flag.txt，flag.txt 是 32 字节目标密文的
repr）。输入 32 字符（`flag[7:39]`）依次过 反转 → 按下标异或 → seed(51) 随机噪声 → 反转 →
相邻字符交换 → RC4（key=`hex(crc32("sta1k3r"))`，逐字节再异或 32）后与密文比对。
**flag 全部由附件内固定常量决定，无需反编译 pyc**——下面 exp 已内置全部常量，直接运行即得 flag。

## 快速路径（约 1 秒，纯标准库）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/idol/exp/solve.py
```

预期输出：

```
[+] IDOL       : sta1k3r
[+] RC4 key    : 3278cac7
[+] idol3 out  : 2b337c2e7b7e2e7b1e781f2f1d73737b39432f72394468703b6731642e636268
[+] FLAG       : 103baab6d786b0fe13c846ecb9f6a0ec
```

提交值（花括号内裸值）：`103baab6d786b0fe13c846ecb9f6a0ec`
**直接提交裸值**——测试赛实测完整形态 `DASCTF{103baab6d786b0fe13c846ecb9f6a0ec}` 被平台拒绝，
不要再试完整形态；若裸值也被拒则升级调度者，不要继续枚举格式。

## 常量表内置说明

exp 内置的常量即逆向所得的全部输入，与附件一一对应：

- `TARGET`：flag.txt 中 repr 的 32 字节密文（hex
  `84f30736ce78123aa4402f505aec4ed08d9e019ea487a97801773c48e9aa1333`）。
- `GATE`：idol0 校验字节 `16 17 06 53 0d 50 15`；`seed(35)` + `randrange(0,7)` 生成掩码
  `ecgbfcg`，异或得 idol 名 `sta1k3r`（exp 内自动重推导，非硬编码）。
- `KEY`：`hex(crc32("sta1k3r"))[2:]` = `3278cac7`（ASCII 8 字节）。
- 噪声序列：`seed(51)` 后连续 32 次 `randint(0,5)`（CPython 3.x 跨版本稳定）。

## 备选路径

exp 纯标准库（random/string/zlib），无第三方依赖，任何 python3 可跑。若需从附件重新考证：
`idol的附件.zip` 解出 `tempdir/REVERSE附件/idol.zip`，再解出 `idol.pyc` + `flag.txt`；
pyc 用 `pycdc`（或 `pycdas` 看常量）反编译，flag.txt 用 `ast.literal_eval` 取字节。注意三个
陷阱：morse 串 `[-30:52]` 切片为空（起始 78 > 终止 52）；`idol1` 的 `b` 列表是死代码；
email 正则把 `Th1s_Is_Fl@g` 前缀整体吃掉（`idol3` 输出无前缀）。

## 失败分支

- exp 报错或输出乱码：只可能是常量被改动，按「备选路径」从附件重新提取 flag.txt 密文后照
  exp 注释的逆序重推（逆序：RC4⊕32 解密 → 逆交换 → 逆反转 → 逆噪声 → 逆下标异或 → 逆反转）。
- 裸值被拒：flag_policy=static 且初赛/测试赛两场同 flag，被拒说明平台数据异常，升级调度者。

## 决赛实测备忘

- 初赛与决赛测试（2026-09-10）flag 完全一致：`103baab6d786b0fe13c846ecb9f6a0ec`（附件 sha256 未变）。
- 测试赛实测 1 分 40 秒（全场最快之一）：首发完整形态被拒 1 次，改提裸值即中；走本 exp 可跳过
  那次失误，一次提交命中。

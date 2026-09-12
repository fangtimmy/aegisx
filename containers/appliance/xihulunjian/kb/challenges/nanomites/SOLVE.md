# nanomites（初赛 REVERSE-04 · Reverse · 200 分）

MinGW 自调试反篡改 PE（nanomites 方案）：440 个 `ud2` 断点站点中 44 个
`r13==1` 的站点各携带一个输入字节的期望 hash。**exp 自带 hash 实现与站点解析，
从附件直接爆破 44 字节**——无需运行或调试原程序。

## 快速路径（约 3 秒，纯标准库）

```bash
cd <附件解压目录>   # 需可见 nanomites.exe 或附件 zip（tempdir/REVERSE附件/ 嵌套亦可）
python3 /opt/solver/knowledges/xihulunjian/challenges/nanomites/exp/solve.py
```

预期输出：

```
[+] FLAG : DASCTF{BBFE6A51-AE09-BCB1-E153-F2A3A297F228}
[+] submit: BBFE6A51-AE09-BCB1-E153-F2A3A297F228
```

提交值（花括号内裸值）：`BBFE6A51-AE09-BCB1-E153-F2A3A297F228`（初赛实证）。
注意：44 字符输入是**完整 `DASCTF{...}` 包装串**（UUID 内容 36 字符），要在原程序
验证需喂完整串。

## 原理（备查）

- exe 文件偏移 `0x10620`、长度 `0x3f8e` 的 blob 是校验函数（运行时 VirtualAlloc 后调用）；
- 每站点模式：`mov r12b,[rcx+off]; movabs r11,imm; xor r11,0x1337; ror r11,0xd; movabs r13,0|1; ud2`；
- 期望值 = `ror64(imm ^ 0x1337, 13) & 0xffffffff`，对 256 个字节候选跑父进程 hash
  （hashlittle 风格 32 位 mix，输入是 `[b, 0]` 单字节 NUL 串）逐一匹配；
- 44 个 `r13==1` 站点的 off 恰为 0..43，每 offset 唯一候选。

## 失败分支

- assert 站点布局不匹配 = 附件变化（重新生成 imm）——exp 的解析逻辑可复用，
  按上面模式重提取即可。

## 决赛实测备忘

- 初赛 65 队解出；决赛测试赛未出现。

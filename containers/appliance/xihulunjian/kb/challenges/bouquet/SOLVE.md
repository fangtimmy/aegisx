# bouquet（初赛 REVERSE-09 · Reverse · 200 分）

PE32 (MSVC) 的二叉树遍历校验器：25 字符输入按层序建完全二叉树，校验中序与后序
遍历等于两个内嵌串。**flag 由两个内嵌串唯一决定，无需分析二进制**——exp 内置重建。

## 快速路径（约 1 秒，纯标准库）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/bouquet/exp/solve.py
```

预期输出：

```
[+] FLAG : DASCTF{asd48_daj7w_3adqo}
[+] submit: asd48_daj7w_3adqo
```

提交值（花括号内裸值）：`asd48_daj7w_3adqo`（初赛实证裸值被接受）。

注意：本题输入是**完整 25 字符** `DASCTF{...}`（含花括号），不是内层 18 字符——
若要在靶机上验证原程序，喂完整串。

## 原理（备查）

- 中序串（0x417c1c）：`ja7Cws_A3daTd4qDo8}F_Sd{a`；
- 后序串（0x417b44）：`j7aw_sC3addq4TAo}8_Fda{SD`；
- 输入即层序序列：由中序+后序重建二叉树（根=后序末元素、按根切分中序），
  再层序读出。`build` 用 `str.index` 取切分点——两个串含重复字符但本数据自洽，
  exp 自带中序/后序回环断言兜底。
- 二进制里中序校验调用藏在花指令区（0x415adc–0x415ae0 跳入指令中部），重逆向
  时注意。

## 失败分支

- exp 断言失败说明内嵌串被改（附件 sha256 变）——按上面地址重提取两串即可。

## 决赛实测备忘

- 初赛 56 队解出；决赛测试赛未出现。

# flag^galf（初赛 MISC-01 · Misc · 200 分）

LiME 内存取证（Ubuntu 16.04, kernel 4.13.0-36）：作者用 `enc.py`（内存中已零长，不可恢复）对
flag 图片做异或加密。题名即算法：`flag ^ galf` = **通道反转异或**（img1.RGBA ^ img2.ABGR）。
页面缓存里可恢复 `picture.png` 与 `encrypt.png` 两张 200×200 PNG。

## 快速路径（附件 sha256 不变时直接提交）

```bash
# 附件定位：题名 flag^galf / MISC-01；两层解压得 "ubuntu flag.lime"（2GB）
```

提交值（花括号内裸值，初赛平台 1/1 实证 accepted）：`9da98cbf7e99bff7c93ef066935f65ba`
若被拒（flag 轮换），用完整形态 `DASCTF{9da98cbf7e99bff7c93ef066935f65ba}` 重试一次，
再拒说明 flag 已轮换 → 走下面的 exp 重建。

## exp（flag 轮换时的重建兜底）

```bash
cd /tmp && mkdir fg && cd fg
unzip -o -q '<外层附件.zip>' && unzip -o -q 'tempdir/MISC附件/ubuntu flag.zip'
python3 /opt/solver/knowledges/xihulunjian/challenges/flag^galf/exp/solve.py
```

自动流程：mmap 扫 PNG 签名 → 完整解析配对 XOR → 失败则截断 PNG 容错重建
（按 IHDR 容错走 chunk、部分解压、零填充建图、恰好两幅唯一图的尺寸做两种通道 XOR）→
放大二值化 OCR 找 `DASCTF`/32 位 hex。输出 `ori*_big.png` 供肉眼/迭代。
**注意**：初赛镜像实测目标 200×200 对每份副本只有 ~64KB 连续 IDAT（页面不连续），
部分重建只覆盖顶部行——OCR 未必命中，需要人工看 `orit_200x200_rev_big.png` 等输出图，
必要时调二值化阈值/裁剪中段再 OCR。

## 原理（备查）

- 内核 banner：`vol -f "ubuntu flag.lime" banners` → Linux 4.13.0-36-generic（Ubuntu 16.04）；
  bash history 有 `python enc.py`；文件位于 `/home/.pip3/`。
- 通道反转 XOR：`out = (r1^a2, g1^b2, b1^g2, a1^r2)`；等价捷径：对朴素 RGBA^RGBA 结果
  取 `r^g^b^a == 255` 的像素也能渲染出 flag 文本。
- 备选提取路线：volatility3（镜像已装）+ `Ubuntu_4.13.0-36` ISF 符号表可 pslist/bash；
  文件导出用 vol2 `linux_find_file -L/-O`（需自建 profile）——直接雕 PNG 签名通常更快。

## 失败分支

- carve 没有目标尺寸：可能镜像换了（sha256 变）——按 banner 重新分析。
- OCR 全空：看 `ori*_big.png`；flag 字体是像素风，可再放大 ×6、按 0/255 硬二值化后 psm 7。
- 决赛若内存镜像重新生成（key/flag 全变）：整个流程仍适用（算法在题名里）。

## 决赛实测备忘

- 初赛 200 分 Misc，平台验证 1/1 accepted：`9da98cbf7e99bff7c93ef066935f65ba`。
  flag 由附件（内存镜像）决定，static 跨场不变。

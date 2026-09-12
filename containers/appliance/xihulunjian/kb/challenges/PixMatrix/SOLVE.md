# PixMatrix（初赛 MISC-08 · Misc · 200 分）

像素字体图片的 2×2 块矩阵转置题：附件 `PixMatrix.jpg`（512×72）是 `(flag.jpg)^T`，
把右上/左下两个 256×36 象限互换即还原 `flag.jpg`，图内像素字体文字即 flag。
**flag 为 static（附件字节未变时直接提交已知值）**；tesseract 对该字体不可靠，
不要在 OCR 上浪费时间。

## 快速路径（约 30 秒）

1. 解两层压缩（内层 zip 是 xz 方法，用 7z）：

   ```bash
   unzip -o -q PixMatrix的附件.zip && 7z x -y tempdir/MISC附件/PixMatrix.zip
   ```

2. 还原图片并确认形态（尺寸 512×72、README 存在）：

   ```bash
   bash /opt/solver/knowledges/xihulunjian/kb/challenges/PixMatrix/exp/solve.sh
   ```

   输出 `flag_recovered.png`（还原图）与已知 flag 提示行。

3. 附件 sha256 与 INDEX 指纹一致 → 直接提交：`824f1e986260efa86f1bd252b5e13a4d`
   （初赛实证 accepted）。

## 若附件变化（sha256 不符）：字形匹配路线

- 还原后图片是 5×7 像素字体渲染的 `DASCTF{<32位hex>}`；
- 二值化（阈值 128）后按列空白切分字形，用 PIL 逐字形与标准 5×7 点阵比对
  （字符集仅 `0-9a-fDASCTF{}`，匹配空间极小）；
- 已证伪的路线：整图像素转置（得到竖条带）、按 8×8 tile 转置（字形粒度错）、
  原图直接 tesseract（必失败）、放大后 tesseract（不稳定，本轮实测仍乱码）。

## 决赛实测备忘

- 初赛 8 队解出；决赛测试赛未出现；flag 初赛/测试两场一致（static）。

# day&night（初赛 MISC-05 · Misc · 200 分）

night.jpg 的 XMP 里藏着伪装成 `Lens Manufacturer` 的 steghide 密码（`S1cre4_777`）→
解出一个 400x400 PNG：被圆形遮罩裁掉三个定位角的二维码。标准解码器全部拒读
（无定位角），需按 QR v4-H 手工解码（format info 实证 H + mask 0，4 blocks of
(25,9)），payload 再 ROT47 得 flag。day.png（15360x426 的 1-bit 半调日景长图）
是主题诱饵，不参与解码。需附件（day&night的附件.zip）与 Pillow/steghide（镜像已内置）。

## 快速路径（约 5 秒，需附件）

```bash
# 附件定位：题名 day&night / MISC-05；外层 zip → MISC附件/attachment.zip → day.png + night.jpg
cd <附件所在目录>
python3 exp/solve.py        # 或 exp/solve.py 的绝对路径，见 KB 内调用惯例
```

预期输出：

```
[+] night.jpg: .../night.jpg
[+] XMP password: S1cre4_777
[+] steghide → steg_out.png (2635 bytes)
[+] format info: EC level H, mask 0
[+] payload (25 bytes): b'sp$r%uLbuhss`sp\\sra`\\gbht'
[+] FLAG : DASCTF{3F9DD1DA-DC21-839E
```

提交值（花括号内裸值）：`3F9DD1DA-DC21-839E`
若裸值被拒，依次用 `DASCTF{3F9DD1DA-DC21-839E}` 重试；再拒可用 QR 内的原文形态
`DASCTF{3F9DD1DA-DC21-839E`（作者编码时就没有右括号，见下），仍拒升级调度者。

## 原理（备查）

- night.jpg 的 XMP（MicrosoftPhoto 扩展）有 `Lens Manufacturer="S1cre4_777"`
  —— 用 exiftool 可见，伪装成镜头厂商字段。它就是 steghide 密码。
- `steghide extract -sf night.jpg -p S1cre4_777` → 400x400 RGBA PNG（2635 字节）：
  白色边框 + 圆形半径 ~178px 内的 33x33 模块（模元 ~10.8px）黑白图案。
- 圆形遮罩裁掉了三个 finder 和大部分定位结构，zbar/opencv/pyzbar 全部拒读；
  但 format info（copy1 与 BCH 表逐位一致 = **H / mask 0**，hamming 0）、
  timing 行列（1010…）、dark module 全部完好——证明它是真的 QR version 4。
- 手工解码：按 v4 函数图形（finder+separator 8x8、timing 6 行/列、alignment
  (26,26)、两份 format、dark module）跳过 → mask 0 反掩码 → 标准 zigzag 读出
  100 codeword → 按 v4-H（4 blocks × (25,9)，EC 16/block）去交织 → RS 纠错
  （exp 内置 GF(256) RS，无需 reedsolo；实测 4 块 **0 错误**，码字本身干净）。
- payload 25 字节 = `sp$r%uLbuhss\`sp\\sra\`\\gbht`，ROT47 还原为
  `DASCTF{3F9DD1DA-DC21-839E`。**QR 里就没有右括号**（作者编码的字符串如此），
  mode=4/len=25 与 RS 结果自洽，非解码截断。
- day.png：15360x426 的 1-bit 图，是有序抖动（24px 网屏）的日景海天全景；
  白色占比从左 0.79 渐变到右 0.58。尺寸满足 12×1280 = 15360、2×426 ≈ 853，
  呼应 night.jpg——主题上凑「昼/夜」，解码上未用到（已穷举像素级对齐/
  模元采样/降采样掩码等 XOR 假设，全部本底噪声水平，排除）。

## 失败分支

- steghide 解出失败 = 密码变了：重新 `exiftool -b -XMP:All night.jpg` 找
  `Lens Manufacturer`，取引号内字符串即可（exp 已自动做）。
- exp 在 format info 断言失败：说明 steg 产物不是这张 400x400 圆盘（附件换版），
  先 `file steg_out.png` 确认尺寸，再检查 (21,21) 起的 357px 模元框是否偏移。
- RS 报 too many errors：模元采样漂移（换图后 step=span/N 变化）时，把采样窗口
  从 ±2px 收紧或按 `int(round(21 + i*span/N))` 重新对齐。

## 决赛实测备忘

- 初赛全场未解（200 分 Misc）。flag 为 QR 内实证内容：裸值
  `3F9DD1DA-DC21-839E`（8-4-4 的短 GUID 形态，非完整 UUID）；
  完整形态 `DASCTF{3F9DD1DA-DC21-839E}`；注意 QR 原文无右括号这一形态
  `DASCTF{3F9DD1DA-DC21-839E` 也是作者字符串的忠实还原，三形态按序止损。

# QRCodeWorld（初赛 REVERSE-07 · Reverse · 300 分）

Unity IL2CPP 游戏（提示「flag 就在你脚下」：地面 QR 码）。**QR 矩阵直接固化在
`global-metadata.dat` 的字段默认值节里，无需脱壳 GameAssembly.dll**——找到 29×29
的 0/1 int32 窗口、渲染、扫码即得。

## 快速路径（约 1 分钟）

```bash
cd /tmp
unzip -o -q <附件路径>/QRCodeWorld的附件.zip -d q    # 得 tempdir/REVERSE附件/QRCodeWorld.zip（嵌套 zip）
unzip -o -q q/tempdir/REVERSE附件/QRCodeWorld.zip -d qq
cd qq && python3 /opt/solver/knowledges/xihulunjian/challenges/QRCodeWorld/exp/solve.py
```

预期输出：

```
[+] FLAG : DASCTF{e45e144f-fe2a-4d49-9f3f-1af4f9df0244}
```

提交值（花括号内裸值）：`e45e144f-fe2a-4d49-9f3f-1af4f9df0244`

依赖：numpy/Pillow/pyzbar（镜像 venv 已含，libzbar0 已装）。

## 原理（备查）

- `QRCodeGenerator.qrCodeData = new int[29,29]`，由 `RuntimeHelpers.InitializeArray`
  从字段默认值 blob 填充——blob 就在 metadata 的
  `fieldAndParameterDefaultValueData` 节（头第 9 段，文件偏移 72 处 `{Offset,Size}`）；
- 扫描该节找 841 个连续 int32 全 0/1 且暗模块数 200~650 的窗口（实例偏移 0x1c3070，
  421 暗模块），reshape 29×29；
- 渲染带 4 模块静区的 PNG，pyzbar 解码。
- GameAssembly.dll 自带 aPLib 风格壳（DAS0/DAS1/DAS2 节）——只有矩阵提取失败需要
  重逆向时才需要脱壳（Unicorn 模拟 EP stub 0x18349d790，OEP 0x1806cdd90）+ Cpp2IL。

## 失败分支

- metadata magic 断言失败 / 窗口未找到：附件变化，按上面锚点重扫（窗口平衡条件可放宽）；
- pyzbar 解码失败：调大 scale/quiet 渲染参数，或人工看 qr_flag.png。

## 决赛实测备忘

- 初赛 10 队解出（300 分题）；决赛测试赛未出现。

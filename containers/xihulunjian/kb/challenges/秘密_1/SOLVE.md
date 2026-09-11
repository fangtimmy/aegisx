# 秘密_1（初赛 MISC-07 · Misc · 200 分）

**状态：researched（初赛全场 0 解，KB 攻坚未拿到最终 flag）。**

题型：Windows 7 x64 内存镜像取证。链条已完整重建：2GB vmem → 桌面 `flag.zip`
（ZipCrypto 加密的 `flag.txt` 37B + 明文提示 `hit.txt`）→ 卡在 ZipCrypto 密码。
提示明文已拿到：*"When you don't have an idea, you can think of "password", and
456@@254, don't forget him"*，按其所有直读解读爆破均未中。

## 快速路径（复现取证链，约 2 分钟，需附件）

```bash
mkdir -p /tmp/miq1 && cd /tmp/miq1
ditto -x -k '<秘密_1的附件.zip>' outer/          # → outer/tempdir/MISC附件/4.zip
unzip -o outer/tempdir/MISC附件/4.zip -d inner/  # → inner/4.raw (2147483648 B, 恰 2^31)
python3 - <<'EOF'   # 直接 carve 内存中的 flag.zip（无需 volatility）
import mmap
mm = mmap.mmap(open('inner/4.raw','rb').fileno(), 0, access=mmap.ACCESS_READ)
open('flag.zip','wb').write(mm[0x1300e000:0x1300e000+424])   # 完整 zip 424 B
mm.close()
EOF
python3 - <<'EOF'   # hit.txt 明文（未加密，直接 inflate）
import struct, zlib
d = open('flag.zip','rb').read()
i = d.find(b'PK\x03\x04', 1)                       # hit.txt LFH @0x56
ver,fl,me,mt,md,crc,cs,us,nl,el = struct.unpack('<HHHHHIIIHH', d[i+4:i+30])
print(zlib.decompress(d[i+30+nl+el:i+30+nl+el+cs], -15).decode())
EOF
```

`flag.txt` 条目：flags=0x09（ZipCrypto+data descriptor）、method=8、crc32=3AECC55E、
csize=48、usize=37、时间 0xB41A/0x58F4（2024-07-20 22:32:52）。加密 blob（48B，
12B ZipCrypto 头 + 36B deflate）：

```
99c49e333721a83d87f8700c721b322400018fa976697426520c1295b630391bfdc7855c4b2ca3f7e466fe36563ccfcf
```

真密码的 ZipCrypto 校验字节 = 0xB4（LFH time 高字节；为兼容写库器怪癖可同时接受
crc 高字节 0x3A；最终判定一律 inflate 成功 + crc32 吻合）。镜像内该 zip 有 3 份
逐字节相同拷贝（0x1300e000 / 0x371acd40 / 0x48e6ad48），无版本分歧。

## 已确认事实（原理备查）

- `4.raw` = DumpIt 抓的 VMware Win7 SP1 x64 内存（banner
  `ntkrnlmp.pdb|A3A6EBE530714799985ED058B2F0A064|2` = 7601.17514 x64；0x1000 起
  ACPI FACP + INTEL 440BX；主机名 WIN-4FPFI380ORM，用户 duguangxu）。
- volatility3 2.28 在无网环境拿不到 PDB（msdl 被沙箱/容器双重阻断）跑不了插件；
  手工 strings/正则扫描完全够用（进程名、`C:\Users\...` 路径、Bandizip UI 串全可提取）。
- 桌面足迹：`flag\flag.txt`、`flag.zip`（Bandizip 打开过，UI 残留「文件: 2, 文件夹: 0,
  压缩文件大小: 402 字节」「flag.zip - Bandizip (Standard)」）、test.jpg、
  winrar-x64-700scp(1).exe、DumpIt.exe，以及更早的四次抓取
  WIN-4FPFI380ORM-20240720-{161905,162314,163057,163436}.raw（本附件即该系列之一）。
- 约 20 个进程环境块里有 `password=123456qwe23`——**已验证不是 zip 密码**
  （校验字节 0xC4≠0xB4/0x3A，inflate 失败）。疑似出题人留的干扰或系列题共用凭据。
- hit.txt 明文（88B）即上文英文提示；其内容在内存中**无**明文残留（Bandizip 未解压过它），
  flag.txt 明文与 `flag{`/`DASCTF`/base64 形态在全镜像 0 命中——密码从未在本镜像内输入过。

## 已证伪路线（勿重试）

按 ZipCrypto(48B blob, crc=3AECC55E, len=37) 全量 inflate+crc 验证（自制 C 暴力器，
gcc+ zlib，~2M pwd/s，已用 `zip -P` 自造样本端到端校验）：

1. 提示直读：`456@@254`、`password`、`123456qwe(23)` 及两两/三三/四四 token 排列 ×
   10 种连接符（含 `password456@@254`、`password=456@@254` 等）共 5366 万——全灭。
2. rockyou + fasttrack + seclists/Passwords 全量（Kali 容器自带）35M——全灭。
3. 数字掩码 `[0-9]{1,4}@@[0-9]{1,4}` 1.23 亿——全灭（`ddd@@ddd` 已彻底排除）。
4. 全镜像字符串字典（ASCII+UTF-16 各段）560 万——全灭（内存里没有明文密码）。
5. 环境变量值、首尾空白/换行、全角 `４５６＠＠２５４`、GBK/UTF-8 中文后缀——全灭。
6. bkcrack 已知明文攻击：需 ≥8 连续已知明文字节；37B 明文可猜前缀 `flag{`(5)/
   `DASCTF{`(7) 均不足 8，且无网下载 bkcrack——暂不可行。

## 卡点与下步

- **卡点：ZipCrypto 密码。**提示语句所有「顺读」解读已穷尽。**2026-09-12 夜间已额外扫完
  （自制 C 暴力器，inflate+crc 全量裁决，均无命中，勿重扫）**：
  `[0-9]{1,4}@@[0-9]{1,4}`（1.23e8）、`[a-z0-9]{3}@@[0-9]{3}`（2.18e9）、
  rockyou 全量×{原样, +`@@254` 后缀, +`456@@254` 后缀, +`!!` 后缀}。
  剩下的可能是 ①密码是中文词组（UTF-8/GBK 字节流，字典难覆盖）；
  ②提示语义还有未解开的第二层（"him" 指代？test.jpg 隐写？winrar 安装包？）。
- 决赛若放出 秘密_2/3（同 VM 系列概率高），先做新题再回喂本密码。
- 有网时：bkcrack（若能确认 ≥8B 明文前缀，如决赛公布 flag 包装形态）或 hashcat -m 17200
  GPU 掩码跑 `[a-z0-9]{6,10}` 大空间与 rockyou+best64 规则。
- 兜底：ARCHPR 明文攻击（同 bkcrack 条件）。
- 暴力器留存：`/tmp/secret1/brute.c`（用法 `brute b <hexblob> <crchex> <usize> <vb|-> <pattern|w file>`；
  pattern 语法 `%d/%l/%a/%x` + 两位长度界；注意 pattern 类必须写满 4 字符如 `%d14`）。

## 决赛实测备忘

- 初赛 200 分 Misc、全场 0 解（challenges.csv solve_count=0）；4 支 LLM 队伍
  （deepseek-v4-pro）同样都推进到「发现加密 zip」后止步，无错误提交样本可参考。
- 平台 flag_policy=static，提交按裸值优先（花括号内内容），拒则换
  `DASCTF{...}` 完整形态再试一次。
- 若现场解出密码 P，则 flag = unzip -P P flag.zip flag.txt 的 37 字节内容
  （去掉包装取裸值提交），并回写本文件与 meta.json。

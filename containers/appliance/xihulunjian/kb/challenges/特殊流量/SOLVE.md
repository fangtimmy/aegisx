# 特殊流量（初赛 MISC-04 · Misc · 200 分）

pcap 上传取证三步：上传的 `flag` 文件是 hex 逆序的 7z → 已知密码解压 →
flag.txt 是「32 进制 token + 两栏栅栏（列移位）」双层编码。
密码是初赛实证常量（同 sm4rev 模式内置）。需附件（Traffic.pcapng）与 tshark/7z（镜像已内置）。

## 快速路径（约 5 秒，需附件）

```bash
# 附件定位：题名 特殊流量 / MISC-04；单文件 Traffic.pcapng
mkdir -p /tmp/sf && cd /tmp/sf
unzip -o -q '<特殊流量的附件.zip>'
python3 /opt/solver/knowledges/xihulunjian/challenges/特殊流量/exp/solve.py
```

预期输出：

```
[+] 7z rebuilt (234 bytes)
[+] flag.txt: D 1l A 1h S 1g 23 1d ...
[+] rail n = 22
[+] FLAG : DASCTF{25cad9a6-6b4a-4510-b744-5942eb6e6c76}
```

提交值（花括号内裸值）：`25cad9a6-6b4a-4510-b744-5942eb6e6c76`
若裸值被拒，用完整形态 `DASCTF{25cad9a6-6b4a-4510-b744-5942eb6e6c76}` 重试一次，再拒升级调度者。

## 原理（备查）

- pcap 内 Flask 上传服务（127.0.0.1:5000）：`/hint` 响应就是 `crc32`；
  另有 pwd1/2/3.dat 三个 4 字节文件（密码分段的 CRC32，供人工爆破密码——exp 不需要）。
- `filename="flag"` 上传体是一整行 hex；**hex 字符串逆序**（不是字节逆序）后是 7z
  （魔数 `37 7A BC AF 27 1C`）。
- 7z 密码 `PAS4_Wo3d_he3e!`（初赛爆破实证，附件 sha256 不变则密码不变）。
- flag.txt 解码：token 大写字母保留原字符，其余 `chr(int(tok, 32))`；得中间串
  `D5A1S0C-TbF7{...}`；再做列移位 n=22（= 串长一半，即两栏栅栏）得 flag。
  exp 自动搜索 n 并用 `^DASCTF{[0-9a-f-]+}$` 校验，不写死 22。

## 失败分支

- 7z 解压失败 = 密码变了（附件重新生成）：用 hashcat `-m 11500`（CRC32，hash 行格式
  `hex:00000000`）对 pwd*.dat 的 4 字节做掩码爆破，字符集从 `?l?u?d_!-` 4-5 位起试，
  三段拼接即新密码；其余步骤不变。
- 栅栏搜索无匹配：打印的中间串若不是 `D5...` 开头，先检查 token 大小写规则
  （exp 按 `isupper()` 保留，大小写敏感）。

## 决赛实测备忘

- 初赛 200 分 Misc；决赛测试赛未出现此题。flag 初赛实证 accepted：
  `25cad9a6-6b4a-4510-b744-5942eb6e6c76`。注意同场有另一题「特殊流量2」（MISC-06，
  NATO 电台），两题别混。

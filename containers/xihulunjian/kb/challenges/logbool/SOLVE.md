# logbool（初赛 MISC-02 · Misc · 100 分）

16MB pcapng（Windows loopback 抓包）：sqlmap 对 PHP+MySQL 站点做 boolean-based blind SQLi 的全程流量。
**flag 由附件唯一确定**：从 MySQL 协议流重建盲注逐字符提取的 `ctftest.ctfblob` 行——content 列是 RAR5 压缩包的 hex，密码就在同行的 password 列，解压即得 flag.txt。无猜测、无交互。

## 快速路径（约 2 分钟，tshark 扫描 16MB pcap 占绝大部分）

```bash
cd $(mktemp -d)
unzip -o /workspace/attachments/logbool的附件.zip
python3 /opt/solver/knowledges/xihulunjian/challenges/logbool/exp/solve.py
```

exp 自动在当前目录下递归定位 pcapng（也可 `solve.py <pcap路径>` 显式指定），预期输出：

```
Archive:  /workspace/attachments/logbool的附件.zip
  inflating: tempdir/MISC附件/logbool.pcapng
[+] pcap        : tempdir/MISC附件/logbool.pcapng
[+] oracle      : MySQL protocol pairing (2675 queries, 1123 TRUE)
[+] probes      : 2629 comparisons over 365 (column, offset, position) keys
[+] id          : 1
[+] username    : boolblob
[+] password    : timeemitloggol
[+] content     : 338 hex chars, 526172211a0701003392b5e50a01050600050101808000b2b1f3d65502033cb0...
[+] content.rar : 169 bytes (RAR5, password-protected flag.txt)
[+] flag.txt    : DASCTF{33c12355cd508de6b9b3676b97ece17e}
[+] FLAG        : 33c12355cd508de6b9b3676b97ece17e
```

中间产物：`content.rar`（169 字节 RAR5）与 `extracted/flag.txt`（40 字节）落在运行目录。

提交值（花括号内裸值）：`33c12355cd508de6b9b3676b97ece17e`
若裸值被拒，用完整形态 `DASCTF{33c12355cd508de6b9b3676b97ece17e}` 重试一次，再拒则升级调度者，不要继续枚举格式。

## 管线说明

**解压定位。** zip 内是 `tempdir/MISC附件/logbool.pcapng`（16,049,220 字节，NULL/loopback 封装，110k 包，约 5 分钟抓包窗口）。目录名含中文，普通 `unzip` 即可（可能乱码，不影响 rglob 定位）。

**MySQL 协议配对重建 oracle。** pcap 有两条平行真相源：HTTP（sqlmap ↔ web，响应体 gzip）与 MySQL（web ↔ 127.0.0.1:3306）。web 应用把注入 payload 拼进 `SELECT * FROM ctfuser WHERE id='<payload>' LIMIT 0,1` 送给 MySQL：条件为真，结果集带一行 `1,zhangsan,zhang`；为假，结果集只有列定义 + EOF、无数据行。exp 用 `tshark -Y mysql` 一遍导出全部 mysql 帧，按 tcp 流顺序把每个 COM_QUERY 与其结果阶段配对——有数据行 = TRUE、无行 = FALSE，得到 2675 个查询的 1:1 布尔 oracle（1123 真）。这比解析 HTTP 响应干净（无需解 gzip，每个请求一条独立 MySQL 连接，无串扰）。

**布尔二分重构。** sqlmap 的提取探针形如 `ORD(MID((SELECT IFNULL(CAST(<col> AS NCHAR),0x20) FROM ctftest.ctfblob ORDER BY id LIMIT 0,1),<pos>,1))><N>`，对每列每字符做二分。exp 把全部 `>` / `>=` / `!=` 比较聚成 (列, 行偏移, 位置) 约束组，在 0..255 中找唯一满足所有真值约束的字节值（2629 条比较 / 365 键）。每列末位是 sqlmap 的终止探测、约束不完定（候选 {0,1}），exp 在首个非唯一可打印字符处停笔——恰好得到完整字符串：id=`1`、username=`boolblob`、password=`timeemitloggol`、content=338 个 hex 字符。

**hex → RAR。** content 开头 `526172211a070100` 即 `Rar!\x1a\x07\x01\x00`（RAR5 签名）；unhexlify 后是 169 字节的完整 RAR5，内含 `flag.txt`（40 字节，加密）。exp 校验签名后写出 `content.rar`。

**解压 → flag。** RAR 密码无需爆破——就是同行重建出的 password 列 `timeemitloggol`（14 字符）。exp 调 `unrar x -y -ptimeemitloggol`（无 unrar 则 `7z e -y -ptimeemitloggol`）解出 `extracted/flag.txt` = `DASCTF{33c12355cd508de6b9b3676b97ece17e}`。

## 失败分支

- **mysql 路径无输出**（dissector 异常 / 探针数 < 100）：exp 自动降级到 HTTP objects oracle——`tshark -r logbool.pcapng --export-objects http,httpobj -q` 导出响应体，体含 `success` 即 TRUE（URI unquote 后就是探针）。该路径同样实测出 flag（测试赛即走此路）。手工等价：
  ```bash
  tshark -r logbool.pcapng --export-objects http,httpobj -q
  # httpobj/ 下每个文件：体含 "success" => TRUE；文件名 unquote 后含 ORD(MID(...))>N
  ```
- **Info 列备用路径**（初赛 wp 用法）：`tshark -r logbool.pcapng -Y mysql -T fields -e frame.number -e tcp.stream -e _ws.col.Info -e mysql.row.text -e mysql.query`，`Request Query` 帧与同流其后首个 `Response TABULAR Response` 配对，行文本非空 = 真。
- **unrar / 7z 均缺**：二者其一即可（solver 镜像两者都有），`7z e -y -ptimeemitloggol -oextracted content.rar` 与 unrar 等价。
- **RAR 报密码错**：确认 password 列重建为 `timeemitloggol`；尾部歧义位不是密码的一部分。不要去试 `timeemitloggol` 之外的变体（反转/拼接均已实测为错）。

## 决赛实测备忘

- 2026-09-10 决赛测试赛：**3 分钟全场首解**（人工走 HTTP objects 路径）；初赛与测试赛 flag 完全一致 `33c12355cd508de6b9b3676b97ece17e`，两场均以裸值提交被接受，附件 sha256 未变。
- 决赛当天直接跑 exp（MySQL 路径单次 tshark 扫描，比测试赛的手工路径更快更稳）；全程无网络、无猜测。

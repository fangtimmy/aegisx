# HK的怪兽（初赛 MISC-03 · Misc · 200 分）

哥斯拉（Godzilla PHP XOR）webshell 流量取证五连链：上传包拿 key → key 开 AES zip →
流量响应藏 1.pem 的 hex zip → pem 密码藏在 `cat X.txt` 命令里 → 私钥解密 flag。
exp 全自动：key、pem 密码全部从流量自取，无硬编码。需附件（pcapng + flag.zip）与 tshark/7z/openssl（镜像已内置）。

## 快速路径（约 1 分钟，需附件）

```bash
# 附件定位：题名 HK的怪兽 / MISC-03；外层 zip 内含 tempdir/MISC附件/HK的怪兽.zip（两层解压）
mkdir -p /tmp/hk && cd /tmp/hk
unzip -o -q '<外层附件.zip>' && unzip -o -q 'tempdir/MISC附件/HK的怪兽.zip'
python3 /opt/solver/knowledges/xihulunjian/challenges/HK的怪兽/exp/solve.py
```

预期输出：

```
[+] godzilla key: 9854e8aa5568e23c
[+] encrypted flag blob: flag 512 bytes
[+] stream 53: hex zip of 1.pem (2704 bytes)
[+] pem zip password: Pass1sHere
[+] FLAG : DASCTF{987787ad-5cf9-4909-b847-8dfb9d657988}
```

提交值（花括号内裸值）：`987787ad-5cf9-4909-b847-8dfb9d657988`
若裸值被拒，用完整形态 `DASCTF{987787ad-5cf9-4909-b847-8dfb9d657988}` 重试一次，再拒升级调度者。

## 原理（备查）

- 哥斯拉 PHP（XOR_BASE64）：`encode(D,K)` 逐字节 `D[i] ^= K[(i+1)&15]`；请求 `DASCTF=<urlenc(b64)>`，
  解码 = b64 → XOR → gzip；响应 = `16位hex头 + b64内层`（可能有/无 16 位hex尾），同样 XOR+gzip。
- **key 来源**：shell.php 经 DVWA 上传的 multipart 明文段（`$key='9854e8aa5568e23c'`），pcap 里直接 regex 可见；
  shell.php 源码本身也能从流 60 的加密响应中解出。
- **flag.zip**（AES, compression 99）：密码 = 哥斯拉 key；内含 512B RSA 加密 blob。
- **1.pem**：某流响应解密后是「1.pem 的 AES zip」的 hex 文本（PK 头 504B）；其密码是流 41 命令
  `cat Pass1sHere.txt` 的文件名（去 .txt）。
- **终局**：`openssl pkeyutl -decrypt -in flag -inkey 1.pem`。

## 失败分支

- 响应体解析报错已被跳过（多响应 TCP 流的切分会有非法 b64 片段）；若 1.pem zip 没找到，
  检查 tshark 版本对 `-T fields -e tcp.payload` 的输出格式（hex 是否带冒号，exp 已兼容剥冒号）。
- 决赛若换了 key/pem 密码：exp 全部自动派生，直接重跑即可；flag 形态若变（非 UUID）按实际输出提交。
- pcap 是 pcapng；若决赛给 pcap 同样支持（rglob 两种后缀）。

## 决赛实测备忘

- 初赛 200 分 Misc；决赛测试赛未出现此题。flag 初赛实证 accepted：`987787ad-5cf9-4909-b847-8dfb9d657988`。
  flag 由附件（flag.zip+私钥）决定，static 跨场不变。

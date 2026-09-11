# 特殊流量2（初赛 MISC-06 · Misc · 300 分 · **flag 已轮换**）

2024 楚慧杯原题：26MB 蚁剑(AntSword)流量包。Webshell 是 `uploads/my_rsa.php`——对每个
POST 参数做 `openssl_public_decrypt`（公钥解密 = 只需公钥即可还原流量），命令链揭示了
`secret` 文件（i/7 被替换为 x）、其 md5、以及 AES 加密的 `flag.txt`。

**⚠ 本条目为 rotated 政策**：附件 sha256（`3a40c4a6…777`）初赛与决赛完全一致，但两场平台
注册的 flag 不同（见「flag 轮换规则」）。**决赛提交测试赛验证过的 UUID，不要提交初赛的 md5。**

## 快速路径（约 30 秒）

```bash
cd /workspace/attachments   # 附件 zip 所在目录（或把 zip 路径作为参数传入）
python3 /opt/solver/knowledges/xihulunjian/challenges/特殊流量2/exp/solve.py
```

预期输出（全部由附件实时推导，无硬编码常量）：

```
[+] attachment : 特殊流量2的附件.zip
[+] streams    : www.zip=['574', '574'] posts=16
[+] rsa pub    : 1024-bit, e=65537
[+] masked     : xx34d619x1brxgd9mgd4xzxwxytv669w
[+] md5sum     : edffd5be04cc060e343cad479a8b845c  (over content WITH trailing \n)
[+] flag.txt   : openssl Salted__ AES blob, 344 b64 chars
[+] secret     : i734d619i1brigd9mgd4xz7w7ytv669w
[+] NATO       : Delta Alpha Sierra Charlie Tango Foxtrot Three ... Nine Nine
[+] FLAG       : 3fd34b59-4e9d-4390-927b-1346d5364d99
[+] full form  : DASCTF{3fd34b59-4e9d-4390-927b-1346d5364d99}
[+] quali md5  : edffd5be04cc060e343cad479a8b845c  (初赛平台注册值, 决赛不应再提交)
```

**提交值 = `FLAG` 行原文**：全小写、裸 UUID、无 `DASCTF{}` 包装：
`3fd34b59-4e9d-4390-927b-1346d5364d99`

## flag 轮换规则（确定性解释）

附件是静态的，flag 从未在附件里「变过」——**附件同时携带两个候选值，两场平台注册了不同的那一个**：

| 场次 | 平台注册 flag | 附件内的来源 |
|---|---|---|
| 初赛（MISC-06） | `edffd5be04cc060e343cad479a8b845c`（32 位 hex） | 流量中 `md5sum secret` 的输出，即 **md5("i734d619i1brigd9mgd4xz7w7ytv669w\n")**（注意**带换行**） |
| 决赛测试（2026-09-10，已验证） | `3fd34b59-4e9d-4390-927b-1346d5364d99`（UUID） | `flag.txt`（`U2FsdGVkX1…`，AES-256-CBC，EVP_BytesToKey/MD5，口令=secret）解密后的 NATO 字母表 |

**当前 flag 的确定性定义**：

```
flag = lower( NATO_decode( AES-256-CBC-dec( flag.txt密文, key/iv = EVP_BytesToKey(MD5, pw=secret, salt) ) )[len("DASCTF"):] )
其中 secret = 唯一满足 md5(candidate + "\n") == edffd5be…845c 的 x→{i,7,x} 组合
```

已排除的替代假设（均实测不符）：`edffd5be…` **不是** UUID 的任何 hash——
md5(uuid)=`0b71cd77…`、md5(uuid 大写)=`c0f73a19…`、md5("DASCTF{uuid}")=`a61c0408…`、
md5(secret 不带换行)=`165cd164…`，均不等于 `edffd5be…`；它恰为流量里 md5sum 输出原值。
UUID 第 4 组是 `927b`（NATO 原文 "Nine Two Seven Bravo"）——若任何资料写 `9f3b` 系笔误。

## 提交规则（测试赛 9 发 8 拒换来的，严格遵守）

平台 flag 字段**只存花括号内的小写裸值，精确匹配（大小写敏感）**。测试赛被拒的全部 8 个形态：

1. `3FD34B59-4E9D-4390-927B-1346D5364D99`（大写裸值）❌ —— NATO 解码天然是大写，**必须 .lower()**
2. `DASCTF{3FD34B59-…}`（大写带包装）❌
3. `DASCTF3FD34B59-…`（去括号保留前缀）❌
4. `DASCTF{i734d619i1brigd9mgd4xz7w7ytv669w}`（secret）❌
5. `flag{3FD34B59-…}` ❌
6. `DASCTF{3fd34b59-…}`（小写但带包装）❌
7. `i734d619i1brigd9mgd4xz7w7ytv669w`（裸 secret）❌
8. `DASCTF{DASCTF3FD34B59-…}`（双层包装）❌
9. `3fd34b59-4e9d-4390-927b-1346d5364d99`（小写裸 UUID）✅ **accepted**

被拒后按此梯度最多再试 2 发：`3fd34b59-…927b-1346d5364d99`（exp 原文）→ 若轮换政策再变，
`edffd5be04cc060e343cad479a8b845c`（初赛注册值）→ 仍拒即升级调度者，勿再枚举形态。

## 失败分支

- **exp 报 `no attachment zip containing a .pcapng`**：cwd 不对，用参数指明 zip 路径
  `python3 …/solve.py /path/to/特殊流量2的附件.zip`。
- **`tshark` 缺失**：exp 依赖 tshark 做 TCP 重组（solver 镜像已内置 `/usr/bin/tshark`）；
  实在没有时 `apt install -y tshark` 后重跑。
- **NATO 解码不完整**（少词/丢尾字符，测试赛和初赛 WP 都出现过 `…5364d9` 丢末位 9 的错误）：
  exp 已用 UUID 正则 `^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$` 校验解码完整性——
  手工解码时务必逐词核对且让词数对齐 36 字符 UUID，再提交。
- **flag.txt 密文提取失败**：密文在 POST 命令 `echo "U2FsdGVkX1…" > flag.txt` 中（stream 590），
  不在 www.zip 里；确认走的是本 exp 的全链解码而非只看导出对象。

## 决赛实测备忘

- 测试赛（2026-09-10）：29 分钟解出、9 发 1 中。两个根因教训已固化进 exp：
  ① 平台大小写敏感 + 只收花括号内值 → exp 直接输出可提交形态；
  ② 解码完整性 → UUID 正则校验。
- 决赛当天直接跑快速路径即可在 1 分钟内出 flag；exp 全程 <1 分钟
  （17 次 tshark follow 约 15–30 秒）。
- 附件 sha256 `3a40c4a63f1a0814f2c3b2befb426c46f1115e980610d4c36d0b40fa60a7a477`，
  若决赛附件 hash 变了则本条目规则需重新验证（UUID 在密文里，可能已换）。

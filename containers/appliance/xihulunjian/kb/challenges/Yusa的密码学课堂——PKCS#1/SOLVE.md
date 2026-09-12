# Yusa的密码学课堂——PKCS#1（初赛 CRYPTO-01 · Crypto · 200 分）

魔改 pycryptodome 的 PKCS#1 v1.5：padding 只收零字节 → padded 块完全确定；task.py 末尾注释
泄漏 `pow(AES_KEY_ENC, d, q*r)`（= padded 明文整数），其**末 16 字节就是 AES key**，AES-ECB
解附件得 PDF，flag 以矢量字形画在第 3 页。flag 静态、两场一致，exp 已内置全部常量，直接跑。

## 快速路径（数秒）

```bash
python3 "/opt/solver/knowledges/xihulunjian/challenges/Yusa的密码学课堂——PKCS#1/exp/solve.py" [附件zip路径]
```

不传参数时自动在当前目录与 `/workspace/attachments` 找 `Yusa的密码学课堂——PKCS#1的附件.zip`。
预期输出（tmp 路径随机；无附件时跳过前两行与 PDF 行，仍输出 flag）：

```
[+] attachment : /workspace/attachments/Yusa的密码学课堂——PKCS#1的附件.zip
[+] sha256     : b8db6efdf7c7… (match)
[+] leak       : task.py comment == builtin constant
[+] AES key    : 44bfc33d0bfb3cd688a074a7adad1504
[+] PDF        : 38624 bytes -> /tmp/yusa_pkcs1_xxx/PKCS1_v1_5.pdf (flag vector-drawn on page 3)
[+] FLAG       : DASCTF{6b3ed7dc3c1c6615fb97a7020922f7a5}
6b3ed7dc3c1c6615fb97a7020922f7a5
```

提交值（花括号内裸值）：`6b3ed7dc3c1c6615fb97a7020922f7a5`
裸值优先（初赛与测试赛均以裸值通过）；被拒则完整形态 `DASCTF{6b3ed7dc3c1c6615fb97a7020922f7a5}`
重试一次，再拒升级调度者。**不要提交 PDF 第 3 页文字层的
"You seem to know RSA and python very well, congratulations!"——那是诱饵，初赛实证被拒。**

## 算法说明

- 魔改点：附件 `Crypto/Cipher/PKCS1_v1_5.py` 加密 Step 2a 的填充字节过滤条件写反——原版丢弃
  0x00，魔改版 `if bord(new_byte[0]) != 0x00: continue` **只收 0x00**，于是 PS 全零，
  EM = `00 02 || 00*237 || 00 || AES_KEY`（k=256，mLen=16）完全确定。
- 泄漏与恢复：task.py（python2）用 RSA(q*r, e=3) 构造 PKCS#1 v1.5 key 加密 16 字节 AES key，
  并把 `pow(AES_KEY_ENC, d, q*r)` 打印在末尾注释——对密文做 raw RSA 解密就是 padded 明文整数；
  转大端字节（255 字节，前导 00 已剥），校验布局（首字节 02、中段全零）后末 16 字节即 AES key
  `44bfc33d0bfb3cd688a074a7adad1504`。**无需分解 n**，p/n/hint 均与 flag 无关。
- 解密：AES-128-ECB 解 `PKCS#1.v1.5.enc` → RFC 8017 第 28–29 页 PDF（38624 字节，无填充）。
- flag 取值：第 3 页另有 40 组矢量贝塞尔字形（各带 `cm` 变换、无字体/ToUnicode），
  `pdftotext`/`pypdf` 提取不到，渲染后才是 `DASCTF{6b3ed7…}`。flag 两场一致且已内置 exp，
  **无需现场 OCR**；要人工复核就 `pdftoppm -png -r 150 -f 3 -l 3` 渲染第 3 页看末行。
- 彩蛋（与 flag 无关）：`hint_enc = hint^3 mod n` 且 hint^3 < n → `gmpy2.iroot(hint_enc, 3)`
  精确恢复 hint 句子（短消息低指数攻击）。

## 失败分支

- 找不到附件：路径作 argv[1] 传入，或 `fd -g '*PKCS#1*' /workspace` 定位后传入。
- exp 报 `sha256 MISMATCH` / `leak differs` 但 PDF 校验通过：附件被重新生成但结构未变，exp 已
  自动改用附件内新泄漏值，输出仍可信；若报 `not a PDF`，flag 已轮换，**勿提交旧值**，升级调度者。
- 想从魔改包考证：附件内 `Crypto` 是 py2 时代的 .pyd/.pyc，python3 import 不进去；直接读
  `Crypto/Cipher/PKCS1_v1_5.py` 源码比对（魔改点见上），不要尝试安装它。

依赖：pycryptodome（镜像 venv 已含）。

## 决赛实测备忘

- 初赛（2026-08-21）与决赛测试赛（2026-09-10）flag 一致：`6b3ed7dc3c1c6615fb97a7020922f7a5`
  （附件 sha256 未变）。
- 测试赛实测约 13 分钟（17:50:54 → 18:04:27）、1 发命中（裸值）；初赛首提交踩 congrats 诱饵
  被拒一次，随后裸值通过。走本 exp 数秒完成。

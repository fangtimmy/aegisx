# 西湖论剑决赛知识库索引

初赛题解题手册（42 条，覆盖 40 个初赛题号；决赛复用初赛原题）。条目目录 `challenges/<key>/`：`SOLVE.md`（确定性操作手册）+ `exp/`（可直接执行的脚本）+ `meta.json`（本表数据源）。

## 匹配步骤（按顺序）

1. 按题名精确匹配 `names` 列（含初赛题号别名）；
2. 按附件文件名匹配；
3. 对工作区附件算 `sha256sum` 匹配指纹列（附件内容被复用时题名可能已变）；
4. 均未命中 → 本库无此题，走正常解题流程。

flag_policy 含义：`static`=附件可复现 flag；`dynamic`=打实例取 flag，禁止提交旧值；`rotated`=附件同但 flag 已轮换，以 exp 现算为准；`unknown`=待研究。
status 含义：`verified`=exp 已实跑验证；`authored`=已写 runbook 未实跑；`researched`=有研究结论；`todo`=仅有元数据。

| key | 题名/别名 | 分类 | policy | status | 初赛 | 测试赛 | 附件指纹 (sha256 前 12) |
|---|---|---|---|---|---|---|---|
| BabyXSS | BabyXSS / WEB-04 | Web | dynamic | researched | 未解 | - | `BabyXSS的附件.zip` `1e44800edf29` |
| EZheap_2 | EZheap_2 / PWN-06 | pwn | dynamic | researched | 未解 | - | `EZheap_2的附件.zip` `9f05be813b5e`<br>`ezheap` `ad971e7ad984`<br>`libc.so.6` `acf8ac6d219b` |
| GCD，杠上了 | CRYPTO-09 / GCD，杠上了 | Crypto | static | verified | 解出 | - | `GCD，杠上了的附件.zip` `5866126e0530` |
| HK的怪兽 | HK的怪兽 / MISC-03 | Misc | static | verified | 解出 | - | `HK的怪兽的附件.zip` `4547cb06511b` |
| HardFlask-awdp-fix | HardFlask-awdp-fix / HardFlask-awdp / HardFlask-awdp  | Web | dynamic | verified | - | 解出 | - |
| How_many_rot_are_there | CRYPTO-02 / How_many_rot_are_there | Crypto | static | verified | 解出 | - | `How_many_rot_are_there的附件.zip` `adf8d741edd6` |
| Messy_heap | Messy_heap / PWN-07 | pwn | dynamic | researched | 未解 | - | `Messy_heap的附件.zip` `e0574cf87c3b` |
| MirrorShield | MirrorShield / REVERSE-02 | Reverse | static | verified | 解出 | - | `MirrorShield的附件.zip` `cb020727df41` |
| NativeAOT_3 | NativeAOT_3 / REVERSE-03 | Reverse | static | verified | 解出 | 解出 | `NativeAOT_3的附件.zip` `1fe2faf10600` |
| PixMatrix | MISC-08 / PixMatrix | Misc | static | verified | 解出 | - | `PixMatrix的附件.zip` `a2e747b588ed` |
| QAQTAT | CRYPTO-08 / QAQTAT | Crypto | static | verified | 解出 | - | `QAQTAT的附件.zip` `fa261449e445` |
| QL_again | QL_again / WEB-02 | Web | dynamic | verified | 解出 | 解出 | `QL_again的附件.zip` `aa0cff46a270` |
| QRCodeWorld | QRCodeWorld / REVERSE-07 | Reverse | static | verified | 解出 | - | `QRCodeWorld的附件.zip` `38a61efae681` |
| RSA_E | CRYPTO-07 / RSA_E | Crypto | static | researched | 未解 | - | `RSA_E的附件.zip` `ed34af379203` |
| Regular_apples | PWN-03 / Regular_apples | pwn | dynamic | verified | 解出 | 解出 | `Regular_apples的附件.zip` `65084c840874` |
| Rvmecisp | CRYPTO-04 / Rvmecisp | Crypto | static | verified | 未解 | 解出 | `Rvmecisp的附件.zip` `5e95f624cbcf` |
| WEB-01 | WEB-01 / Age Test / HardFlask | Web | dynamic | verified | 解出 | - | - |
| WEB-03 | WEB-03 | Web | dynamic | todo | 未解 | - | - |
| WEB-05 | WEB-05 | Web | dynamic | researched | 解出 | - | - |
| WEB-06 | WEB-06 | Web | dynamic | todo | 未解 | - | - |
| WEB-07 | WEB-07 | Web | dynamic | todo | 未解 | - | - |
| Yusa的密码学课堂——PKCS#1 | CRYPTO-01 / Yusa的密码学课堂——PKCS#1 | Crypto | static | verified | 解出 | 解出 | `Yusa的密码学课堂——PKCS#1的附件.zip` `b8db6efdf7c7` |
| bouquet | REVERSE-09 / bouquet | Reverse | static | verified | 解出 | - | `bouquet的附件.zip` `0fe52c748a5e` |
| day&night | MISC-05 / day&night | Misc | static | verified | 未解 | - | `day&night的附件.zip` `2d965a489a47` |
| flag^galf | MISC-01 / flag^galf | Misc | static | authored | 解出 | 解出 | `flag^galf的附件.zip` `4eee86df2fa7` |
| gogogo_3 | REVERSE-01 / gogogo_3 | Reverse | static | verified | 解出 | 解出 | `gogogo_3的附件.zip` `c51555dad0ab` |
| idol | REVERSE-05 / idol | Reverse | static | verified | 解出 | 解出 | `idol的附件.zip` `5aa295c9d5b2` |
| littice | CRYPTO-06 / littice | Crypto | static | verified | 解出 | - | `littice的附件.zip` `15a4a3c07e21` |
| llfsrr | CRYPTO-03 / llfsrr | Crypto | static | verified | 解出 | 解出 | `llfsrr的附件.zip` `c4826c77c25d` |
| logbool | MISC-02 / logbool | Misc | static | verified | 解出 | 解出 | `logbool的附件.zip` `f29595d1d2b8` |
| mvmph | PWN-02 / mvmph | pwn | dynamic | researched | 解出 | - | `mvmph的附件.zip` `6b6caa3002ae` |
| nanomites | REVERSE-04 / nanomites | Reverse | static | verified | 解出 | - | `nanomites的附件.zip` `1121cd36d757` |
| number_2 | CRYPTO-05 / number_2 | Crypto | static | verified | 解出 | - | `number_2的附件.zip` `7620c6cfbab6` |
| sm4rev | REVERSE-06 / sm4rev | Reverse | static | verified | 解出 | - | `sm4rev的附件.zip` `279e4bcd6c62` |
| upup_exec | upup_exec | Web | dynamic | researched | - | 解出 | - |
| what_heap | PWN-01 / what_heap | pwn | dynamic | researched | 未解 | 解出 | `what_heap的附件.zip` `be0f999e41fc`<br>`what_heap` `97cd62919fb7`<br>`libc.so.6` `acf8ac6d219b` |
| why_not_heap | PWN-04 / why_not_heap | pwn | dynamic | verified | 未解 | - | `why_not_heap的附件.zip` `2f6cde979caf`<br>`pwn` `3bd13dee5eb6`<br>`libc.so.6` `9b5bf1626e39`<br>`ld-linux-x86-64.so.2` `46973706a7e7` |
| wish | PWN-05 / wish | pwn | dynamic | verified | 未解 | 解出 | `wish的附件.zip` `0c772d12cc68` |
| zistel | REVERSE-08 / zistel | Reverse | static | verified | 解出 | - | `zistel的附件.zip` `15b175ad1cd5` |
| 特殊流量 | MISC-04 / 特殊流量 | Misc | static | verified | 解出 | - | `特殊流量的附件.zip` `deede029aae4` |
| 特殊流量2 | MISC-06 / 特殊流量2 | Misc | rotated | verified | 解出 | 解出 | `特殊流量2的附件.zip` `3a40c4a63f1a` |
| 秘密_1 | MISC-07 / 秘密_1 | Misc | static | researched | 未解 | - | `秘密_1的附件.zip` `6e0de1f632e9` |

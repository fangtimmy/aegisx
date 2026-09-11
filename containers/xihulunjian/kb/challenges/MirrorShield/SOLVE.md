# MirrorShield（初赛 REVERSE-02 · Reverse · 300 分）

APK 离线恶意软件分析题（仿冒反诈 App，五环级联加密链）。提交格式：
`DASCTF{md5(md5(<恶意行为>#<完整C2>#<团伙代号>))}`——**双重 md5**（对第一次的
hex 串再 md5 一次）。三个答案值已全部从 APK 提取固化，exp 直接算 flag。

## 快速路径（约 1 秒，纯标准库）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/MirrorShield/exp/solve.py
```

预期输出：

```
[+] inner string : CONTACTS_OTP#https://cipher-nest.sc26.invalid:12443/courier/v7/check#MIRROR_PANTHER
[+] md5 #1       : 38ef78348cdc0633f3d0130d2eb52e20
[+] FLAG (submit): 3d97fe7e53a5fc5de1ebdaae046cb93f
```

提交值：`3d97fe7e53a5fc5de1ebdaae046cb93f`（初赛实证）。

## 三个答案值（若附件 sha256 未变，直接可信）

| 项 | 值 | 来源环 |
|---|---|---|
| 恶意行为 | `CONTACTS_OTP` | q1 EV4 虚拟机轨迹（VM 暂存 CONTACTS+OTP 后 PACK/QUEUE） |
| 完整 C2 | `https://cipher-nest.sc26.invalid:12443/courier/v7/check` | q3 RC5 路由 SLOT 5：域名 ROT13、路径段反转 |
| 团伙代号 | `MIRROR_PANTHER` | q4 TX5 图腾表 PANTHERA_PARDUS→PANTHER + 证书 O 首词 Mirror |

易错点（初赛 25 次提交的血泪）：行为不是 `CONTACTS_VOICE`（VM `0x96` 掩码是立即数
不是寄存器）；团伙名是全名 `MIRROR_PANTHER` 不是 crew 码 `MP26`；必须**双重** md5；
手工验证用 `printf '%s'` 防换行。

## 若附件变化：五环重推导（每环密钥由上一环输出级联派生）

1. **q1**：`assets/policy/engine.dat`（EV4 magic，xorshift 流解密，密钥
   `(-1640531527*blockId)^seed^(table[tidx]*73244475)`），手写寄存器 VM 模拟器跑
   行为轨迹；
2. **native**：`q0.protocol()`（queueDigest+证书摘要+stateExport 初始化 libsc26core.so
   状态机）→ share1/share2/seal；
3. **q5**：`SHA256(前序值||"A4-STAGE"/"B4-STAGE")` 为密钥 AES/CTR 解
   `assets/stage/{alpha,beta}.bin` 得 DEX 令牌（含 carriers/slots/attribution/routeShard）；
4. **q2**：按 carriers/slots 从 6 张 `assets/ui/panel_*.png` LSB 取位→置乱→zlib→
   PV4→F4 碎片→HV5 帧（HMAC+AES/CTR）得隐藏情报（CASE/KEY_MATERIAL/TOTEM/ROUTE_SLOT）；
   其余 2 张是诱饵（migration.txt 提示）；
5. **q3**：`SHA256("CASE|KEY|Mirror"||queueDigest||…全链值)` 解 `cfg/routes.dat`
   （RC5）取 ROUTE_SLOT 指向行，ROT13 域名+反转路径；
6. **q4**：解 `intel/taxonomy.dat`（TX5）得图腾→拉丁名映射，TOTEM 查表 + 证书 O。

**捷径（动态提取，免写 native 协议）**：apktool 注入 smali 日志类直调
q0.protocol/q2.extract/q3.open/q4.attribute 打 logcat；重签会破坏密钥派生——把
`q3.certificateDigest()/certificateWord()` patch 成返回原证书常量
（SHA-256 `56ec3fe2…f77e1`、`"Mirror"`）后可任意签名。apktool 3.0.2 aapt2 在
arm64 崩溃：删 apktool.yml 空 `packageName:` 行 + 外置 aapt2。模拟器开
`hw.adb.secure=0`。

## 决赛实测备忘

- 初赛仅 3 队解出、我方 25 次提交（答案值对但格式错：单层 md5/MP26/CONTACTS_VOICE
  轮番试错）。决赛走本条目应 1 发命中。
- 决赛测试赛未出现此题。

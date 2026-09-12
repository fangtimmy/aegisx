# WEB-03（初赛 WEB-03 · Web · 200 分 · 纯实例题）

无附件、无题面、初赛未解，离线无法预研。决赛现场按下面的**首轮侦察 SOP** 起手，
把侦察结论（指纹/源码泄露点/漏洞类型）回报调度者后再定路线。

## 现场流程（首轮 10 分钟 SOP）

1. `curl -sI http://TARGET/` 看 Server/X-Powered-By 指纹；首页源码通读（注释/备份文件线索）。
2. 目录爆破（**别跳过**，本库 web 题多数有源码/备份泄露）：
   `dirsearch -u http://TARGET/ -x 403,404` 或 feroxbuster；重点字典项：
   `www.zip www.tar.gz backup.zip source.zip web.zip /index.php.bak /.git/ /.svn/ /info.php /phpinfo.php /admin/ /api/`
3. 已知语言/框架 → 对应历史考点：PHP（upload+phar/反序列化/文件包含）、Java（QLExpress/SnakeYAML/反序列化）、
   Python/Flask（SSTI/PIN/session 伪造，参照 ../HardFlask-awdp-fix/SOLVE.md 与 ../WEB-05/SOLVE.md）。
4. 有上传点 → 试 ../WEB-05/SOLVE.md 的 phar 链（黑名单+GIF 头+parse_str 覆盖是本赛事已知出题风格）。
5. 全部无果 → 回报调度者，别单题死磕超过 30 分钟。

## 失败分支

- 侦察 10 分钟无任何指纹/泄露 → 换下一题，这题标记 park，等调度者重排。

## 决赛实测备忘

- 批次二部署；初赛全场未解。

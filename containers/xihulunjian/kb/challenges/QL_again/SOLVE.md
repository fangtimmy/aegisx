# QL_again（初赛 WEB-02 · Web · 300 分 · 动态靶机）

QLExpress 3.3.3 沙箱逃逸。**动态靶机题：flag 在决赛实例上，无离线答案，按本流程现场打。**
核心：`secureMethods={null}` 封死所有方法调用但**不查构造器** → 种 Spring beans XML 落盘
`/tmp/PD9.txt`，再 `new FileSystemXmlApplicationContext(...)` 跑完整 bean 生命周期 →
`ProcessBuilder` init-method=start → RCE。响应只有 success/error（1-bit），决赛离线
无外网 → 用「文件存在性 oracle」逐字符前缀盲提 flag（solve.py 全自动）。

## 现场流程（对决赛靶机 URL 执行）

```bash
WORK=/opt/solver/knowledges/xihulunjian/challenges/QL_again/exp
# TARGET 换成决赛靶机；第 2 参 flag 命令默认 /readflag（按现场改，如 "cat /flag*"）
python3 $WORK/solve.py http://TARGET:8080
# 可选第 3/4 参：flag 前缀（默认 DASCTF{）与字符集（默认 0-9a-fA-F 加 -_}）
```

脚本自动完成：种 daemon XML → 触发 RCE → 自检 → 逐字符盲提，末行 `[+] FLAG : ...`。
只需能连靶机的 python3，全程无外网。

### 本地验证（需 JDK 8）

jar 只能跑 JDK 8（solver 镜像自带 JDK 25，SecurityManager 已移除会崩；Kali apt 无
openjdk-17）。镜像内已装 JDK 8（存在 `/opt/jdk8`）则直接用，否则挂 Temurin 8 JRE
tarball 解出：

```bash
# 宿主机：起本地靶机（附件 jar 预先解到 /tmp/qlprobe/tempdir/WEB附件/inner/）
docker rm -f qlrun
docker run --rm -d --name qlrun -m 4g -p 18080:8080 \
  -v /tmp/qlprobe:/w:ro -v /tmp/temurin8.tar.gz:/opt/t8.tar.gz:ro \
  aegisx/solver:full bash -c "mkdir -p /opt/jdk8 && tar xzf /opt/t8.tar.gz -C /opt/jdk8 --strip-components=1 && cp '/w/tempdir/WEB附件/inner/QL_again.jar' /app.jar && printf '#!/bin/bash\necho DASCTF{5a1e7e5b9c2d}\n' > /readflag && chmod 755 /readflag && /opt/jdk8/bin/java -jar /app.jar > /tmp/app.log 2>&1"
sleep 15 && docker cp $WORK/solve.py qlrun:/tmp/
docker exec qlrun /opt/venv/bin/python3 /tmp/solve.py http://127.0.0.1:8080 /readflag
# 2026-09-11 实测：末行输出 [+] FLAG : DASCTF{5a1e7e5b9c2d}（与假 flag 一致）
```

## 原理（备查）

- 端点 `GET /execute?payload=<b64>`：解码后落盘 `/tmp/<b64前3字符>.txt` 并交
  QLExpress 执行，仅 success 时删文件。文件名由内容决定 → `<?x` 开头 → PD9、
  `#!/bin/bash` 开头 → IyE，两条固定落盘路径。
- 触发表达式 `new org.springframework.context.support.FileSystemXmlApplicationContext(
  "file:///tmp/PD9.txt")`——**路径必须带 `file://` 前缀**：裸 `/tmp/...` 会被 Spring
  getResourceByPath 剥掉首斜杠当作相对 VM 工作目录（`/workspace`）的路径，报
  `FileNotFoundException: tmp/PD9.txt`（初版 exp 卡点；`//tmp/...` 双写亦可）。
- daemon beans XML 必须带 `xsi:schemaLocation`（Spring 从 spring-beans.jar 本地解析
  XSD，无需外网），去掉会 `cvc-elt.1: Cannot find the declaration of element 'beans'`。
- daemon（bash 循环）轮询 `/tmp/IyE.txt` 执行驱动脚本；脚本末行 `rm -f "$0"` 自删
  作为「已消费」信号——由 `new FileInputStream("/tmp/IyE.txt")` oracle 观测，杜绝
  「daemon 事后删文件误删新种脚本」的竞态。
- 盲提 oracle：每个探测脚本先清 `/tmp/MK`、再按 `[[ "$R" == "<前缀><候选>"* ]]` 条件
  建标记，确认脚本已消费后才读 `new FileInputStream("/tmp/MK")`（构造器抛异常 →
  error，存在 → success）→ 标记不可能串轮，逐字符前缀匹配，千余请求分钟级出 flag。
- daemon 重复触发只会多起一个轮询进程，脚本幂等，无害。

## 失败分支

- trigger error 且日志 `FileNotFoundException: tmp/PD9.txt` → 路径没带 `file://`。
- trigger error 且 `cvc-elt.1` → XML 缺 `xsi:schemaLocation`。
- trigger 其它 error → 容器内 `cat /tmp/PD9.txt` 核对落盘 XML 是否完整（约 611 字节）。
- daemon 自检失败 → `docker exec qlrun ps aux | grep 'sleep 0.15'` 查 daemon 是否
  起来；没起来说明 ProcessBuilder 被 SecurityManager 拦（换回初赛实证的 XML 结构）。
- `no candidate extends ...` → 已到末尾或字符集不足：第 4 参传更大字符集重跑
  （如 `'0123456789abcdefghijklmnopqrstuvwxyz-_}'`）。
- 疑心 QL 字符串转义：实证 base64 传参后字符串原样到达，路径正斜杠无需转义。

## 决赛实测备忘

- 初赛 300 分 Web，QLExpress 3.3.3 + Spring（tomcat 内嵌，工作目录 /workspace）。
  初赛 flag（动态，**勿直接提交**）：`DASCTF{23586486279216336138143286856946}`。
- 初赛远端已实证：RCE 后可直接 webhook 回连外带；**决赛离线无外网**，用本 exp 的
  1-bit oracle 盲提（盲提链路 2026-09-11 本地 JDK 8 靶机端到端实测通过）。

# 西湖论剑决赛 all-in-one 镜像

为西湖论剑决赛「客观评测」（复用初赛原题，允许内置知识库）定制的单镜像
appliance：服务端（API + agent 宿主 + Web UI + 调度者）与解题工具链在**同一容器**
（`AEGISX_EXEC_BACKEND=local`）。**决赛沙箱完全离线**：LLM 走平台网关，所有工具、
词表、通用知识库与**逐题解题手册（kb/）**构建期内置，运行时不安装。
赛事主办方的导入/启动/观测说明见 **[ORGANIZER.md](./ORGANIZER.md)**。

## 内置解题知识库（kb/）

初赛题的解题手册（42 条，覆盖 40 个初赛题号；2026-09-10 测试赛上曾另研 20 道
REAL 系列新题，决赛不设新题，已随决赛定式移出 KB），每题一个条目：
`SOLVE.md`（确定性操作手册：快速路径逐步命令 + 预期输出 + 提交规则 + 失败分支）、
`exp/`（自包含可执行脚本）、`meta.json`。**定位键 = 题名 → 附件文件名 → 附件
sha256**（决赛复用初赛题时附件字节不变，题名沿用原始题名——rehearsal 13/13 sha256
对齐实证）。索引 `kb/INDEX.md` 由 `kb/gen-index.py` 从 metas 生成。

flag 政策逐题标注：`static`（exp 复现即得，可先试已知值）/ `dynamic`（打实例取
新值，禁止提交旧值）/ `rotated`（附件同但 flag 已轮换，以 exp 现算为准）。
status：`verified`（exp 实跑输出与已知 flag 一致）/ `authored` / `researched` / `todo`。

## 构建与运行

```sh
# 前置：共享单二进制构建段（containers/app-build）
docker buildx build -f containers/app-build/Dockerfile \
  --platform linux/amd64 -t aegisx/app-build:latest .

# 构建（amd64；构建机需可访问 kali/pypi 镜像与 github）
docker buildx build -f containers/appliance/Dockerfile \
  --platform linux/amd64 --target xihulunjian -t aegisx/xihulunjian:test .

# 运行（决赛接口约定：只注入 4 个接入变量；网关协议与模型已内建镜像）
docker run -d --name aegisx-xihu \
  -p 3000:3000 \
  -v aegisx-xihu-data:/data \
  -e PLATFORM_BASE_URL=<评测平台地址> \
  -e PLATFORM_ACCESS_KEY=<平台AccessKey> \
  -e LLM_BASE_URL=<LLM网关完整端点> \
  -e LLM_API_KEY=<网关key> \
  aegisx/xihulunjian:test
```

内建默认（镜像 ENV，无需设置）：平台 `dasctf`；网关 `openai-responses` + exact-endpoint
（URL 即完整端点）；模型 `deepseek-flash`（profile `deepseek/deepseek-v4-flash-vision-exp`、
effort `high`）。换模型/协议时用 `AEGISX_MODEL_ID` / `AEGISX_MODEL_PROFILE` /
`AEGISX_PROVIDER_TYPE` 等覆盖；同名取值契约变量（`LLM_*`/`PLATFORM_*`）优先于 `AEGISX_*`。

事件名默认 `xihulunjian-finals`（镜像 ENV，可用 `AEGISX_EVENT_NAME` 覆盖）——
bootstrap 绑定平台时的事件名默认值是 tsecbench 的名字，这里显式钉住。

启动后 Bootstrap 自动执行：provider/模型 → 读取 preset → 建赛事（DASCTF 平台简报
+ 调度策略）→ 拉题 → 启动调度者。**升级镜像请用全新 /data 卷**（内置提示词模板
行是「已存在则不覆盖」语义）。

## 调优注入：preset（`/opt/aegisx-preset/preset.json`）

与 tsecbench 相同的结构化部署清单（`brief` 按 common/solver/orchestrator 读者
分区 + `flagFormats` + `offline` + `settings` + `scheduler`，bootstrap 首启落库）。
本清单的 DASCTF 特调要点：

| 项 | 值 | 依据 |
|---|---|---|
| `brief.solver`·KB 机械首步 | 题名/sha256 查 INDEX → 命中走 SOLVE.md | rehearsal 连续两场知识库工具零调用；KB 命中题必须走捷径 |
| `brief.solver`·提交纪律 | 自洽验证后提交；裸值优先；两形态各一次即止损升级 | 每题 50 次预算（实测）；WEB-01 DASCTF{} 被拒裸值接受的实证；Rvmecisp 38 次与 HardFlask 4 次止损的正反案例 |
| `brief.solver`·靶机 | 异步拉起轮询、expireTime 过期 | rehearsal 实测（what_heap 初始未就绪） |
| `brief.common`·限流 | 平台 API 429 退避 | rehearsal 实测（启动期 10 次 429） |
| `brief.orchestrator`·反幻觉 | 无提交计数 API，以 flag 事件流为准 | rehearsal 调度者「提交计数 5→9」纯幻觉引发误报警告 |
| `brief.orchestrator`·调度 | 同题无进展降级/park；KB 题先收割 | wish 9 连 spawn 约 800 agent 分钟 0 提交的教训 |
| `flagFormats` | `DASCTF{...}` | 平台格式 |
| `defaultRunTimeoutMs` | 60min | rehearsal 120min 偏松（wish 沉没 31% 墙钟）；KB 快题本就不该吃满 |
| `maxConcurrentAgents` | 5 | 沙箱 8 核量级假设（同 tsecbench 托管），决赛资源细则若不同再调 |
| `maxConcurrentTargets` | 3 | rehearsal 实测事件级 3 槽 |
| `stopSubmitterOnSolve` | true | 评测只看 flag，解出即停 |

## 与 tsecbench 镜像的差异

同一阶梯（`containers/appliance/Dockerfile`）上的兄弟 target，共享工具链与
app 产物（`aegisx/app-build`），差异全部在 target 专属层：

- 内置 `kb/`（`COPY containers/appliance/xihulunjian/kb → /opt/solver/knowledges/xihulunjian`）；
- preset 换为 DASCTF 决赛部署清单（brief 含 KB 首步指令与提交纪律）；
- `VARIANT=xihulunjian`，`AEGISX_EVENT_NAME=xihulunjian-finals`；
- 额外工具：legacy JDK 8（SecurityManager 类 jar 靶机）、libzbar0/pyzbar
  （QR 杂项）、cysignals/fpylll（格密码）。

## 镜像内布局

| 路径 | 内容 |
|---|---|
| `/opt/aegisx/aegisx` | 服务端单可执行文件（bun `--compile` 产物，内嵌 Web SPA 与基线迁移） |
| `/opt/aegisx-sdk/` | Python SDK（PYTHONPATH 已设） |
| `/opt/aegisx-preset/preset.json` | 决赛调优预设（bootstrap 首启应用） |
| `/opt/solver/knowledges/xihulunjian/` | **逐题解题手册**（INDEX.md + challenges/） |
| `/opt/solver/knowledges/` | 通用知识库（PayloadsAllTheThings 等，同 tsecbench） |
| `/usr/share/nuclei-templates` | nuclei 离线模板（`~/nuclei-templates` symlink 指向） |
| `/data` | 数据卷（SQLite、config.json、工作区） |

## 交付（分发）

镜像体积：未压缩 5.05GB，gzip 压缩后 **1.85GB**（2026-09-14 复测于 `:test`，与 tsecbench 同在 3GB 量级以内）。

交付 tag 用日期命名（与交付文件名一致）：先重打 tag 再导出——tar 内嵌的
RepoTags 决定 `docker load` 后的镜像名。

```sh
docker tag aegisx/xihulunjian:test aegisx/xihulunjian:<日期>
docker save aegisx/xihulunjian:<日期> | gzip > /tmp/aegisx-xihulunjian-<日期>.tar.gz
shasum -a 256 /tmp/aegisx-xihulunjian-<日期>.tar.gz   # 上传前记录，平台侧核对
```

主办方侧的导入/启动说明见 [ORGANIZER.md](./ORGANIZER.md)（`docker load` 直接支持 .tar.gz）。

## 出厂自检

```sh
docker run --rm --platform linux/amd64 --entrypoint /bin/bash aegisx/xihulunjian:test -c '
  set -e
  python3 -c "import aegisx"
  python3 -c "import pwn, z3, capstone, angr, PIL, flask_unsign"
  command -v sqlite3 jdb flask-unsign fd nuclei chisel whatweb searchsploit ghidra-analyze
  test -x /usr/bin/time
  test -s /opt/solver/knowledges/xihulunjian/INDEX.md
  grep -c "西湖论剑" /opt/solver/knowledges/xihulunjian/INDEX.md
  python3 /opt/solver/knowledges/xihulunjian/challenges/gogogo_3/exp/solve.py
  echo SELF-CHECK OK'
```

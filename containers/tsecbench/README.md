# TSecBench all-in-one 镜像

为 TSecBench 断网评测定制的单镜像 appliance：服务端（API + agent 宿主 + Web UI + 调度者）
与解题工具链在**同一容器**（`AEGISX_EXEC_BACKEND=local`，solver bash 就在本容器内执行）。
**完全离线**：除平台 VPN 外无任何网络，所有工具/词表/知识库/调优在构建期内置，运行时不安装。

## 构建与运行

```sh
# 构建（amd64；构建机需可访问 kali/pypi 镜像与 github）
docker buildx build -f containers/tsecbench/Dockerfile \
  --platform linux/amd64 -t aegisx/tsecbench:v11 .

# 运行（tsec-vpn 为常驻 VPN 容器——本地模式专用，用于连接靶机网段；托管模式不需要
# VPN。LLM/平台凭据走环境变量——仅运行时密钥走 env，所有策略/提示词调优通过 preset
# 在首启时落库）
docker run -d --name aegisx-tsec \
  --network container:tsec-vpn \
  -v aegisx-tsec-data:/data \
  -e AEGISX_PROVIDER_BASE_URL=https://api.deepseek.com/v1 \
  -e AEGISX_PROVIDER_TYPE=openai-responses \
  -e AEGISX_PROVIDER_API_KEY=sk-... \
  -e AEGISX_MODEL_ID=deepseek-v4.1-flash-expires-on-0910 \
  -e AEGISX_MODEL_EFFORT=high \
  -e AEGISX_EVENT_NAME=tsec-full \
  -e AEGISX_PLATFORM_TYPE=tsecbench \
  -e AEGISX_PLATFORM_BASE_URL=https://tsecbench.zc.tencent.com \
  -e AEGISX_PLATFORM_CREDENTIAL=<BENCHMARK_TOKEN> \
  aegisx/tsecbench:v11

# TSecBench 托管环境兼容：harness 注入的 BENCHMARK_BASE_URL / BENCHMARK_TOKEN
# 可直接替代 AEGISX_PLATFORM_BASE_URL / AEGISX_PLATFORM_CREDENTIAL
# （平台类型自动判为 tsecbench；AEGISX_* 显式给出时优先）。
```

非内置目录模型（如 glm-5.3-flash 这类网关变体 id）的元数据由 bootstrap 保守兜底；
`AEGISX_MODEL_EFFORT` 会推断 `reasoning:true` 使思考档位生效。更好的做法是绑定
同家族的内置目录条目（含 compat 行为）：

```sh
-e AEGISX_MODEL_PROFILE=zai/glm-5.3   # 继承 ctx=1M / maxTokens=131k / zai compat
```

个别字段再微调用 `AEGISX_MODEL_METADATA` 逐字段合并（schema 同设置页，如
`{"maxTokens":65536}`）。优先级：metadata 字段 > profile 绑定 > 内置目录按
model id 匹配 > 保守默认值。

镜像体积：未压缩 4.75GB，gzip 压缩后 **1.81GB**（上限 3GB）。

环境变量完整清单见 [docs/env.md](../../docs/env.md)。

启动后 Bootstrap 自动执行：provider/模型 → 读取 preset → 建赛事（带 TSecBench 平台
提示词与调度策略）→ 拉题 → 启动调度者（由调度者按策略逐题简报并入队）。

> 注意 `--network container:tsec-vpn` 模式下端口映射不生效——需要另配或改用
> host network + 路由。评测场景建议 Web UI 经 SSH 隧道访问，或临时启动独立容器查看。
>
> **升级镜像请用全新 /data 卷**：内置提示词模板行是「已存在则不覆盖」语义，
> 旧卷会保住旧版本模板，新镜像的提示词更新不会生效。

## 托管在线评测（操作手册）

平台在受控沙箱里拉起镜像并自动运行，**沙箱无法访问公网**——大模型与答题 API 都走
平台网关。**托管模式不需要 VPN**：靶机与答题 API 均由平台内网提供，沙箱直接可达；
VPN（tsec-vpn + 任务 ovpn）只在本地模式需要，用途是连接靶机网段。契约以平台
「接入指引」为准，本节是经实测校准的操作步骤。

**0) 前置**：先在本地模式完整跑通（上一节），平台也明确要求托管前先完成本地评测。

**1) 导出并上传镜像**（平台「制作并上传 Docker 镜像」步骤）：

```sh
docker buildx build -f containers/tsecbench/Dockerfile \
  --platform linux/amd64 -t aegisx/tsecbench:vN .
docker save aegisx/tsecbench:vN | gzip > /tmp/aegisx-tsecbench-vN.tar.gz
shasum -a 256 /tmp/aegisx-tsecbench-vN.tar.gz   # 上传前记录，平台侧核对
```

接受 `.tar / .tar.gz / .tgz`，上限 3GB（本镜像 gzip 后约 1.8GB）。传错版本的
tarball 及时删除，避免同 tag 多份产物混淆。

**2) 配置「运行时环境变量」**（页面第 3 步，逐条添加；`BENCHMARK_BASE_URL` /
`BENCHMARK_TOKEN` 由平台自动注入，**不要手动填**）：

```sh
AEGISX_PROVIDER_BASE_URL = http://open.bigmodel.cn.tsecbench.gw/api/coding/paas/v4
AEGISX_PROVIDER_TYPE     = openai-compatible
AEGISX_PROVIDER_API_KEY  = <智谱 key>
AEGISX_MODEL_ID          = glm-5.3-flash
AEGISX_MODEL_EFFORT      = high
AEGISX_MODEL_PROFILE     = zai-coding-cn/glm-5.3-flash
```

规则与原因：

- LLM 地址**必须**是网关形态：原域名加 `.tsecbench.gw` 后缀、`https` 改 `http`
  （沙箱无公网，公网地址不可达；`open.bigmodel.cn` 在平台白名单内）。
- `AEGISX_MODEL_PROFILE` 必填：目录里有 4 个 provider 同名 `glm-5.3-flash`，
  自动按 id 匹配会命中 `opencode/` 的泛化条目（无思考控制 compat，effort 静默
  失效）；显式绑定智谱条目才拿到完整 zai compat 与真实计价。
- 赛事名不用填：配置了平台时自动派生为 `tsecbench`（v11 起；v9/v10 会因缺失
  赛事名**静默跳过**全部 bootstrap，日志只有 preset 一行——直接作废，勿用）。

**3) 提交并观察**：提交后进运行队列，平台「部署 / 运行日志」实时可看。正常启动
的时间线依次为：`Started development server` → `preset settings applied` →
`platform bound` → `challenges synced` → `scheduler started` → 随后是 agent 与
flag 的逐条日志（`agent.started` / `agent.finished` 带 `durSec`、
`flag: rejected`、`queue: enqueued` 带 `promptLen`）。若停在 preset 之后不动，
按 v9/v10 教训先核对镜像版本与环境变量。

**平台契约备忘**：8核16G 资源、360min 时限、沙箱一次性（结束即销毁）、
运行期流量与对话记录被审计；Agent 不得内置针对题目的历史记忆（作弊处置）。

## 调优注入：preset（`/opt/aegisx-preset/preset.json`）

调优以 **JSON 数据**随镜像分发，bootstrap 首启时读取并落库（v5 及以前是构建期
sed 改写源码——那种方式把提示词文本硬编码在 Dockerfile 里，已废弃）：

```json
{
  "promptHint": "平台：TSecBench。flag 格式恒为 flag{<uuid>}（f2 系列为 FLAG{...}）……",
  "settings": { "scheduler.defaultRunTimeoutMs": 2700000, "scheduler.maxConcurrentAgents": 5 },
  "scheduler": { "maxConcurrentTargets": 3, "stopSubmitterOnSolve": true }
}
```

| 项 | 值 | 依据 |
|---|---|---|
| 赛事 `promptHint` | TSecBench 平台简报：flag 格式、category=难度、**6 小时总时长与截止感知**、**按难度分档的首轮预算（≥30/45/60min）**、靶机不过期、409=等槽退避（含满槽时撤链让位）、离线禁装包、**扫描限定靶机地址** | 68 个 accepted flag 格式恒定；230 次 409；实测出现过扫宿主内网的偏航；预算依据见下行 |
| `scheduler.defaultRunTimeoutMs` | 45min | **兜底而非分配**：最好一轮（89.8%）用 45min 档，208 个 agent 只有 4 个真正触到 deadline，解题中位耗时 1–2min——给足几乎不花钱。改成 10–15min「快题预算」的那一轮，c-03/c-05/c-09 全部在临界点被截断（超时只把 agent 转 idle，重开新 agent 反而丢掉上下文） |
| `scheduler.maxConcurrentAgents` | 5 | 托管沙箱 8核16G；靶机槽 3 必然占满后，剩余 2 个 agent 槽供编排者在已占靶机上做同题多角度分工（上轮实测有效） |
| `maxConcurrentTargets` | 3 | 平台实例硬上限 |
| `stopSubmitterOnSolve` | true | 评测只看 flag，完全解出即停（省 5% 成本 + 2.9 agent-h） |

应用语义（`apps/server/src/bootstrap.ts`）：settings 按漂移收敛（值变了才写）；
promptHint 在建赛事时写入、已非空则不覆盖；scheduler 策略仅首建时应用。
preset 文件缺失或损坏只记日志跳过，服务器照常启动。

## 工具集（实测驱动）

- **系统**：curl/wget/binutils/gdb/strace/ltrace/rg/fd/jq/yq/bc/zip/unzip/7z/unrar、
  netcat/ncat/socat/sshpass/ftp/telnet、dnsutils/iproute2/net-tools/sqlite3/time
- **Web**：nmap/masscan/ffuf/gobuster/feroxbuster/dirsearch/wfuzz/sqlmap/hydra/nikto、
  php-cli(+mysql/curl/xml)、default-mysql-client
- **已知产品攻击**（五方 run 数据驱动）：nuclei + 1.3 万离线模板
  （CVE/暴露面板/默认口令，`/usr/share/nuclei-templates`，`~/nuclei-templates`
  已 symlink 供 nuclei 自动发现）、chisel（内网隧道）、whatweb（指纹）、
  **exploitdb/searchsploit**（v7 恢复）
- **Rev/Pwn**：radare2/binwalk/upx/checksec/qemu-user（x86/i386/arm/aarch64/mips/mipsel
  六个模拟器）、openjdk-21（jdb 调试附加）、**ghidra + ghidra-analyze**（v7 恢复，
  自定义 VM 二进制的 headless 反编译路径）、venv: pwntools/z3/capstone/pyelftools/scapy/angr
- **补充缺口**（本轮实测缺失）：`telnetlib3`（py3.13 移除了 telnetlib）、
  `gradio_client`/`websockets`/`pyyaml`/`aiohttp`/`pymysql`（AI 服务与 YAML 解析）、
  `Pillow`（图像处理，OCR/隐写配套）、`flask-unsign[wordlist]`（Flask session 伪造——
  b-03 的解题路径曾靠运行时联网 pip 安装，断网下必须预装）、
  `/usr/bin/time`、`sqlite3`、`fd` 别名、词表别名（`directory-list-2.3-*`、
  `10-million-password-list-top-*`）
- **词表**：seclists 的 Discovery/Web-Content **全目录** + 常用口令子集 +
  Keyboard-Walks + rockyou + dirb
- **知识库**：PayloadsAllTheThings / InternalAllTheThings / hacktricks /
  hacktricks-cloud（均已剥离图片，保留 markdown 正文）
  （libc-database 离线不可用、vulhub 需拉镜像——均不装）

## 镜像内布局

| 路径 | 内容 |
|---|---|
| `/opt/aegisx/server/dist/` | bun bundle + minify 后的服务端单文件 |
| `/opt/aegisx/drizzle/` | 迁移文件（bundle 以 `../../drizzle` 相对解析，布局不可改） |
| `/opt/aegisx-web/` | Web 静态产物 |
| `/opt/aegisx-sdk/` | Python SDK（PYTHONPATH 已设） |
| `/opt/aegisx-preset/preset.json` | TSecBench 调优预设（bootstrap 首启应用） |
| `/opt/solver/` | ENVIRONMENT.md（已离线化）/ knowledges / VARIANT |
| `/usr/share/nuclei-templates` | nuclei 离线模板（`~/nuclei-templates` symlink 指向） |
| `/data` | 数据卷（SQLite、config.json、工作区） |

## 出厂自检

`import aegisx` 必须在**不手动设 PYTHONPATH** 的前提下通过——v4 曾因缺失这一项
（local backend 的 bash 继承 server 进程 env）导致全部 agent 的 SDK 调用失败：

```sh
docker run --rm --platform linux/amd64 --entrypoint /bin/bash aegisx/tsecbench:v11 -c '
  set -e
  python3 -c "import aegisx"
  python3 -c "import pwn, z3, capstone, angr, PIL, flask_unsign"
  command -v sqlite3 jdb flask-unsign fd nuclei chisel whatweb searchsploit ghidra-analyze
  test -x /usr/bin/time
  test -d /root/nuclei-templates/http/cves
  test -f /opt/aegisx-preset/preset.json
  grep -c TSecBench /opt/aegisx/server/dist/index.js
  echo SELF-CHECK OK'
```

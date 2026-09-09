# TSecBench all-in-one 镜像

为 TSecBench 断网评测定制的单镜像 appliance：服务端（API + agent 宿主 + Web UI + 调度者）
与解题工具链在**同一容器**（`AEGISX_EXEC_BACKEND=local`，solver bash 就在本容器内执行）。
**完全离线**：除平台 VPN 外无任何网络，所有工具/词表/知识库/调优在构建期内置，运行时不安装。

## 构建与运行

```sh
# 构建（amd64；构建机需可访问 kali/pypi 镜像与 github）
docker buildx build -f containers/tsecbench/Dockerfile \
  --platform linux/amd64 -t aegisx/tsecbench:v7 .

# 运行（tsec-vpn 为常驻 VPN 容器；LLM/平台凭据走环境变量——仅运行时密钥走 env，
# 所有策略/提示词调优通过 preset 在首启时落库）
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
  aegisx/tsecbench:v7

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

启动后 Bootstrap 自动执行：provider/模型 → 读取 preset → 建赛事（带 TSecBench 平台
提示词与调度策略）→ 拉题 → 启动调度者（由调度者按策略逐题简报并入队）。

> 注意 `--network container:tsec-vpn` 模式下端口映射不生效——需要另配或改用
> host network + 路由。评测场景建议 Web UI 经 SSH 隧道访问，或临时启动独立容器查看。
>
> **升级镜像请用全新 /data 卷**：内置提示词模板行是「已存在则不覆盖」语义，
> 旧卷会保住旧版本模板，新镜像的提示词更新不会生效。

## 调优注入：preset（`/opt/aegisx-preset/preset.json`）

调优以 **JSON 数据**随镜像分发，bootstrap 首启时读取并落库（v5 及以前是构建期
sed 改写源码——那种方式把提示词文本硬编码在 Dockerfile 里，已废弃）：

```json
{
  "promptHint": "平台：TSecBench。flag 格式恒为 flag{<uuid>}（f2 系列为 FLAG{...}）……",
  "settings": { "scheduler.defaultRunTimeoutMs": 1800000 },
  "scheduler": { "maxConcurrentTargets": 3, "stopSubmitterOnSolve": true }
}
```

| 项 | 值 | 依据 |
|---|---|---|
| 赛事 `promptHint` | TSecBench 平台简报：flag 格式、category=难度、**6 小时总时长与截止感知**、靶机不过期、409=等槽退避、离线禁装包、**扫描限定靶机地址** | 68 个 accepted flag 格式恒定；230 次 409；实测出现过扫宿主内网的偏航 |
| `scheduler.defaultRunTimeoutMs` | 30min | 59 题中位 1.8min 解出、agent 有效工作 p90≈20min；编排者仍按难度逐 spawn 覆盖（10-15/30-45/60-90min） |
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
| `/opt/aegisx/server/dist/` | bun bundle 后的服务端（13MB 单文件） |
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
docker run --rm --platform linux/amd64 --entrypoint /bin/bash aegisx/tsecbench:v7 -c '
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

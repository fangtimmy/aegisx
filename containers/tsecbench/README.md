# TSecBench all-in-one 镜像

为 TSecBench 断网评测定制的单镜像 appliance：服务端（API + agent 宿主 + Web UI + 调度者）
与解题工具链在**同一容器**（`AEGISX_EXEC_BACKEND=local`，solver bash 就在本容器内执行）。
**完全离线**：除平台 VPN 外无任何网络，所有工具/词表/知识库在构建期内置，运行时不安装。

## 构建与运行

```sh
# 构建（amd64；构建机需可访问 kali/pypi 镜像与 github）
docker buildx build -f containers/tsecbench/Dockerfile \
  --platform linux/amd64 -t aegisx/tsecbench:v6 .

# 运行（tsec-vpn 为常驻 VPN 容器；LLM/平台凭据走环境变量——仅运行时密钥走 env，
# 所有策略/提示词调优已烘焙进镜像）
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
  aegisx/tsecbench:v6
```

镜像体积：未压缩 3.06GB，gzip 压缩后 **965MB**。

启动后 Bootstrap 自动执行：provider/模型 → 建赛事（带 TSecBench 平台提示词）→ 拉题 →
启动调度者并为全部题目入队（`AEGISX_ENQUEUE_ALL=1` 已内置）。

> 注意 `--network container:tsec-vpn` 模式下端口映射不生效——需要另配或改用
> host network + 路由。评测场景建议 Web UI 经 SSH 隧道访问，或临时启动独立容器查看。

## 烘焙进镜像的调优（tuning.sed）

构建期对三处源码改写后打包（无 env、无运行时注入）：

| 项 | 值 | 依据（2026-09-08 全量跑） |
|---|---|---|
| 赛事 `promptHint` | TSecBench 平台简报：flag 格式 `flag{uuid}`、category=难度、靶机不过期、409=等槽退避、离线禁装包 | 68 个 accepted flag 格式恒定；230 次 409；c-07 telnetlib 缺失 |
| `maxConcurrentTargets` 默认 | 3 | 平台实例硬上限 |
| `stopSubmitterOnSolve` 默认 | true | 评测只看 flag，完全解出即停（省 5% 成本 + 2.9 agent-h） |
| 默认任务超时 | 30min | 59 题中位 1.8min 解出、agent 有效工作 p90≈20min；编排者仍按难度逐 spawn 覆盖（10-15/30-45/60-90min） |

## 工具集（实测驱动）

只装 2026-09-08 全量跑（4601 条 bash 命令）实际调用过的工具；通用档里零调用的
playwright/wine/ghidra/AD 套件/hashcat/impacket 等全部不装。

- **系统**：curl/wget/binutils/gdb/strace/ltrace/rg/fd/jq/yq/bc/zip/unzip/7z/unrar、
  netcat/ncat/socat/sshpass/ftp/telnet、dnsutils/iproute2/net-tools
- **Web**：nmap/masscan/ffuf/gobuster/feroxbuster/dirsearch/wfuzz/sqlmap/hydra/nikto、
  php-cli(+mysql/curl/xml)、default-mysql-client
- **已知产品攻击**（v6，五方 run 数据驱动）：nuclei + 1.3 万离线模板
  （CVE/暴露面板/默认口令，`/usr/share/nuclei-templates`，`~/nuclei-templates`
  已 symlink 供 nuclei 自动发现）、chisel（内网隧道）、whatweb（指纹）
- **Rev/Pwn**：radare2/binwalk/upx/checksec/qemu-user（x86/i386/arm/aarch64/mips/mipsel
  六个模拟器）、openjdk-21（jdb 调试附加）、venv: pwntools/z3/capstone/pyelftools/scapy/**angr**
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

**体积 vs 覆盖的取舍**（硬指标 <1GB）：exploitdb/searchsploit（10 次
调用，约 +200MB 压缩）与 ghidra（5 次，约 +400MB）未内置——离线环境无法补装，
ENVIRONMENT.md 已注明缺工具时换技术路线。若被证明关键，在 Dockerfile 恢复对应行重建。

## 镜像内布局

| 路径 | 内容 |
|---|---|
| `/opt/aegisx/server/dist/` | bun bundle 后的服务端（13MB 单文件） |
| `/opt/aegisx/drizzle/` | 迁移文件（bundle 以 `../../drizzle` 相对解析，布局不可改） |
| `/opt/aegisx-web/` | Web 静态产物 |
| `/opt/aegisx-sdk/` | Python SDK（PYTHONPATH 已设） |
| `/opt/solver/` | ENVIRONMENT.md（已离线化）/ knowledges / VARIANT |
| `/data` | 数据卷（SQLite、config.json、工作区） |

## 出厂自检

`import aegisx` 必须在**不手动设 PYTHONPATH** 的前提下通过——v4 曾因缺失这一项
（local backend 的 bash 继承 server 进程 env）导致全部 agent 的 SDK 调用失败：

```sh
docker run --rm --platform linux/amd64 --entrypoint /bin/bash aegisx/tsecbench:v6 -c '
  set -e
  python3 -c "import aegisx"
  python3 -c "import pwn, z3, capstone, angr, PIL, flask_unsign"
  command -v sqlite3 jdb flask-unsign fd nuclei chisel whatweb
  test -x /usr/bin/time
  test -s /root/nuclei-templates/http/cves/cves.json || test -d /root/nuclei-templates/http/cves
  grep -c TSecBench /opt/aegisx/server/dist/index.js
  echo SELF-CHECK OK'
```

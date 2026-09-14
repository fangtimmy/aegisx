# AegisX 评测镜像 · 启动与使用说明

本说明面向赛事评测工作人员，介绍如何导入、启动、观测与停止 AegisX 自动化作答镜像。镜像按赛事规则允许的范围内置了离线知识库；运行期仅访问两个外部地址：赛事指定 LLM 网关与评测平台，此外无任何外联。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| 架构 / 系统 | linux/amd64，任意可运行 Docker 的 Linux 宿主 |
| Docker | ≥ 24（`docker load` / `docker run` 即可，无需 compose） |
| CPU / 内存 | ≥ 8 vCPU / 16 GB |
| 磁盘 | ≥ 30 GB（镜像约 6 GB，长赛事建议 50 GB） |
| 网络 | 仅需可达：LLM 网关、评测平台 |

## 2. 导入与启动

```bash
# <版本> = 交付日期 tag（如 20260914），与交付文件名一致
docker load -i aegisx-xihulunjian-<版本>.tar.gz

docker run -d --name aegisx-eval \
  --platform linux/amd64 \
  -p 3000:3000 \
  -v aegisx-eval-data:/data \
  --env-file aegisx.env \
  aegisx/xihulunjian:<版本>
```

其中 `aegisx.env` 由赛事方按网关与平台信息填写（见下表）。

### 环境变量

| 变量 | 必填 | 填什么 |
|---|---|---|
| `AEGISX_PROVIDER_BASE_URL` | ✅ | LLM 网关地址 |
| `AEGISX_PROVIDER_TYPE` | ✅ | 网关协议：`openai-responses` / `openai-compatible` / `anthropic-messages` |
| `AEGISX_PROVIDER_API_KEY` | ✅ | 网关 key |
| `AEGISX_MODEL_ID` | ✅ | 模型 id（按网关注册名） |
| `AEGISX_PROVIDER_EXACT_ENDPOINT` | 视网关 | 网关地址本身已是完整端点时设 `1`（否则无法连通，典型如 DASCTF 网关） |
| `AEGISX_MODEL_PROFILE` | 视网关 | 网关模型为变体名时，由镜像提供方给出对应取值（见下方示例） |
| `AEGISX_PLATFORM_TYPE` | ✅ | `dasctf` |
| `AEGISX_PLATFORM_BASE_URL` | ✅ | 评测平台地址 |
| `AEGISX_PLATFORM_CREDENTIAL` | ✅ | 评测平台 AccessKey |

**DASCTF 网关（deepseek-flash）填写示例**：

```text
AEGISX_PROVIDER_TYPE=openai-responses
AEGISX_PROVIDER_EXACT_ENDPOINT=1
AEGISX_MODEL_ID=deepseek-flash
AEGISX_MODEL_PROFILE=deepseek/deepseek-v4-flash-vision-exp
```

其余变量均有默认值，无需设置。

## 3. 启动后会发生什么

- 启动后约 1-2 分钟完成自动装配，随后开始自动作答并提交，全程无需人工干预。
- 装配期拉题遇到平台限流（429）会自动退避重试并补拉；若日志出现 `challenges INCOMPLETE`，表示个别题目多轮补拉仍未成功（通常是平台侧已下架）——重启容器即自动补拉缺失题，其余题目照常作答。
- 进程或宿主重启后自动恢复现场继续运行。
- 评测全程的提交记录与会话内容可在 Web UI 实时查看，同时完整落盘在 `/data` 数据卷中备查。

## 4. Web UI 使用教程

浏览器打开 **`http://<宿主IP>:3000`**（无需登录，仅限评测内网访问）。页面实时刷新，无需手动操作。

### 4.1 首页

点击赛事卡片进入工作台。

### 4.2 工作台页签

| 页签 | 用途 |
|---|---|
| **概览** | 确认系统装配与运行状态 |
| **任务** | 查看作答队列与进度 |
| **Agents** | 查看每个作答单元的实时工作内容；也可在此给总控发指令 |
| **题目** | 每题状态与 **flag 提交流水（值 + 平台判定 + 时间）** |
| **统计** | 提交 / 通过数量汇总 |
| **设置** | 暂停 / 恢复运行等维护操作 |

### 4.3 常用操作

- **暂停 / 恢复**：「设置」页签中操作，均为可逆，排队任务保留。
- **调整作答策略**：在「Agents」页签的总控会话中直接发送文字指令即可（例如「停止投入 X 题」）。
- **核查某题提交**：「题目」页签点开对应题目，逐条查看提交值与平台返回的判定原文。

## 5. 生命周期

| 操作 | 命令 / 行为 |
|---|---|
| 停止 | `docker stop aegisx-eval` |
| 续跑 | `docker start aegisx-eval`（原样恢复） |
| 数据归档 | `docker run --rm -v aegisx-eval-data:/data alpine tar czf - /data > eval-archive.tar.gz` |
| 全新一轮评测 | **必须换全新数据卷**（如 `-v aegisx-eval-data2:/data`） |
| 彻底清理 | `docker rm -f aegisx-eval && docker volume rm aegisx-eval-data` |

## 6. 安全边界

- Web 页面**无登录**：3000 端口仅发布在评测内网，不要暴露公网。
- 运行不需要特权模式，不挂载 docker socket；可按需用防火墙把容器出网限制到 LLM 网关与评测平台两个地址。

## 7. 出厂自检（可选）

```bash
docker run --rm --platform linux/amd64 --entrypoint /bin/bash \
  aegisx/xihulunjian:<版本> -c '
  set -e
  python3 -c "import aegisx"
  python3 -c "import pwn, z3, capstone, angr, PIL, flask_unsign"
  command -v sqlite3 jdb flask-unsign fd nuclei chisel whatweb searchsploit ghidra-analyze
  test -s /opt/solver/knowledges/xihulunjian/INDEX.md
  grep -c "西湖论剑" /opt/solver/knowledges/xihulunjian/INDEX.md
  echo SELF-CHECK OK'
```

## 8. FAQ

- **页面/接口一直 404 或网关不通？** 多为网关为「完整端点」型而未设 `AEGISX_PROVIDER_EXACT_ENDPOINT=1`，补设后 `docker restart aegisx-eval`。
- **平台返回 429？** 平台限流，系统会自动重试，无需处理；若日志出现 `challenges INCOMPLETE`，重启容器即会自动补拉缺失题。
- **提交显示「此题已被解出」？** 平台对已判分题目的固定应答，系统不会重试、不消耗提交预算。
- **想更换模型或网关？** 停止容器，换全新数据卷并以新环境变量启动。

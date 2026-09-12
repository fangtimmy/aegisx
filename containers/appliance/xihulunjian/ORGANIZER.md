# AegisX 评测镜像 · 启动与使用说明（面向赛事主办方）

本文面向负责**客观评测**（allow-list 内置知识库的自动化作答评测）的工作人员，说明如何导入、启动、观测与停止 AegisX 单镜像 appliance。镜像内部结构与研发侧细节见 `README.md`（研发向）。

## 1. 镜像是什么

单个 Docker 容器内含完整作答系统：服务端（API + agent 宿主 + Web UI + 调度者）、CTF 解题工具链（Kali 层）与**内置逐题解题知识库**。启动后无人值守运行：自动装配 → 绑定评测平台拉题 → 调度者编排解题 agent 作答并提交 flag。

**网络边界（评测合规要点）**：镜像运行期只访问两类外部地址——

1. 赛事指定的 LLM 网关（模型推理）；
2. 评测平台 API（拉题、拉靶机、提交 flag）。

除此之外**无任何外联**：不装包（离线工具链）、不更新、不上传遥测。解题工具全部在容器内执行（单容器模式，无需挂载 docker socket）。

## 2. 环境要求

| 项 | 要求 |
|---|---|
| 架构 / 系统 | linux/amd64，任意可运行 Docker 的 Linux 宿主 |
| Docker | ≥ 24（`docker load` / `docker run` 即可，无需 compose） |
| CPU / 内存 | ≥ 8 vCPU / 16 GB（镜像内并发上限已按 8 核量级配置） |
| 磁盘 | ≥ 30 GB（镜像 ~6 GB + 数据卷增长空间，长赛事建议 50 GB） |
| 网络 | 仅需可达：LLM 网关、评测平台 |

## 3. 导入与启动

```bash
# 导入镜像（交付物为 docker save 导出的 tar）
docker load -i aegisx-xihulunjian-<版本>.tar

docker run -d --name aegisx-eval \
  --platform linux/amd64 \
  -p 3000:3000 \
  -v aegisx-eval-data:/data \
  -e AEGISX_PROVIDER_BASE_URL=<赛事 LLM 网关地址> \
  -e AEGISX_PROVIDER_TYPE=openai-responses \
  -e AEGISX_PROVIDER_API_KEY=<网关 key> \
  -e AEGISX_MODEL_ID=<模型 id> \
  -e AEGISX_PLATFORM_TYPE=dasctf \
  -e AEGISX_PLATFORM_BASE_URL=<评测平台地址> \
  -e AEGISX_PLATFORM_CREDENTIAL=<平台 AccessKey> \
  aegisx/xihulunjian:<版本>
```

### 环境变量说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `AEGISX_PROVIDER_BASE_URL` | ✅ | LLM 网关地址（http/https） |
| `AEGISX_PROVIDER_TYPE` | ✅ | 按网关协议：`openai-responses` / `openai-compatible` / `anthropic-messages` |
| `AEGISX_PROVIDER_EXACT_ENDPOINT` | 视网关 | 设 `1` 表示网关地址**本身即完整端点**、不要再拼 `/chat/completions` 等路径（DASCTF LLM 网关属此类，漏设会全部 404） |
| `AEGISX_PROVIDER_API_KEY` | ✅ | 网关鉴权 key |
| `AEGISX_MODEL_ID` | ✅ | 模型 id（按网关注册名） |
| `AEGISX_MODEL_METADATA` | 建议 | 模型元数据 JSON（`contextWindow`/`maxTokens` 等）；网关模型是变体名时由赛事方提供，缺失时系统按保守推断运行 |
| `AEGISX_PLATFORM_TYPE` | ✅ | `dasctf`（西湖论剑评测平台） |
| `AEGISX_PLATFORM_BASE_URL` | ✅ | 评测平台地址 |
| `AEGISX_PLATFORM_CREDENTIAL` | ✅ | 平台 AccessKey |

其余变量均有出厂默认值，评测场景无需设置。

## 4. 启动后会发生什么

1. **Bootstrap（约 1-2 分钟）**：写入 LLM provider 与模型 → 应用内置评测预设（离线策略、提交纪律、知识库使用规程、并发/超时参数）→ 绑定平台并同步题目（平台限流 429 时自动退避重试）→ 启动调度者。
2. **自动作答**：调度者按知识库索引对已登记题目直接提交验证值（每题最多 2 次格式探测后止损），其余题目派解题 agent 持续攻坚；解出即停（`stopSubmitterOnSolve`），平台侧每题提交预算（50 次）受提交纪律约束。
3. **无人值守语义**：进程或宿主重启后自动恢复现场继续作答（不会把队列暂停在无人能恢复的状态）；运行中自带看门狗，队列异常停滞时在 Web UI 与日志发 urgent 告警。

## 5. 观测与审计

- **Web UI**：`http://<宿主>:3000` —— 赛事队列、每题 agent 会话全文、flag 提交流水（值 + verdict + 时间）实时可见，只读浏览器即可，无需登录。
- **日志**：`docker logs -f aegisx-eval`（启动时序、平台请求、告警）。
- **数据留档**：全部数据（SQLite 账本、每 agent 工作区、会话记录）都在数据卷 `/data`；评测结束后 `docker run --rm -v aegisx-eval-data:/data alpine tar czf - /data` 即可完整导出归档。

## 6. 生命周期

| 操作 | 命令 / 行为 |
|---|---|
| 停止 | `docker stop aegisx-eval`（优雅停止，现场保留在数据卷） |
| 续跑 | 重新 `docker start`——同一数据卷上自动恢复，不重复装配、不覆盖已提交记录 |
| 全新一轮评测 | **必须换全新数据卷**（`-v aegisx-eval-data2:/data`），内置预设与提交记录按「首启种子、不覆盖」语义工作 |
| 彻底清理 | `docker rm -f aegisx-eval && docker volume rm aegisx-eval-data` |

## 7. 安全边界

- Web UI 与 API **无鉴权**，暴露的是评测过程数据：请仅将 3000 端口发布在评测内网/本机，不要公网开放。
- 容器不需要 privileged、不需要挂载 docker socket；如需收紧，可自行追加 `--network` 策略把出网限制到 LLM 网关与平台域名两个目标。
- 平台 AccessKey 与网关 key 只存在于容器环境变量与本地数据卷，不会外发到两者之外。

## 8. 出厂自检（可选）

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

## 9. FAQ

- **平台请求 429？** 平台限流，系统自动退避重试，无需处理。
- **提交显示 rejected「此题已被解出」？** 评测平台对已判分题目的重复提交拒绝语义，系统每题只提交一次、不重试、不消耗提交预算。
- **网关一直 404？** 该网关是 exact-endpoint 型而未设 `AEGISX_PROVIDER_EXACT_ENDPOINT=1`，补上后重启容器。
- **模型名不在内置目录？** 系统按保守推断运行；如需精确上下文窗口/思考档位，由赛事方提供 `AEGISX_MODEL_METADATA` JSON。
- **想换模型/网关？** 停止容器，换新数据卷并以新环境变量启动（运行中不热切换）。

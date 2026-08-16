# 调度者程序化工具面：四个基础工具 + aegisx Python SDK

状态：**已实施**（P1–P3 代码与单测完成；宿主 smoke + 容器验证全绿；P3 的「真实赛事端到端调度循环」待首次实赛验证）
前置：[orchestration-v9-simplify.md](orchestration-v9-simplify.md)（v9 编排模型；本方案取代其 §7.2 的调度者工具面）

---

## 一、动机与断言

v9 后调度者（event-scope orchestrator）拥有 18 个原生管理工具（`ORCHESTRATOR_TOOLS`），每个 = TypeBox schema + description + execute，全部委托给 `schedulerAdmin`。真实使用后的观察：

1. **工具是单一原语，无组合**。调度者的认知循环「读状态 → 决策 → 动作」被切成固定原子；复合操作（如「pending 队列里 crypto 类、按 points 排序的前 3 个」）要 4–5 次调用 + 文本解析。
2. **文本 I/O**。工具输出是 `JSON.stringify` 文本或人类可读行，模型每次解析，无结构化管道。
3. **无会话状态**。中间聚合结果只能落工作区文件。
4. **工具面只增不减**。加能力 = 加 schema + description + prompt 提及；`orchestratorSystem` 的 Tools 决策指南持续膨胀。
5. **表达力缺失**。调度原则（points 权重、并行预算、重试策略）只能写进 prompt 让模型每次重新推理——行为不稳定、不可复用。

**断言：调度者的管理能力应该是一次程序化 API（强类型、可组合、可批量），而不是一组一次性工具调用。** 容器内的 Python SDK + bash 执行通道即可实现，不需要 REPL、不需要 vm 沙箱。

## 二、最终形态

| 层 | 内容 |
|---|---|
| 调度者工具面 | `read` / `edit` / `write` / `bash`（四个基础工具，与 solver 共享的常开工具） |
| 管理能力 | 容器内 `import aegisx` Python SDK（强类型 dataclass + typed client） |
| 执行通道 | bash `python3 - <<'PY'` heredoc；无 REPL 会话、无新工具 |
| 18 个管理工具 | 下马（`scheduler-tools.ts` 代码保留不挂载） |

不变量（全部保留）：调度者内建唤醒（6 事件）、paused 门控、队列 FIFO + 围栏、agent 级寻址、冷恢复、`scheduler_config` 策略——这些在 `scheduler-admin` / service 层，工具面收敛不触碰实现。**服务端语义零变化**（管理能力后端、队列、生命周期一律不动）；**调度者的行为契约变化**：从 18 个 schema 校验的工具调用 → 自由文本 heredoc Python（错误形态从结构化工具错误变成 traceback），这是有意的取舍，prompt 模板与 P3 验证按此设计。

## 三、SDK 设计（`apps/sdk/python/aegisx/`）

### 3.1 原则

- **纯标准库 urllib，零第三方依赖** → PYTHONPATH 挂载即可用，无需 pip install、无镜像 rebuild、改代码立即生效；附 `pyproject.toml` 支持 `pip install -e`（双轨）。
- **强类型**：dataclass + 类型注解，字段 snake_case（Pythonic），反序列化从 wire camelCase 映射。
- **docstring 就是模型文档**：prompt 引导调度者 `help(aegisx)` 自查 API。
- **事件作用域**：容器注入 `AEGISX_EVENT_ID` env，SDK 模块级默认，调用无需反复传 event_id。
- **网络**：默认 `http://host.docker.internal:3000`（macOS Docker Desktop 对全部容器自动注入，无需 `--add-host`）；`AEGISX_API_URL` env 覆盖（Linux 部署兜底）。

### 3.2 命名空间与函数清单（与端点表 §3.3 对齐；agents.add 在表内）

```python
import aegisx

snap = aegisx.snapshot()   # 一次拉全量（challenges + queue + runs + agents + status）
aegisx.status()

aegisx.challenges.list() -> list[Challenge]
aegisx.challenges.get(id) -> Challenge

aegisx.queue.list() -> list[QueueItem]
aegisx.queue.enqueue(challenge_id, strategy=None, model=None,
                     solver_count=None, solvers=None, timeout_ms=None) -> QueueItem
aegisx.queue.remove(item_id)
aegisx.queue.clear()
aegisx.queue.reorder(item_ids)

aegisx.runs.list(challenge_id=None, status=None) -> list[RunSummary]
aegisx.runs.start(challenge_id, strategy=None, model=None,
                  solver_count=None, solvers=None, timeout_ms=None) -> RunSummary
aegisx.runs.stop(run_id) -> RunSummary
aegisx.runs.message(run_id, text, deliver_as=None) -> RunSummary
aegisx.runs.close(run_id) -> RunSummary
aegisx.runs.read(run_id, agent_id=None, last_n=None) -> RunRead
aegisx.runs.set_timeout(run_id, timeout_ms) -> RunSummary

aegisx.agents.list(run_id=None) -> list[AgentSummary]
aegisx.agents.message(agent_id, text, deliver_as=None) -> RunSummary
aegisx.agents.add(run_id, prompt, model=None, prompt_mode=None) -> RunSummary
```

### 3.3 HTTP 端点映射（2026-02 逐项核对 run/routes.ts + events/routes.ts + scheduler/routes.ts 后的定稿）

| SDK | 端点 | 状态 |
|---|---|---|
| `snapshot()` | `GET /api/events/:eid/fleet`（runs+agents+status+config）+ `GET /api/events/:eid/queue` + `GET /api/events/:eid`（challenges）—— 3 请求组合 | 现成 |
| `status()` | `GET /api/events/:eid/scheduler`（status 字段） | 现成 |
| `challenges.list()` | `GET /api/events/:eid`（响应即 `{event, challenges}`，无需独立端点） | 现成 |
| `challenges.get(id)` | `GET /api/challenges/:challengeId` | **新增**（HTTP 层无单题端点；服务端 `catalog.getChallenge` 已有） |
| `queue.list()` | `GET /api/events/:eid/queue` | 现成 |
| `queue.enqueue(...)` | `POST /api/challenges/:challengeId/runs`（全参入队 + drainOnce + 返回 queue item） | 现成（**非**事件 queue 路由——`POST /api/events/:eid/queue` 只收 `prompt`/`timeoutMs`，会丢弃 strategy/model/solvers） |
| `queue.remove/clear/reorder` | `/api/events/:eid/queue/:itemId` + `/clear` + `/reorder` | 现成 |
| `runs.list(...)` | `GET /api/events/:eid/runs`（`status`/`challenge_id` 过滤为 SDK 客户端过滤——端点无过滤参数） | 现成 |
| `runs.start(...)` | `POST /api/runs/start`（旁路队列直启，source=scheduler） | **新增**（服务端 `resolveAndCreate` 已有，仅缺路由） |
| `runs.stop/close/set_timeout` | `POST /api/runs/:id/stop` `/close` `/timeout` | 现成 |
| `runs.message` | `POST /api/runs/:id/message` | 现成 |
| `runs.read()` | `GET /api/runs/:id`（detail 含 agents）+ `GET /api/runs/:id/messages?agentId=&after=`（组合，last_n 客户端截取） | 现成 |
| `agents.list()` | `GET /api/runs/:id`（detail.agents） | 现成 |
| `agents.message` | `POST /api/agents/:agentId/message` | 现成 |
| `agents.add(...)` | `POST /api/runs/:runId/agents`（v9 §3.3） | 现成 |

新增端点（2 个）补到 server（沿用现有路由风格）；SDK 只做映射，不发明新 API。

### 3.3.1 错误模型

服务器错误统一为 `{code, message}` + HTTP 状态码（capacity→429、not_found→404、invalid→400/409、launch_failed→500）。SDK 定义 `AegisxError(code, message, status)` 异常，`code` 原样保留——调度者脚本按 `code` 决策（如 capacity 退避重试），不解析文本。网络/JSON 解析失败抛 `AegisxError(code="network_error")`。

### 3.4 使用模式（prompt 契约）

- 复合操作**一段脚本一次执行**（heredoc），不要逐行调用。
- 中间结果 print（repr / JSON）回显给模型，或写文件。
- **输出预算纪律**：bash 工具截断在 2000 行 / 64KB（尾部），大结果写文件、只 print 摘要。SDK 默认值继承：`snapshot()` 只含轻量字段（runs 不含 usage/messages）、`runs.read` 默认 `last_n=10` 且带字符预算——不要在脚本里把整个 messages 打出来。
- helper 沉淀到 `/workspace/scheduler_lib.py`，后续 `import scheduler_lib` 复用——**脚本库替代 REPL 会话**，且更显式。
- 决策前先 `snapshot()` 拉全景，减少往返。
- 超时由 bash 工具 timeout 参数兜底（docker exec 超时杀进程）。长轮询（如 enqueue 后等 drain）拆成多步，单脚本控制在默认 600s 内。

## 四、隔离（不暴露给 solver）

- **工具面**：`SOLVER_TOOLS` / `ORCHESTRATOR_TOOLS` 本就是两套快照，solver 从来没有任何管理工具。
- **SDK 文件**：创建容器时按 `scopeType == "event"` 才挂载 SDK 只读目录（→ `/opt/aegisx-sdk`）+ 注入 `PYTHONPATH` / `AEGISX_EVENT_ID` / `AEGISX_API_URL`；solver 容器 `import aegisx` 直接失败。
- **边界（已确认接受）**：solver 有 bash + 网络，理论上仍可 `curl host.docker.internal:3000/api/...` 直接打管理 API。本地单用户 + 管理 API 的 run id 隔离 + 已有 Boundaries 提示词防注入，可接受，**不做 API token**。

## 五、服务端改动清单

1. `run-factory` / `container-manager`：`container-manager` 的 `CreateOptions` 增 `env?` + `extraBinds?`（dockerode create 目前既不传 Env 也只绑 workspace 一个 bind）；event 容器挂 SDK 只读目录（`:ro`，宿主路径 = repo `apps/sdk/python`，`AEGISX_SDK_PATH` env 可覆盖）+ 注入 `PYTHONPATH=/opt/aegisx-sdk` / `AEGISX_EVENT_ID` / `AEGISX_API_URL`（默认 `http://host.docker.internal:3000`，宿主机 `AEGISX_API_URL` env 透传覆盖）；challenge 容器不动。注意全局 `container.networkMode`（`container:aegisx-vpn`）下 `host.docker.internal` 取决于 VPN 容器 resolv.conf——P2 验证必须覆盖非默认网络模式
2. `scheduler-tools.ts`：`ORCHESTRATOR_TOOLS` 收敛为空；实现代码保留（HTTP 端点后端不动）；**restore 路径对存量 agent 行的工具快照按当前 `ORCHESTRATOR_TOOLS` 取交集**——旧调度者会话冷恢复不会复活 18 个旧工具
3. prompt 模板（`orchestratorSystem` / `schedulerInitial`）：18 工具决策指南 → `import aegisx` 用法 + `help()` 自查 + heredoc 脚本模式 + `scheduler_lib.py` 沉淀；`upgradeBuiltinTemplate` 一次性刷新（旧正文精确匹配才刷，用户编辑保留）
4. 新增 `apps/sdk/python/`：client + dataclasses + `pyproject.toml`
5. `bash-tool.ts`：描述补 heredoc python 模式提示（避免模型在 `python -c "..."` 里与引号搏斗）
6. 新增 HTTP 端点（2 个）：`GET /api/challenges/:challengeId`（单题详情）、`POST /api/runs/start`（旁路队列直启）

## 六、明确不做 / 推迟

| 项 | 理由 |
|---|---|
| REPL 工具（`py_repl`） | bash python heredoc 已覆盖批量执行；无会话由脚本库补偿 |
| vm 沙箱 / 进程内 JS SDK | 容器内 Python 天然隔离，更简单 |
| SDK 给 solver 用 | 明确不做——只给调度者 |
| API token 鉴权 | 本地单用户 + run id 隔离 + 提示词边界，接受现状 |

## 七、实施阶段

| Phase | 内容 | 验证 |
|---|---|---|
| **P1 SDK 包 + 端点** | `aegisx` 包（client/dataclasses/4 命名空间/错误模型）；新增 `GET /api/challenges/:id` + `POST /api/runs/start`；`queue.enqueue` 映射全参入队路由 | ✅ 宿主 smoke 全绿（status/snapshot/challenges/queue enqueue-close-remove/runs/错误契约）；错误信封 `{error:{code,message}}` 解析兼容 |
| **P2 容器挂载 + env** | container-manager 支持 env/extraBinds；event 容器挂载 SDK（`:ro`）+ 三 env | ✅ 调度者容器内 `import aegisx` + `status()`/`challenges.list()` 经 VPN netns 的 `host.docker.internal` 返回真实数据；solver 容器无挂载、`import aegisx` → ModuleNotFoundError |
| **P3 工具面收敛 + prompt** | `ORCHESTRATOR_TOOLS` 清空；restore 存量快照取交集（旧 18 工具不复活，单测覆盖）；`orchestratorSystem`/`schedulerInitial` 模板重写 + `upgradeBuiltinTemplate` 精确刷新存量库；bash-tool 描述补 heredoc 提示 | ✅ 新调度者快照 `tools=[]`（DB 验证）；存量库模板已升级为 SDK 版；✅ 真实赛事端到端（2026-08-16，Test 赛事 3 题 × deepseek-v4-flash）：3 个 solver 全部解出正确 flag（submit_flag accepted）+ 调度者全程纯 SDK/bash（snapshot/read/交叉核对/复现 solve.sh）完成观察与收尾，无管理工具调用 |
| **P4 文档转正** | 本文标记已实施；superseded 标注 | ✅ `bun run check` / `bun run test` / `bun run build` 全绿 |

## 八、已定决策记录

1. 工具面收敛为 `read` / `edit` / `write` / `bash`（用户：write 保留）。
2. 无 REPL 工具，bash `python3 - <<'PY'` heredoc 执行（用户拍板）。
3. SDK 强类型 dataclass；目的 = 批量执行 + 便于数据处理（用户）。
4. 网络直接 `host.docker.internal`，不加 `--add-host`（用户环境已确认可达）。
5. SDK 只给调度者、不暴露给 solver；solver 可 curl 管理 API 的边界接受（用户：管理 API 已有 run id 隔离）。
6. 零依赖标准库 urllib + `pyproject.toml` 双轨。
7. `queue.enqueue` 映射到全参入队路由 `POST /api/challenges/:id/runs`（事件 queue 路由只收 prompt/timeoutMs，不够用）。
8. 新增 HTTP 端点仅 2 个：`GET /api/challenges/:id`、`POST /api/runs/start`；其余全部用现成端点组合。
9. SDK 错误模型 = `AegisxError(code, message, status)`，code 保留供脚本决策。
10. 输出预算纪律：snapshot 轻量字段、read 默认 last_n=10 + 字符预算、大结果写文件。
11. 存量调度者会话（工具快照含 18 名）冷恢复时按当前 `ORCHESTRATOR_TOOLS` 取交集，旧工具不复活。

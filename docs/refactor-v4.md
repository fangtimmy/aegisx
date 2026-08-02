# AegisX v4 重构方案（SDK 进程内 Agent）

Status: **Phase 0 spike 已通过；Phase 1–3 已实施（后端 SDK 内核 + 前端 Conversation + 子 agent/target/resume）；Phase 4 打磨进行中**  
Branch: `rewrite/v4-sdk-agent`（自 v3 tip）  
Base: 当前 `rewrite/v3-cli-container`（v3 tip）  
Related: [architecture.md](./architecture.md)（v3 现状）、[refactor-v3.md](./refactor-v3.md)、[archive/architecture-v2.md](./archive/architecture-v2.md)  
**本版范围：单 run + 子 agent + Conversation 可见性。不含 Orchestrator（另开规划）。**

### Phase 0 结论（2026-08-01）

脚本：`apps/server/scripts/spike-sdk.ts`  
命令：`cd apps/server && bun run scripts/spike-sdk.ts`（可选 `SPIKE_DOCKER=1`）

| 项 | 结果 |
|----|------|
| Bun 1.3.14 + `@earendil-works/pi-coding-agent@0.83.0` + `pi-ai@0.83.0` | 通过 |
| `ModelRuntime.registerProvider` + 现有 config 模型 | 通过 |
| `createAgentSession` + `prompt` + `subscribe`（text_delta / tool 事件） | 通过 |
| `SessionManager.create` 落盘 + `open` 重开 | 通过 |
| `createBashToolDefinition` + 自定义 `operations.exec` 覆盖内建 bash | 通过 |
| host cwd `read` 工具 | 通过 |
| 容器 bash（`sleep infinity` + bind workspace） | 通过 |
| **dockerode `exec.start({hijack:true})` 在 Bun 下** | **失败**（HTTP 101，与 v3 PTY 同源） |
| **MVP `BashOperations` 实现** | 用 **`docker exec` CLI**（`Bun.spawn`）流式 stdout/stderr；create/start/stop/remove 仍可用 dockerode 普通 HTTP |

**门禁：通过。可以进入 Phase 1。不需要 Node worker 旁路。**

---

## 一、一句话目标

把 run 内 agent 从「**容器主进程跑黑盒 pi TUI**」改成「**host 进程内用 pi SDK 驱动 agent，工具经 docker 进 Kali 容器执行**」。

可见性、子 agent、session、compact/retry/流式由 SDK 第一方提供；AegisX 负责编排容器、原生平台工具、事件落库与前端 Timeline。

---

## 二、相对 v3 / v2 的定位

| | v2 | v3（当前） | **v4（本方案）** |
|--|----|-----------|------------------|
| agent loop | host 自写 `pi-agent-core` | 容器内 `pi` TUI | host **pi SDK** `createAgentSession` |
| 可见性 | messages + SSE | TTY 字节流 | SDK 事件 → SQLite + SSE |
| 子 agent | 第一方 spawn | skill + `pi -p` | 第一方 `spawn_agent` |
| 干预 | `POST /message` | 终端打字 | `steer` / `followUp` |
| bash | docker exec | 容器内进程 | docker exec（`BashOperations`） |
| 文件工具 | backend 可切 | 容器内 | **host fs**（workspace bind） |
| 平台工具 | 原生 | skill + curl | **原生** |
| 编排 | 无 | 无 | **本版仍无** |

**基层：v3 tip。**  
- 保留 platforms / events / providers / settings / Files / dockerode / prompt 模板。  
- 重写 run 内核与 Terminal 前端。  
- v2 的 Conversation UI / 多 agent 语义作**参考**（git `rewrite/v2`），不当 checkout base。  
- **不**复活 v2 自写 runtime。

---

## 三、核心架构

```
┌──────────────── Browser ────────────────┐
│  Conversation (SSE)  ·  Files  ·  Overview │
│  消息输入框 → steer / followUp             │
└──────────────────┬───────────────────────┘
                   │ 结构化事件 + REST
┌──────────────────▼───────────────────────┐
│         AegisX server (Hono / Bun)        │
│                                          │
│  ┌─ Run AgentSession (main, per run) ──────┐
│  │  tools: read/bash/edit/write/grep/find/ls│
│  │         submit_flag / target_* / finish  │
│  │         spawn_agent (子 session)         │
│  │  session.subscribe → 落库 + 推前端       │
│  └───────────────┬─────────────────────────┘
│                  │ docker exec (bash)
│                  │ host fs (read/write/edit/…, workspace bind)
┌──────────────────▼───────────────────────┐
│   Docker container (solver image)         │
│   主进程: sleep infinity（常驻工具箱）      │
│   /workspace ← bind（与 host 共享）         │
│   Kali 工具链: python/pwntools/gdb/...     │
└──────────────────────────────────────────┘
```

### 关键分工

| 东西 | 在哪 | 谁管 |
|------|------|------|
| agent loop / LLM | host（pi SDK） | SDK |
| compact / retry / session 树 | host | SDK |
| 消息 / 事件可见性 | 内存 + SQLite + SSE | AegisX |
| 文件读写 | host workspace | SDK 默认 local fs |
| bash / exploit | Kali 容器 | `BashOperations.exec` → docker exec |
| flag / target / finish / spawn | 原生 customTools | AegisX |
| 编排 / 多题调度 | — | **本版不做** |

---

## 四、工具执行模型

pi SDK 工具层可插拔 operations（文档：Override to delegate to remote systems, e.g. SSH）。docker exec 同构。

```ts
// bash → 容器
createBashToolDefinition(workspaceHostPath, {
  operations: {
    exec: (command, cwd, { onData, signal, timeout }) =>
      containerManager.exec(containerName, command, {
        workdir: "/workspace", // 容器内路径；cwd 映射到 bind
        onData, signal, timeout,
      }),
  },
})
// 以 customTools 同名 "bash" 覆盖内建 local bash
// 或 noTools:"builtin" + 全套自组 tools

// read/write/edit/grep/find/ls → host workspace（默认 local fs）
// workspace bind 保证 host 路径 ≡ 容器 /workspace
```

**为何 hybrid：**  
- CTF 工具链只在 bash 里需要。  
- 文件在 host 零开销，Files tab 本就读 host。  
- bind 保证两边同一份文件。

**容器生命周期：**

| | v3 | v4 |
|--|----|----|
| 主进程 | `pi` 交互 TUI | `sleep infinity`（镜像默认 CMD） |
| 角色 | agent 本体 | 常驻工具箱 |
| 结束 | pi 退出 → 容器停 | run 结束 → stop/remove |
| PTY | attach hijack（Bun 下最脏） | **删除** |
| 挂载 | workspace + pi-agent 卷 | **仅 workspace**（session 在 host） |

**docker exec 开销：** MVP 接受每次 bash 一次 exec。二期可长驻 shell 管道复用。

---

## 五、Run 内 Agent（主 agent）

### 创建流程

```
POST /api/challenges/:id/runs
  1. 建 data/runs/<id>/workspace/，拷附件
  2. 建 data/runs/<id>/sessions/（SessionManager 目录）
  3. docker create+start（Cmd 默认 sleep infinity，bind workspace only）
  4. 解析 ProviderConnection → Model（ModelRuntime + 现有 models-json 或 registerProvider）
  5. createAgentSession({
       cwd: workspaceHostPath,
       model, thinkingLevel, modelRuntime,
       sessionManager: SessionManager.create(cwd, sessionsDir),
       settingsManager: SettingsManager.inMemory({ compaction, retry }),
       resourceLoader: systemPromptOverride(渲染后的 main system),
       tools: ["read","bash","edit","write","grep","find","ls", /* + custom 名 */],
       customTools: [
         bashWithDockerExec,          // 覆盖 bash
         submitFlag, target*, finish, spawnAgent
       ],
     })
  6. INSERT runs + agents(main)
  7. session.subscribe → 写 run_events + live bus
  8. session.prompt(initialPrompt)
  9. run.status = running
```

### 模型 / 凭据（host 侧）

- **不再**向容器写 `models.json` / skills / `APPEND_SYSTEM.md`。  
- 复用 `providers/models-json.ts` 的映射逻辑，改为喂给 host 侧 `ModelRuntime`：  
  - 方案 A（MVP 推荐）：run 启动时写临时 `data/runs/<id>/agent-runtime/models.json`，`ModelRuntime.create({ modelsPath, authPath? })`，再 `getModel`。  
  - 方案 B：`modelRuntime.registerProvider(...)` 从 `ProviderConnection` 直接注册。  
- Provider / Model 设置 UI **不动**。  
- `pi-ai` 版本与 `@earendil-works/pi-coding-agent` 对齐（当前 server `pi-ai ^0.80.7`，全局 pi ~0.83；Phase 0 锁定兼容组合）。

### 原生工具

| 工具 | 作用 | 权限 |
|------|------|------|
| `submit_flag` | `platformService.submitFlag` | main |
| `target_get` / `target_start` / `target_extend` / `target_stop` | `platformService.targetAction` | main；无靶机则不注册 |
| `finish_run` | 写 summary → abort session → stop 容器 → `completed` | main |
| `spawn_agent` | 见 §六 | main |

替代 v3 的 `skills/aegisx*` + curl。run 级 HTTP（`/flag` `/finish` `/target`）**可保留**作调试/兼容，主路径改为工具内调 service。

### 生命周期

| 动作 | 实现 |
|------|------|
| stop | `session.abort()` + 停容器 → `stopped` |
| finish | 工具或 API → abort + 停容器 → `completed` + summary |
| resume | 新容器 + `SessionManager.open(sessionFile)` + `createAgentSession` 续同一 session + `prompt`（空续或 "continue"） |
| 进程崩溃恢复 | boot：`running` 且 session 在、容器不在 → 标 `stopped`；**不自动调模型**（沿用 v2/v3） |
| compact | SDK auto-compaction（`SettingsManager.inMemory`） |
| 超时 | **本版可选 MVP**：`timeoutMs` 定时器 → 等同 stop，标 `timed_out`。若工期紧可 Phase 3 再加 |

### 提示词

- 继续 handlebars：`prompts.mainSystem` / `childSystem` / `initial`。  
- 输出目标：`resourceLoader.systemPromptOverride` / child 的 system，**不再**写 `APPEND_SYSTEM.md`。  
- 默认模板文案从「skill + curl」改为「原生工具名」：`submit_flag` / `finish_run` / `target_*` / `spawn_agent`。  
- child 模板强调：无 finish/flag/target/spawn。

---

## 六、子 Agent

```
main AgentSession
  └─ tool: spawn_agent({ task, name? })
        ├─ createAgentSession({
        │    sessionManager: SessionManager.create(...),  // 独立 session 文件
        │    tools: coding only（bash 仍 docker；无 finish/flag/target/spawn）
        │    systemPrompt: child 模板 + task
        │  })
        ├─ INSERT agents(role=child, parentAgentId=main)
        ├─ child.subscribe → 同一 run_events 管道（agentId=child）
        ├─ child.prompt(task)；await 完成或超时
        └─ tool result: { summary, agentId, sessionId, status, messageCount }
```

约束：

- child **不能**再 spawn（工具集不含 `spawn_agent`）。  
- 同 run 并发 child 上限 `maxChildrenPerRun`（默认 1，可先写死）。  
- 可观测：前端按 `agentId` 切换；main/child 关系在 `agents` 表。

---

## 七、可见性与数据流

### 事件管道

```
session.subscribe(event)
  → 规范化为 RunEvent / Message 投影
  → 写入 SQLite run_events
  → 推 live 通道（SSE）给前端 Conversation
```

关注的 SDK 事件：

- `message_start` / `message_update`（text_delta 流式）/ `message_end`
- `tool_execution_start` / `update` / `end`
- `turn_start` / `turn_end`、`agent_start` / `agent_end` / `agent_settled`
- `compaction_*`、`auto_retry_*`（前端可显示 activity）

### 存储

| 层 | 存什么 | 用途 |
|----|--------|------|
| SessionManager jsonl（SDK） | 完整 session 树 | resume / compact / 审计 |
| SQLite `run_events` | 规范化事件（seq、agentId、type、摘要） | API 分页、Timeline |
| 不入库全文 | 超大 bash 输出（截断；全量可落 workspace 临时文件） | 防库膨胀 |

### API 形态（接近 v2，数据源是 SDK）

- `GET /api/runs/:id/messages?after=&agentId=` — 分页（从 run_events 投影或并行 messages 视图）  
- `GET /api/runs/:id/stream` — live SSE  
- `POST /api/runs/:id/message` — `{ text, deliverAs?: "steer"|"followUp" }` → 真接入  
- **删除** `GET /api/runs/:id/pty`

**消息模型选择（建议）：**

- Wire 层采用接近 v2 的 `Message`（user / assistant / toolResult / notice），便于 Timeline 复用心智。  
- 持久层用 `run_events`（更贴 SDK 流式事件）；`messages` API 从 events 投影，或双写 committed message。  
- Phase 0 可先只落 committed + 简单 progress；Phase 1 补齐流式 progress 事件。

---

## 八、数据模型（schema v4，wipe）

**保留：** events / event_platforms / challenges / challenge_remote / attachments / submissions / platform_request_log  

**重做 / 新增：**

```
runs
  id, challengeId, status
  provider, providerLabel, modelId, modelLabel, thinkingLevel
  image, cpus, memoryMb, pidsLimit, containerName, workspacePath
  sessionDir            -- SessionManager 根目录（相对 dataDir）
  sessionFile           -- main session 文件路径（resume 用）
  createdAt, startedAt, updatedAt, completedAt
  error, summary, flag
  -- 删除: launcher, piModelRef（及一切 pi-TUI 专用字段）
  -- status 增加可选: timed_out（若做超时）

agents
  id, runId
  role: 'main' | 'child'
  parentAgentId?
  status: running | completed | failed | stopped | idle?
  sessionFile
  name?, task?
  createdAt, completedAt, error?

run_events
  id, runId, agentId, seq
  type                  -- 与 live 对齐的粗类型
  role?                 -- user|assistant|toolResult|notice|system
  content?              -- 文本摘要或 JSON 字符串
  toolName?, toolCallId?
  payload               -- json 摘要（非全量 dump）
  createdAt
  index(runId, seq)
  index(runId, agentId, seq)
```

`SCHEMA_VERSION = 4`；旧库拒开（与 v3 同一 wipe 策略）。  
启动时 wipe 指引：删 `data/aegisx.sqlite*` 与旧 `data/runs/`（或文档说明不兼容）。

**全局 settings（本版）：**

- 保留现有 agent / runtime / container / prompts。  
- **不加** orchestrator.*。  
- 可选后期：`run.defaultTimeoutMs`、`agent.maxChildrenPerRun`（MVP 可代码常量）。  
- compaction/retry 走 SDK `SettingsManager.inMemory`，**不必**先暴露到设置 UI（Phase 4 可加）。

---

## 九、API 变化

| 动作 | Path | 说明 |
|------|------|------|
| 改 | `POST /api/challenges/:id/runs` | 内部改 SDK；请求体基本同（model/thinking/container） |
| 新 | `GET /api/runs/:id/messages?after=&agentId=` | 结构化消息 |
| 新 | `GET /api/runs/:id/stream` | live SSE（非 PTY） |
| 改 | `POST /api/runs/:id/message` | 真 · steer/followUp |
| 改 | `GET /api/runs/:id` | 含 `agents[]`（可无 usage） |
| 保留 | stop / resume / finish / flag / target/* / files | 语义同，实现改 |
| **删** | `GET /api/runs/:id/pty` | 无 TTY |
| **删/弱化** | session 面板依赖的 pi jsonl HTML 导出 | 改由 Conversation 看历史；jsonl 仍在磁盘供 resume |

---

## 十、前端变化

| 现状 (v3) | v4 |
|-----------|-----|
| Terminal tab（ghostty-web + PTY WS） | **Conversation** tab（timeline + 流式） |
| 终端打字接管 | **消息输入框** → `POST /message` |
| session 面板（HTML export） | 按 agent 切换的消息列表；child 可展开 |
| Overview / Files | **基本不动**（Overview 可显示 agents 摘要） |

**删除：** `terminal.tsx`、pty 相关 API 客户端、`ghostty-web` 依赖、`session-panel.tsx` 中纯 TTY/HTML 导出路径（或整组件按新会话列表重做）。  

**重建（参考 v2 `rewrite/v2` / `097f7f7^`）：**

- `timeline.tsx` / timeline-model  
- tool 调用折叠展示  
- live store（SSE + messages 分页重连）  
- run workspace tabs：Conversation | Overview | Files  

工作量主要在 Conversation + live store；coss UI 只读不改。

---

## 十一、模块落点（server）

```
apps/server/src/
  run/
    service.ts           重写：SDK session 生命周期 + 容器
    agent-session.ts     新：createAgentSession 封装、subscribe 管道、resume
    container-tools.ts   新：BashOperations → docker exec
    tools.ts             新：submit_flag / target_* / finish_run / spawn_agent
    events.ts            新：事件规范化 + 落库 + live bus
    live.ts              新：SSE fan-out（可参考 v2 live）
    routes.ts            改：messages/stream/message；删 pty
    container-manager.ts 收窄：create/start/exec/stop/remove；删 PTY hijack
    prompt.ts            留：context + 附件拷贝；改工具能力字段
    queries.ts / public.ts  改：agents + 新 RunPublic
    # 删除：pty-bridge.ts、pi-launch.ts（skills/models 进容器）
  providers/
    models-json.ts       改或旁路：供 host ModelRuntime
    model-runtime.ts     新（可选）：ProviderConnection → ModelRuntime
  # 不动：platforms/ events/ settings/ infrastructure/（prompt 默认文案改）
```

**依赖：**

| 包 | 动作 |
|----|------|
| `@earendil-works/pi-coding-agent` | **加**（SDK） |
| `@earendil-works/pi-ai` | **对齐版本**（与 coding-agent peer 一致） |
| `@earendil-works/pi-agent-core` | 随 coding-agent 传递依赖；不直接自写 loop |
| `dockerode` | 保留 |
| `ghostty-web` | **前端删** |
| `handlebars` | 保留 |

---

## 十二、明确放弃 / 保留 / 延后

### 放弃

| 项 | 理由 |
|----|------|
| ghostty-web + PTY 接管 | 结构性；steer 替代 |
| 容器内跑 pi / skills / APPEND_SYSTEM / models.json 进容器 | 不再需要 |
| PTY hijack（Bun raw socket） | 最脏代码，整段删 |
| 解析 session jsonl 驱动 UI | 第一方事件流取代 |
| v2 自写 agent loop | SDK 已提供 |
| **Orchestrator** | 本版明确不做 |

### 保留

| 项 | 理由 |
|----|------|
| Kali solver 镜像 + docker 隔离 | 工具链 |
| platforms / providers / settings / events | 不动主体 |
| handlebars 提示词 | system/initial/child |
| Files workspace | host 路径 |
| resume / compact | SDK 原生 |
| 单用户、不脱敏 | 项目规则 |

### 延后（不进本版交付，可记债）

| 项 | 说明 |
|----|------|
| Orchestrator | 独立后续规划 |
| 长驻 shell 复用 | 降 docker exec 延迟 |
| usage/cost Overview | SDK 事件带 usage，Phase 打磨顺手 |
| 设置 UI 暴露 compaction/retry/timeout | 先代码常量 / inMemory |
| Node worker 旁路 | 仅当 Bun+SDK spike 失败 |

---

## 十三、实施顺序

### Phase 0 — Spike（硬门禁，半天内）

在 Bun 下最小脚本验证：

1. `createAgentSession` + `prompt` + `subscribe` 收到 text_delta  
2. `SettingsManager.inMemory` + `SessionManager.create` 落盘  
3. （可选同日）`createBashToolDefinition` + 自定义 `operations.exec` mock  

**通 → 进 Phase 1。**  
**不通 → 定 Node 子进程 worker 方案，再改 service 边界；不盲开大重构。**

### Phase 1 — 骨架（可跑通单 run，可无漂亮 UI）

1. schema v4 wipe（runs + agents + run_events）  
2. container-manager 收窄 + `exec()`（流式 stdout → onData）  
3. `agent-session.ts`：ModelRuntime + SDK + docker bash + host 文件工具  
4. 原生 `finish_run` / `submit_flag`（target 可 Phase 3）  
5. 事件落库 + `GET messages`（可先无 SSE）  
6. `service.create/stop/finish` 改走 SDK；删 PTY 启动路径  
7. 冒烟：手动 create run → bash 进容器 → read 文件 → finish  

### Phase 2 — 前端 Conversation

1. 删 Terminal / ghostty-web / pty 客户端  
2. Timeline + 流式 + 消息输入（steer/followUp）  
3. Overview / Files 接新 `RunDetail`（含 agents）  
4. live SSE + 重连（先 messages 分页，再接 stream）  

### Phase 3 — 子 agent + target + resume

1. `spawn_agent` + child 工具白名单 + agents 表写满  
2. `target_*` 工具（有靶机才注册）  
3. resume：`SessionManager.open` + 新容器  
4. 前端按 agent 切换  
5. （可选）per-run timeout → `timed_out`  

### Phase 4 — 打磨

1. 提示词默认文案与能力位对齐  
2. 大输出截断策略、tool 折叠体验  
3. usage 从事件回填 Overview（顺手）  
4. 删干净 pi-launch/skills 残留；文档改 `architecture.md` 为 v4  
5. `check` / `test` 全绿  

---

## 十四、风险与缓解

| 风险 | 缓解 |
|------|------|
| Bun + pi SDK 不兼容 | **Phase 0 spike**；失败则 Node worker |
| SDK / pi-ai 版本漂移 | 锁定与 coding-agent 匹配的版本对 |
| docker exec 延迟 | MVP 接受；二期长驻 shell |
| 自定义 bash 覆盖方式 | customTools 同名覆盖或 `baseToolsOverride`（以 spike 验证的 API 为准） |
| 长 run 内存 | 进程内 session + SDK compaction；同时 running run 数本就有限 |
| schema wipe | 单用户本地；`SCHEMA_VERSION=4` 拒开旧库 |
| 流式事件模型与 UI 不同步 | Phase 1 先 committed；Phase 2 再 progress |
| grep/find 在 host 而环境无 rg/fd | host 需有 rg/fd，**或** 把 grep/find 也走容器 operations（Phase 1 决策：优先 host；若缺二进制再改容器） |

---

## 十五、删除清单（实施时对照）

**后端删**

- `run/pty-bridge.ts`  
- `run/pi-launch.ts`（skills / APPEND / 容器 models 生成）  
- container-manager 内 `HijackPtyStream` / attach / resize 专用于 TTY 的路径  
- routes 上 `/pty` WebSocket  

**前端删**

- `features/runs/terminal.tsx`  
- `ghostty-web` 依赖  
- session 面板中依赖容器 pi HTML 导出的逻辑（按实现替换）  

**共享改**

- `RunPublic`：去 `launcher`；加 agents 相关  
- 恢复/新增 `Message` / `LiveEvent` / `AgentSummary` 类型（可参考 v2，按 v4 事件裁剪）  
- `RunStatus`：可选 `timed_out`  
- prompt-defaults：工具说明改原生名  

**保留不动**

- `apps/web/src/components/ui/**`（coss 只读）  
- `platforms/`、`events/`、solver 镜像（CMD 本就是 sleep，v3 用 Cmd 覆盖；v4 不覆盖即可）  

---

## 十六、成功标准（本版）

1. 新建 run：host SDK 驱动，容器仅工具箱，无 pi TUI 进程。  
2. Conversation 能流式看到 assistant 文本与 tool 调用；可消息框 steer。  
3. `bash` 在容器内执行（`uname` / `python3` 等可见 Kali 环境）；`read`/`edit` 改 host workspace 且 Files tab 同步。  
4. `submit_flag` / `finish_run` 为原生工具，不经 curl skill。  
5. `spawn_agent` 子任务可观测（独立 agentId 时间线），child 不能嵌套 spawn。  
6. stop / resume / boot 恢复行为符合「不自动偷跑模型」。  
7. 无 PTY / ghostty；schema v4；文档与 architecture 更新。  
8. **无** Orchestrator API / UI / 表。  

---

## 十七、请确认的点

1. **整体范围**：按 Phase 0–4 做，**不含 Orchestrator**，可以吗？  
2. **TTY 彻底放弃**：只保留 Conversation + steer，不双轨 ghostty。  
3. **文件 host / bash 容器** hybrid：接受？（grep/find 默认 host，缺 rg/fd 再改）  
4. **Phase 0 先 spike**：同意的话，确认后**第一步只跑 Bun+SDK 验证**，通过再动 schema/service。  
5. **消息模型**：wire 用接近 v2 的 `Message` + SSE；存储用 `run_events`。  
6. **超时 / usage / 设置 UI 暴露 compaction**：本版可延后；timeout 若要进 MVP 请明示。  
7. **基层**：当前 v3 tip in-place 改造（非回退 v2 分支）。  

你拍以上几点后，我按你的选择开始（默认建议：1–5、7 同意；6 延后；先 Phase 0 spike）。

# v19 实施计划：去 Run 层（题中心模型）

状态：**已实施**（commit 1bd5e24 + 8ee3261）。设计依据：[model-v19-challenge-centric.md](model-v19-challenge-centric.md)（先读，本文不重复设计论证，只讲怎么做）。
用户已拍板：旧数据弃置（不迁移 run 历史）；不设每题 agent 上限；不做 setup.sh；`shared/` 取代频道附件体系（服务端写入、agent 只读）；调度者容器随调度者启停管理；**不做新 UI**，只改现有界面适应新模型。

总原则：不留兼容层、不写迁移逻辑保留 run 历史、每一步可验证、全部改完再统一检查（AGENTS.md 规则）。`apps/web/src/components/ui/**` 只读。

---

## 现状关键事实（实施前必须知道）

- `runs` 表持有：scopeType（challenge|event 双分叉之源）、容器快照（image/cpus/memoryMb/pidsLimit/containerName）、`workspacePath/sessionDir`、`finishing`（finish_run 原子标志）、`deadlineAt/lastTimeoutAt/timeoutMs`、`queueItemId`（队列 done 回填锚）、`source`。
- LiveBus 通道键：**solver agent 的 channel = runId**（`event-pipeline.ts:129` 注释明说），event 键 = eventId。SSE 端点 `/api/runs/:runId/stream` 订阅 runId 通道。
- bash 工具按 agent 注入 per-exec env（`AEGISX_AGENT_ID`/`AEGISX_RUN_ID`，`run-factory.ts:1177`）；容器 WorkingDir=/workspace。
- 调度者容器额外挂载 `data/runs → /runs:ro`（读各 run 工作区）；solver 无此挂载。
- 频道附件：`post(files=相对 run 工作区路径)` → `resolveWorkspaceFile`（root=run 工作区）→ snapshot 拷贝进 `data/channel-files/<messageId>/`（channel_files 表）→ `GET /api/channel-files/:id` 下载 / SDK `fetch()` 物化。
- `session_entries` 冗余 `runId` 列（run 级消息 union 查询用）；`challenge_flags.runId`（text 无 FK）。
- 测试面：server 44 个测试文件（`apps/server/test/run/` 30 个 + db 迁移测试 3 个），web 6 个。
- `run-factory.ts` 1311 行 / `channels.ts` 1448 行 / `service.ts` 1025 行——三个重写主体。

---

## 批次 P0：wire 类型 + schema + 迁移

### 0.1 `apps/shared/`

- `agent.ts`：`AgentSummary` 重构为 v19 形状：
  `id, eventId, challengeId|null, challengeName, role('solver'|'orchestrator'), name, model, status(AgentStatus), source('manual'|'scheduler'), prompt, summary, error, deadlineAt, lastTimeoutAt, createdAt, startedAt, updatedAt, completedAt`；`AgentDetail = { agent: AgentSummary, tools: string[], toolDefinitions, systemPrompt, sessionFile, usage?: RunUsage, workspace: WorkspaceInfo }`（`WorkspaceInfo = { containerRunning: boolean, liveAgentCount: number, image, cpus, memoryMb, pidsLimit }`，后四项来自全局设置）。保留 `AgentStatus`、`isActiveAgentStatus()`。删 `isEntry/slot/parentAgentId/task/runId`。
- `run.ts` → 改名 `workspace.ts`（或留在 agent.ts）：删 `RunPublic/RunDetail/RunScope/SolverSpec/CreateRunInput 语义`；保留 `RunUsage`（改名 `AgentUsage` 亦可，全文替换）、`RunFile/RunFileEntry`（题工作区树复用）、`EnvironmentConfig`、`PromptTemplateContext`（改造，见 P1.8）。
- `queue.ts`：`QueueItemPublic.params = { model?, prompt?, promptMode?, timeoutMs? }`；`runId` → `agentId`；其余字段不变。
- `channels.ts`：`ChannelMessageMeta.runId` → `agentId`；`ChannelFileMeta`（新）`= { path: string /* shared 相对路径 */, filename, size }`，消息 `files: ChannelFileMeta[]`。
- `live-event.ts`：`run.updated(RunPublic)` 删；`agent.updated(AgentSummary)` 保留；LiveEvent 联合类型里涉及 runId 的成员改 agentId。
- `scheduler.ts`：`FleetInfo = { challenges: ChallengeLite[], agentsByChallenge: Record<string, AgentSummary[]>, schedulerAgent: AgentSummary|null, config, status }`（`ChallengeLite = { id, name, category }`）；`SchedulerStatusSnapshot.activeRuns` → `activeAgents`（agent 视图：id/challengeId/challengeName/status）。`InboxSnapshot` 不变。
- `settings-schema.ts`：`scheduler.maxConcurrentRuns` → `scheduler.maxConcurrentAgents`（label「最大并发 agent 数」，默认 4）。
- `domain.ts`（orch `EventScopePayload` 在 `apps/server/src/orchestration/types.ts`）：`run.*` → `agent.*`（started/idle/finished/timedOut/flagAccepted/reopened；`run.resumed` → `agent.reopened`；`run.idle` 的 `failed` 含义保留）。

### 0.2 schema（`apps/server/src/db/schema.ts`）

- `agents` 表重建（v19 列见设计 §2.2，另加 `queueItemId`）；索引：`eventId`、`challengeId`、`status`；partial unique：`on(eventId) where role='orchestrator'`。
- `runs` 表删除；`sessionEntries.runId` 列删除（Bun SQLite ≥3.35 支持 DROP COLUMN，但迁移里直接重建表更稳）；`sessions/sessionEntries` 其余不变（agentId FK 已有）。
- `runQueue` → `spawnQueue`（表名 spawn_queue）：`id, eventId, ord, challengeId, params(JSON), timeoutMs, prompt(展示), source, status, agentId, error, createdAt, updatedAt`；去掉 challengeId 的唯一 PK 约束（append 语义）；`queueState` 不变。
- `channelFiles` 表删除；`channelMessages/channelReads` 结构不变（meta JSON 内容换 agentId）。
- `challengeFlags`：`runId` → `agentId`（text 无 FK，同 v8 理由）；source check `'run'` → `'agent'`。
- `SCHEMA_VERSION` → 18。

### 0.3 迁移 `0013_challenge_centric`

纯破坏性 DDL（不保数据）：先 drop 依赖序 `session_entries → sessions → agents → run_queue → channel_files → channel_messages → channel_reads → runs`；重建 v19 形状的 agents/spawn_queue/sessions/session_entries/频道两表；`challenge_flags` 重建（旧行弃置——`旧数据丢掉`，平台侧 solved 状态靠重新同步）。保留：events/challenges/challenge_remote/attachments/event_platforms/scheduler_config/queue_state/providers/settings/prompt_templates/platform_request_log。迁移测试仿 `migration-0011.test.ts`（旧库 fixture → 迁移 → 断言新形状 + 保留表未动）。

**验证**：`bun test apps/server/src/db`。

---

## 批次 P1：server 核心

### 1.1 路径与容器基建

- 新文件 `run/workspace-resolver.ts`：
  - `challengeRoot(eventId, challengeId)` = `data/events/<eid>/challenges/<cid>/`；`orchestratorRoot(eventId)` = `data/events/<eid>/orchestrator/`；下分 `workspace/ sessions/ runtime/`。
  - `agentDir(root, agentId)` = `<root>/workspace/agents/<agentId.slice(0,8)>/`。
  - `containerNameOf(challengeId|'orch:'+eventId)` = `aegisx-ws-<id8>`。
- `container-manager.ts` 基本不动；`createToolboxContainer` 照用（bind = workspace 根）。
- 新文件 `run/container-lifecycle.ts`（取代 teardown 的容器职责）：
  - `ensureWorkspaceContainer(challengeId, solverOpts)`：内存 registry 命中且 `isRunning` → 复用；否则 `createToolboxContainer`（fence 锁外，慢 I/O）。
  - **TTL 回收**：60s sweep 定时器——题容器对应题无 live agent（running|idle）持续 ≥10min → remove；任何新 live agent 重置。调度者容器不参与 sweep（随启停管理）。
  - `removeWorkspaceContainer(key)`：SIGTERM → 10s → SIGKILL（沿用现 terminateContainer 逻辑，键从 runId 换 workspace key）。
  - boot recovery：枚举 registry 无从恢复（进程内存），改为 `recoverOnBoot` 时对每个有 live agent 的 workspace 调 `removeWorkspaceContainer`（孤儿清理）+ agent running→idle。

### 1.2 `run/agent-factory.ts`（重写自 run-factory，目标 <500 行）

- `spawnAgent(input: { eventId, challengeId, role: 'solver'|'orchestrator', model?, prompt?, promptMode?, timeoutMs?, source, queueItemId? })` 单一路径：
  1. fence 检查（仅 solver，全局 live agent 数 + target 槽位）。
  2. 解析模型（modelResolver；orchestrator 用 scheduler_config.modelId → 全局默认）。
  3. 建 agent 行（快照 systemPrompt/tools/model；deadline = now+timeoutMs ?? defaultRunTimeoutMs）。
  4. `ensureWorkspaceContainer`（solver: solverSdkContainerOpts；orchestrator: sdk + `data/events/<eid>/challenges:/challenges:ro` + env）。
  5. 工作区准备（仅 solver 首次/每次幂等）：`copyAttachments(db, dataDir, challengeId, workspace/attachments/)`（覆盖式，天然幂等）+ `mkdir agents/<id8>`。
  6. prime：`prepareAgent(agentId)` + 首轮 prompt（solver: `initial` 模板渲染，prompt 作为 Strategy；orchestrator: `schedulerInitial`）。
  7. `armAgentTimers`、emit `agent.started`（orch 系统消息）。
- `prepareAgent(agentId)`：per-agent context（模型快照 + bash 工具 root/cwd/env + host 会话）；lazy 开 session（快照优先）。**context 持有 workspace 级共享物**：`WorkspaceContext = { modelRuntime, promptContext, containerKey }`，`contexts: Map<workspaceKey, WorkspaceContext>`（modelRuntime 刷新按 workspace 合并，沿用 refreshRunModelRuntime 单飞逻辑）。
- `reopenAgent(agentId)`（冷恢复）：terminal → idle，重建 WorkspaceContext + 容器（若题内无 live agent），重 arm timers，emit `agent.reopened`。
- `recoverOnBoot`：全 agent running→idle + 孤儿容器清理（见 1.1）。
- 工具接线（`buildAgentToolContext`）：`requestFinish(summary)` → `pendingFinish.set(agentId, summary)`（**无原子标志**——settle 时 `status='completed', summary` 写入 + `agent.finished` 事件 + 队列 markDone + 若题已完全解出触发清场）；`hasAcceptedFlag` 改题级（该题任意 accepted）；`finishFlagWarned` per-agent；`submitFlag(challengeId, agentId, ...)`。
- 删除：`createSolvers`/`addAgent`/`restoreRunContext` 的 run 分叉、`markFinishing`、scopeType 全部分支。

### 1.3 生命周期模块改造

- `deadlines.ts` → per-agent：`armAgentTimers(agentId, deadlineAt)`；到期 abort 该 agent turn → 30s grace → 温和 settle（idle）或 `session.dispose()` 强收（aborted）；**永不杀容器**；`agent.timedOut{outcome}`。
- `run-status.ts` → `agent-status.ts`：`recomputeRunStatus`/`markFinishing` 删；`emitAgentEvent(agentId, payload)`：tag = `「题名」agent-<id8>`，orch 投递、urgent 表（timedOut urgent）不变；agent turn start/settle 的状态写 + `agent.idle{failed}` 事件；settle 时处理 pendingFinish。
- `stall-watchdog.ts`：`noteAgentIdle(agentId)`（agent 行直查，无 run 间接）；判定「该 agent 自身 idle/failed 超 2min」→ urgent orch 行 `agent-a3f1 idle 2m5s`。
- `teardown.ts` 删（容器职责并入 1.1；agent 终结并入 status/factory）。

### 1.4 fence / queue

- `fence.ts`：`liveSolverAgentCount`（agents.challengeId 非空 + running/idle）；target 槽位 = 有 live agent 的 target-capable unsolved 题（join 逻辑同现有，锚 challengeId）；`checkSpawnFence({eventId, challengeId})`。
- `queue.ts` → spawn 队列：enqueue 恒 append（**删 upsert-by-challenge**——语义变化：一题可多 pending）；`launch(item) = spawnAgent(...)`（capacity 抛错 → 保持 pending 等下次 drain；其他失败 → failed + emergency）；agent terminal 时 `markDone(queueItemId, agentId)`；starved 边沿/pause/clear/reorder 不变。

### 1.5 `channels.ts` 改造（结构保留，四处换血）

- 附件：`resolveWorkspaceFile` root = **agent 自己的目录**；`storeFileCopies` → `copyIntoShared(agent, sources)`：目标 `workspace/shared/from-<agentId8>/<filename>`（重名加 `-2` 后缀），消息 `files=[{path:"shared/from-x/f", filename, size}]`；用户 multipart → `shared/upload-<epoch>/<filename>`。`channelFiles` 表/`filesDir`/`fileById`/`GET /api/channel-files` 全删。
- `serverMeta`：stamped `agentId`（agent 署名防伪）。
- `deliveryKeys(agent)`：直查 agent 行——solver：`team:<challengeId>` + `dm:<id>`；orchestrator：`orch:<eventId>`。`deliverAgentAwaited` 的 liveness 判定从 run 行改 agent 行（terminal=只存不投；dm urgent 冷唤醒走 `reopenAgent`）。
- flush tick：单查询 live agents（running|idle）分发，无 runs join。
- `runChannelTree` 删；`challengeChannelTree(challengeId)` = team + 该题全部 agent 的 dm。
- SSE `emitChannelOf`：dm → agentId 总线通道；team/orch → eventId（+ team 同时发 challengeId 通道，供题目 IM）。

### 1.6 `service.ts` → agent service

导出面（routes 用）：`spawn / enqueue / getAgent / listAgents(challengeId|eventId) / fleet(eventId) / sendMessage(agentId) / stopAgent / closeAgent / setAgentTimeout / switchAgentModel / compactAgent / sessions+backtrack / listMessages(agentId,...) / submitFlag(agentId) / targetAction(challengeId) / workspaceFiles(challengeId) / scheduler: start|pause|resume|close|getAgent|config`。`stop/close/timeout/finish` 全部 per-agent；`closeAgent` = 终结该 agent（aborted + summary 可选）+ 触发容器回收检查。`withLock(agentId)`。usage：`usageOfAgent`（session_entries by agentId）+ `usageForEvent`（agents.eventId）。

### 1.7 路由（`run/routes.ts` 重写 + `scheduler/routes.ts` 微调）

按设计 §六逐条落：`/api/challenges/:id/agents`（POST spawn）、`/api/events/:id/queue`（POST enqueue）、`/api/agents/:agentId/(detail|messages|stream|stop|close|timeout|model|compact|sessions|backtrack|flag|finish)`、`/api/challenges/:id/(files|channels|agents|target)`、`/api/events/:id/fleet`（新形状）、`/api/events/:id/stream`（事件级 SSE：agent.updated + 频道消息；本期 web 仍轮询 fleet，此端点可后置——**先不做**，避免范围膨胀，标注 follow-up）。SSE `/api/agents/:id/stream` 订阅 agentId 通道（事件类型不变：message.*/tool.*/agent.updated/channel.message）。

### 1.8 提示词（`orchestration/prompt-defaults.ts` + `run/prompt.ts`）

按设计 §八重写四模板相关段落；`PromptTemplateContext`：`run.*` 段删，换 `workspace = { root:'/workspace', agentDir:'agents/<id8>', sharedDir:'shared', attachmentsDir:'attachments', siblingsDir:'agents' }` + 保留 container 资源位。`prompt-refresh-v18.ts` 的刷新链对齐（builtin defaults 变更 → 刷新用户模板的机制照旧，编号 v19）。

### 1.9 其余 server 触点

- `agents/host-session.ts`、`event-pipeline.ts`、`db-session-manager.ts`：`runId` 参数/列引用全部换 agentId；LiveBus 键 = agentId（`event-pipeline.ts:129` 的注释与实现）；`onUsageMaybeChanged` → agent usage 重发。
- `platforms/flags.ts` / `service.ts`（submitFlag）：签名 `(challengeId, agentId, flag, verifyRemote)`；challenge_flags.agentId 落库；**完全解出清场**：停同题其余 live agent（abort）+ 取消该题 pending 队列项 + `stopTargetIfOrphaned`（题内无 live agent → 停靶机）。
- `events/routes.ts`：fleet/usage/删除清理（`deleteRunsForEvent` → 按 agents 清）适配；`events/catalog.ts` 的 `run_status_counts` → `agent_status_counts`（Challenge wire 字段）。
- `bash-tool.ts`：新增 per-agent `cwd`（docker exec `WorkingDir` 选项 = `/workspace/agents/<id8>`；若 dockerode 版本不支持则命令前缀 `cd <dir> && `，二选一，测试锁定）；execEnv 只留 `AEGISX_AGENT_ID`。
- `run/workspace/tools.ts`（host 文件工具）：root = agent 目录（每 agent 一个实例）；grep/find/ls 范围同。

**验证（P1 整批完成后）**：`bun run --filter @aegisx/server check` + `bun test apps/server`（44 个测试文件按下表处置）。

测试处置原则：**断言语义跟随新模型改写，不删覆盖**——`service-create/multisolver/add-agent/multiagent` 合并为 spawn 系（多 solver 场景 = 同题多 spawn）；`fence/queue/service-timeout/stall-watchdog/channels/messages-cursor/scheduler-*` 改锚 agent；`service-flag-cleanup` 改题级清场；`migration-0013.test.ts` 新增；`schema-compat.test.ts` 对齐 v19。

---

## 批次 P2：Python SDK（`apps/sdk/python/aegisx/`）

- `runs.py` 删，能力并入：`agents.py` 增 `get/stop/close/read/set_timeout/start(challenge_id, prompt, model, timeout_ms)`（start = 旁路直接 spawn）；`list(challenge_id=None, status=None)` 改锚题。`_entry_agent(run_id)` 死。
- `queue.py`：`enqueue(challenge_id, prompt=None, model=None, timeout_ms=None)`；删 strategy/solver_count/solvers。
- `channels.py`：`announce(challenge_id)`（team key 直构）；`fetch` 删；模块 docstring 更新（附件=shared/ 路径，同容器直读、调度者经 /challenges 只读挂载）。
- `models.py`：`Run` 删；`AgentSummary` v19 字段；`QueueItem.params/agentId`；`RunRead`→`AgentRead`；`Challenge.run_status_counts`→`agent_status_counts`。
- `client.py`：`wire_solvers` 删；`AEGISX_RUN_ID` 引用清掉。
- `__init__.py`：`snapshot()` fleet 新形状（`agents_by_challenge`、`scheduler_agent`）；docstring 示例更新。

**验证**：SDK 无独立测试；由 server 端到端测试（scheduler-tools/scheduler-queue 系）+ `python3 -c "import aegisx; help(aegisx)"`（容器内冒烟时做）覆盖。

---

## 批次 P3：web 适配（不做新界面）

### 3.1 api 层

- `api/agents.ts`（自 runs.ts 重写）：`spawnAgent(challengeId, input)` / `enqueueSpawn(eventId, {challengeId, ...})` / `getAgent(agentId)` / `listMessages(agentId, after)` / `getChallengeFiles(challengeId, path)` / `closeAgent` / `stopAgent` / `setAgentTimeout` / `switchModel`（已有）/ `submitAgentFlag`；`api/scheduler.ts`：`schedulerAgent` 形状；`api/channels.ts`：`challengeChannelTree(challengeId)`、multipart 上传响应含 shared 路径。
- `api/types.ts`：对齐 shared v19；`keys.ts`：`runs.*` → `agents.detail/fleet/messages` + `challenges.files/channels/agents`。
- `api/index.ts` 导出面更新；删 `api/runs.ts`。

### 3.2 features（逐文件）

| 文件 | 动作 |
| --- | --- |
| `create-run-dialog.tsx` → `spawn-agent-dialog.tsx` | 字段：题目（无 challenge prop 时选择器）/ 模型 / 提示词(Strategy) / 超时 / 直接 spawn 或入队；**删** solver 数、逐 solver 高级、容器说明 Alert |
| `add-solver-dialog.tsx` | 删（spawn 覆盖；run-overview 花名册入口换 spawn 对话框） |
| `agent-dialog.tsx` | 以 agentId 打开；detail 换 `getAgent`；tabs：对话 / 频道(题频道树) / 文件(题工作区) / 概览(agent+题) + 调度者附加 配置/调度DM；not-found 分支（修复旧 #12：data 到而 agent 缺 → 提示+关闭） |
| `run-overview.tsx` → `agent-overview.tsx` | agent 信息（模型/deadline/超时/usage/summary/error/提交的 flags）；题容器段（running/资源=全局设置/live 同题人数）；`SolverRoster` → 同题 agents 花名册 + spawn 入口；TargetPanel 保留 |
| `agents-graph.tsx` | 三层：scheduler → challenge → agent（run 节点删）；`runShortId` → `agentShortId`；dagre 布局输入适配 |
| `agents-tab.tsx` | 数据源 fleet.agentsByChallenge + schedulerAgent；行显示题名 + agent 代名 |
| `event-summary.tsx` | fleet 单端点新形状（**顺带修复 N+1 缓存踩踏**）；usage 聚合不变 |
| `timeline-tab.tsx` | 事件类型 `run.*`→`agent.*`；跳转锚 agent |
| `queue-list.tsx` | params 显示/编辑：prompt/model/timeout（删 solverCount/solvers UI） |
| `channels-view.tsx` | 附件 chip → shared 路径展示（复制用），无下载端点；用户上传走 multipart（服务端落 shared/upload-*） |
| `conversation.tsx` | 单 agent（`agents=[agent]`；多 agent tabs 删）；`/close` 文案「关闭该 agent（文件保留）」；stop/compact/sessionOps 换 agent API |
| `message-input.tsx` | 命令面板文案跟随；无结构变化 |
| `challenge-im-dialog.tsx` | 题频道树 API；团队附件显示 shared 路径 |
| `event-settings.tsx` / `platform-config.ts` / `challenge-card.tsx` / `challenge-flags.tsx` / `scheduler-config-tab.tsx` / `scheduler-dm-tab.tsx` / `home-page.tsx` | 类型与字段跟随（scopeType/run 引用清除；schedulerAgent 措辞） |
| `event-page.tsx` | fleet 解构换新形状；CreateRunDialog → SpawnAgentDialog；AgentDialog 调用签名 |

### 3.3 web 测试

`conversation-store/parse-event/conversation/platform-sync-stream` 既有断言以 agentId 为键的保持；类型导入跟随 shared v19 改名。

**验证**：`bun run --filter @aegisx/web check && bun test apps/web && bun run build`。

---

## 批次 P4：收尾

- README：模型描述段（Event→Challenge→Workspace→Agent）、schema v18 说明、`bun run relay` 等不动部分保留。
- `docs/model-v19-challenge-centric.md` 状态改「已实施」+ 填实施批次 commit；`ux-review-2026-08-18.md` 追注（痛点 3 部分由 v19 消解）。
- 手工冒烟清单（dev 起服后）：
  1. 建赛事 → 手动建题 + 传附件 → spawn（直接）→ 对话流 SSE 正常、bash cwd=agents/&lt;id8&gt;、附件在 /workspace/attachments。
  2. 入队 spawn → drain 拉起；并发上限触发 capacity 错误文案。
  3. 手动记 flag → 完全解出清场（同题另一 live agent 被停、pending 取消）。
  4. agent 超时 → idle/aborted 两分支；terminal agent 发消息 → 重开（容器重建、目录保留）。
  5. 启动调度者 → DM 对话、#team announce（按题）、solver ask urgent 唤醒；调度者容器随启停。
  6. #team 发附件 → shared/from-&lt;id8&gt;/ 出现、同容器 agent 可读、调度者经 /challenges 读。
  7. 删题/清 run 历史 → 工作区与频道清理。

---

## 风险与已知取舍（实施时不要「顺手修复」）

- 同容器互踩（端口/进程/内存）是既定取舍，提示词已教；不做资源隔离强化。
- shared/ 只读靠约定 + host 工具 root，不做强制。
- fleet 仍轮询（SSE 事件流本期不做，作战页时再上）。
- `agent_status_counts` 字段名变化会破坏进行中比赛的调度者习惯——本地工具，直接换。

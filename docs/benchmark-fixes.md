# Benchmark 修复工作包

状态：**已实施**（见末尾「实施记录」）。来源：一次真实 benchmark 暴露的 9 个问题 + 用户拍板的决策。
基线：v8 编排架构（见 `docs/orchestration-redesign.md`，schema v8 已上线）。

本文是唯一的实施依据。每个工作流（W1–W7）独立可交付，末尾给出实施顺序与验证标准。

---

## 零、问题 → 决策速查

| # | 问题 | 决策（用户已确认） |
|---|---|---|
| 1 | agent 提示词丢失 ENVIRONMENT.md 引用 | 静态环境速查写进 **mainSystem/childSystem 系统提示词**；动态 per-run 信息留在 initial（见 W1.2） |
| 2 | 调度者编排的 run 覆盖模板渲染的初始提示词 | `prompt` 语义从**整体替换**改为**追加 Strategy 区块**，模板标准区块永不丢失 |
| 3 | 调度者无法停止/禁用 | 增加 **paused** 状态（禁用事件回调，保温容器）；`start` 改为 **cold-restore 保留记忆**，仅显式 reset 才新建 |
| 4 | 重启后队列自动排空 | 队列获得 **per-event 状态机**（running/paused）；**boot 后一律 paused**，手动恢复；顺带修复 crash 后队列项卡 `running` 的 bug |
| 5 | 工具计时从打开 dialog 起算 | `tool.progress` 事件携带服务端 `startedAt`，前端用真实起点计时 |
| 6 | 应始终使用 agent dialog | 移除 `/events/:eventId/runs/:runId` 路由与 RunWorkspace；左侧点击只**选中**（graph 高亮），dialog 只能从 graph 节点打开 |
| 7 | 100+ run 时 graph 不可用 | graph 改为**三个顶层组**：调度者 / 手动 / 已归档（聚合节点）；暂不做过滤；新增 fleet 批量端点 |
| 8 | 手动 run 与队列的竞争 | 手动 run 照常通知调度者但**载荷带 source=manual**，调度者提示词约束其不得操作手动 run；队列状态机保持简单，**不做**启动去重/认领 |
| 9 | 靶机/并发上限失效 | `maxConcurrentRuns` 语义改为**活容器上限**（running + idle）；靶机槽**只看本地**：有活跃 run 的 target-capable 未解题目数（不查远端）；teardown 自动 stop_target |

**一个口径说明（W4）**：靶机槽的「活跃 run」按 running + idle 计（与容器上限同口径）。理由：idle run 的靶机大概率仍在平台上运行，只数 running 会重新引入超限问题。若实施时用户改口，只需改一条 SQL 的 status 过滤。

---

## W1. 提示词修复（问题 1、2）

### W1.1 `prompt` override → Strategy 追加

现状链路：`enqueue_run`/`start_run` 的 `prompt` → `queue.prompt` → `resolveAndCreate({ initialPromptOverride })` → `buildRunContext` 中 `initialPrompt = override ?? render(initial)` —— 调度者的每题策略把渲染好的 initial 模板（题目描述、附件、环境、提交说明）整体替换掉。

改为：

1. `PromptContext`（`orchestration/types.ts`）增加可选字段 `strategy?: string`（仅 challenge-scope initial 渲染时注入）。
2. `CreateRunInput.initialPromptOverride` 改名 `strategy?: string`；`buildRunContext` 中：
   ```ts
   const initialPrompt = renderTemplate(templateMap, "initial", {
     ...opts.promptContext,
     ...(opts.strategy ? { strategy: opts.strategy } : {}),
   })
   ```
   永远渲染模板；strategy 存在时作为变量注入。
3. `DEFAULT_INITIAL_PROMPT_TEMPLATE` 在 `## Challenge` 区块之后增加：
   ```handlebars
   {{#if strategy}}
   ## Strategy
   {{strategy}}
   {{/if}}
   ```
4. 透传链路只改字段名：`queue.ts` 的 `EnqueueInput.prompt`、`scheduler-admin.resolveAndCreate` 的 `input.prompt` 保持原名，传给 `create({ strategy: input.prompt })`。
5. 工具与路由描述更新（`scheduler-tools.ts` 的 `enqueue_run`/`start_run`、`run/routes.ts` 的 `runInput`）：prompt 描述改为 "appended to the run's default initial prompt as a Strategy section — the standard blocks (challenge, environment, submission) are always included"。

### W1.2 环境速查的落点

**静态环境引用 → mainSystem + childSystem（系统提示词）**：

- mainSystem 的 Approach 段落增加一条（或独立小节）：
  ```
  9. Environment quick reference: read /opt/solver/ENVIRONMENT.md first for the full
     tool/library/path reference; knowledge bases live at /opt/solver/knowledges.
  ```
- childSystem 的 Approach 段落增加同样的指引（第 3 条已知 knowledges，补上 ENVIRONMENT.md）。

**动态 per-run 信息（`{{run.cpus}}`/`{{run.memoryMb}}`/`{{run.pidsLimit}}`、附件清单、题目描述）留在 initial**，不重复进系统提示词。

理由：系统提示词随 agent 行快照持久、压缩永不丢失；initial 是首条 user message，长会话压缩后细节会被摘要掉。W1.1 之后 initial 模板无条件渲染，双保险。

### W1.3 模板升级（兼容已编辑行）

默认模板体变了，但 `prompt_templates` 表的行只在缺失时 seed（`onConflictDoNothing`），用户编辑过的行永不覆盖。沿用 `upgradeBuiltinTemplate` 的一次性升级模式（现役先例：`LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE`）：

- `prompt-defaults.ts` 导出旧默认体常量：`LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE`、`LEGACY_CHILD_SYSTEM_PROMPT_TEMPLATE`、`LEGACY_INITIAL_PROMPT_TEMPLATE`、`LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V2`（现 DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE 的当前体，W5 还要再改它）。
- `service.ts` 构造时（`migrateLegacyPromptSettings` 旁）调用四次 `upgradeBuiltinTemplate(db, key, legacy, new)`：当前体 === 旧默认体的行升级到新默认体；已编辑的行不动。

### W1 验证

- 单测：带 strategy 的 initial 渲染包含 Challenge/Environment/Strategy 三段；不带 strategy 无 Strategy 段（现有 `prompt-templates.test.ts` / `service-scheduler-queue.test.ts` 扩展）。
- 单测：mainSystem/childSystem 渲染包含 ENVIRONMENT.md 引用。
- 单测：upgrade 只改等于旧默认体的行。

---

## W2. 队列状态机 + boot 行为（问题 4）

### W2.1 per-event 队列状态

- 新表（迁移 `0006_benchmark_fixes`，与 W3 的 `scheduler_config.paused` 同一迁移；见实施记录说明）：
  ```sql
  CREATE TABLE queue_state (
    event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'paused'
    updated_at TEXT NOT NULL
  );
  ```
  无行 = `running`（新事件手动入队立即排空，无需先启用）。
- API（`scheduler/routes.ts`）：
  - `GET /api/events/:id/queue` 返回 `{ items, state: "running" | "paused" }`。
  - `POST /api/events/:id/queue/pause`、`POST /api/events/:id/queue/resume`（upsert 行）。pause 只阻止**未来启动**，已在跑的 run 不受影响（pause ≠ kill）。
- `queue.ts`：
  - `pendingItems()` join `queue_state`，跳过 paused 事件的 pending 项（`drainOnce`/`scheduleDrain` 无需其它改动）。
  - 新增 `pause(eventId)` / `resume(eventId)` / `stateOf(eventId)`。
  - paused 事件仍可 enqueue/edit/reorder/remove（只是不排空）。

### W2.2 boot 恢复行为（`recoverOnBoot`）

1. 保留现有：关闭全部 running/idle run、回收孤儿容器、agent 置 idle。
2. **修复卡死 bug**：crash 后 `status='running'` 的队列项永远不可删除、永不变 done（`recoverOnBoot` 不走 teardown）。恢复时对每个被关闭 run 的 `queueItemId`：队列项若仍为 `running` → 重置为 `pending`、`runId=null`（旧 closed run 留在历史里，恢复排空后拉起的是新 run——可接受）。
3. **暂停**：对所有存在可见项（pending/running/failed）的事件 upsert `queue_state='paused'`。
4. **删除**末尾的 `deps.queue()?.scheduleDrain()` —— boot 永不自动排空。

### W2.3 UI

- `QueueList` / PlanPanel 头部显示队列状态 badge（运行中 / 已暂停）+ 暂停/恢复按钮；paused 时队列区顶部提示「队列已暂停，恢复后排空」。

### W2 验证

- 单测（`queue.test.ts` 扩展）：paused 事件 drain 不启动；resume 后启动；pause 不动 running 项。
- 单测（`run-factory`/service 测试）：recoverOnBoot 后 —— 全部 live run closed；原 running 队列项 → pending；相关事件 queue_state=paused；无 drain 发生。
- 手测：入队若干 → kill 服务端 → 重启 → 队列显示已暂停、pending 齐全 → 点恢复 → 按序拉起。

---

## W3. 调度者生命周期（问题 3）

### W3.1 paused（禁用）

- `scheduler_config` 加列 `paused INTEGER NOT NULL DEFAULT 0`（迁移 `0006_benchmark_fixes`，与 queue_state 同一迁移）。
- **事件闸门**：`run-status.ts` 的 `emitRunEvent` 在分发到 `eventScopes` 前检查该 event 的 `scheduler_config.paused`，为 1 则丢弃（started/idle/flagAccepted/finished/timedOut/resumed 全部静默丢弃——最简单且无内存积压；调度者恢复后会主动重新同步）。通过注入的 `isSchedulerPaused(eventId): boolean` 回调实现（service 持有 scheduler-admin 的 config 读取）。
- API（`scheduler/routes.ts`）：
  - `POST /api/events/:id/scheduler/pause`：置 paused=1 + stop（abort 当前 turn，容器保温）。
  - `POST /api/events/:id/scheduler/resume`：置 paused=0 + 向 orchestrator 发消息「调度已恢复。请重新同步状态（get_status / list_runs / read_run）后再行动。」
  - 调度者 run 不存在时 pause/resume 仍可写标志（供下次 start 前预设）。
- 用户在 agent dialog 直接给 paused 调度者发消息：允许（用户显式指令优先），不做拦截。

### W3.2 start = restore（保留记忆）

`startScheduler`（`scheduler-admin.ts`）重写：

1. 存在 live run（running/idle）：paused → 执行 resume；否则抛 `invalid_state`（"already active"）。
2. 存在 closed run：**cold-restore** —— 对 entry agent `lifecycle.send(wake)`（走 `onResume → prepareAgent → restoreRunContext`，event scope 的冷恢复路径已存在），容器重建、wire 重挂、session 上下文保留。带 `reset: true` 参数时删除 closed 行（级联删 agents/sessions）+ 走现有 fresh create。
3. 无 run：fresh create（同时置 paused=0）。

`POST /scheduler/start` body 加 `reset?: boolean`（默认 false）。

### W3.3 UI

- AgentsGraph 顶部 Panel（现有「启动调度者」旁）按状态切换：活跃未暂停 → 「暂停」「关闭」；paused → 「恢复」；closed → 「启动」（restore 语义）。SchedulerConfigTab（agent dialog 配置页）同步展示状态；不做重复按钮，配置页只读展示。

### W3 验证

- 单测：paused 时 run.idle/flagAccepted 不触发 orchestrator send；resume 后触发。
- 单测：closed scheduler run 的 start 走 restore（agent 行/session 保留、不删除重建）；reset=true 删旧建新。
- 手测：暂停后关闭一个 run → 调度者无反应；恢复 → 收到同步消息并行动。

---

## W4. 围栏语义（问题 9）

### W4.1 `maxConcurrentRuns` = 活容器上限

- `fence.ts`：
  - `runningChallengeRunCount` → `liveChallengeRunCount`：`scopeType='challenge' AND status IN ('running','idle')`。
  - 拒绝消息改为 `Live container cap reached (N/M solver containers)`。
- `settings-schema.ts`：description 更新为「同时存活的解题容器上限（运行中 + 空闲保温）。由编排器强制限制。」
- **移除 `onTurnGate` 围栏检查**（`service.ts` 的 lifecycle 注入）：唤醒一个已活 run 不新增容器、不新增靶机槽（其题目已被计入），无需检查。围栏只在两处强制：`create()`（新容器）与 `restoreRunContext`（closed → 活）。`agentTurnStart` 的状态重算保持不变。
- 冷恢复路径注释同步更新（「第三处强制点」的说法改为两处 + gate 已移除）。

### W4.2 靶机槽 = 本地活跃题目数

- `activeTargetSlots`：`status IN ('running','idle')`（原 `= 'running'`），其余条件不变（target-capable、未解、per-event、DISTINCT）。
- 不查任何远端 adapter 状态。

### W4.3 teardown 自动 stop_target（治泄漏）

teardown/超时/强杀不 stop 靶机导致平台实例泄漏。修复：

- `teardown.ts` 的 `teardownRun` 注入回调 `stopTargetIfOrphaned(runId, challengeId)`（由 service 提供）：题目 target-capable 且**同题目无其它活跃（running/idle）run** 时，fire-and-forget 调 `platformService.targetAction(challengeId, "stop")`，错误吞掉。
- 仅 sanctioned teardown 触发（close/finish/timeout 已全部走 `teardownRun`）；`deleteRun` 同样调用。

### W4 验证

- `fence.test.ts` 重写口径：idle 计入容器上限与靶机槽；scheduler run 不计；同题多 run 共享槽；已解/ignored 题不占槽。
- `service-fence-gate.test.ts`：删除（gate 已移除）或改为验证唤醒 idle run 永不被拒。
- 新单测：最后一个活跃 run close → stop_target 被调；同题还有另一个活跃 run → 不调。
- 手测：cap=4 时 4 个 idle run 后第 5 个 launch 被拒；close 一个后 drain 放行。

---

## W5. 手动 run 通知调度者（问题 8）

- `EventScopePayload`（`orchestration/types.ts`）所有 run.* 变体加 `source?: "manual" | "scheduler"`；`run-status.ts` 的 `emitRunEvent` 从 run 行附带（它本来就重读 row）。
- `scheduler.ts` wire 的消息文本带标记：`Run ${runId} 已启动（手动启动，由用户管理）。`
- `DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE` 增加 Manual runs 段：
  ```
  ## Manual runs
  Runs with source=manual were started by the user. Observe them (read_run) and count
  them against the caps, but do NOT stop/message/close/re-enqueue them unless your
  instruction explicitly authorizes operating on manual runs.
  ```
- 队列状态机不变：不做手动 run 与队列项的去重/认领（`start_run` 仍绕过队列；enqueue upsert 语义不变）。

### W5 验证

- 单测：手动 create 后 scheduler 收到的 run.started 带 source=manual；scheduler 启动的带 scheduler。

---

## W6. 工具计时真实起点（问题 5）

- `shared/live-event.ts`：`tool.progress` 事件加可选 `startedAt?: number`（epoch ms）。
- `event-pipeline.ts` `tool_execution_start`：emit 时带 `startedAt: Date.now()`（`toolExecStart` 记录的同一值）。LiveBus 的 runningTools 快照存整个事件 → SSE 重放（`sse.ts`）自动携带。
- 前端链路透传：`parse-event.ts` 解析 → `conversation-store.ts` 的 `ToolProgress` → `domain/conversation.ts` 的 LiveEntry tool 与 `ToolBlock.startedAt`。
- `timeline.tsx` `ToolActivity`：`tool.startedAt` 存在时 `elapsed = Date.now() - startedAt`（每秒 tick 重算）；缺失（旧数据）回退现有本地计时。

### W6 验证

- `event-pipeline.test.ts`：start 事件含 startedAt。
- 手测：工具执行中打开 agent dialog → 计时从真实起点继续，不从 0。

---

## W7. 前端重构（问题 6、7）

### W7.1 统一 agent dialog

- `App.tsx`：删除 `/events/:eventId/runs/:runId` 路由。
- `event-page.tsx`：删除 runId/workspace 分支与 `RunWorkspace`；`features/runs/run-workspace.tsx` 随之孤儿 → 删除（顺带检查其独占依赖如 `steer-queue.tsx`，孤儿一并删）。
- `EventAgentsPanel` 拆分两个状态：
  - `selected: { runId, agentId } | null` —— 高亮，不开 dialog。来源：左侧 AgentsTab 点击、TimelineTab 条目、QueueList 的「打开」。
  - `dialog: { runId, agentId } | null` —— 打开 AgentDialog。**仅**来自 graph 节点点击（agent 节点 / 调度者节点）。
- 左侧面板删除「任务」tab（`runs-tab.tsx` 删除）；保留 计划 / 时间线 / 题目 / Agents。
- TimelineTab / QueueList 的入口从 `navigate(/runs/:id)` 改为 onSelect(run 的 entry agent)。

### W7.2 Graph 三组布局

`buildAgentsGraph`（`agents-graph.tsx`）重构为三个顶层组：

1. **调度者**（现有 `SCHED_NODE_ID`）：节点即 orchestrator agent；其下挂 **active 的 scheduler-source run**（running/idle，`run.source === 'scheduler'`）。
2. **手动**：新增组根节点「手动任务」，下挂 active 的 manual run（`run.source === 'manual'`）。
3. **已归档**：聚合节点「已归档 ×N」（N = closed run 数）。默认折叠；点击切换展开，展开后显示 closed run 节点（复用 RunGraphNode，agents 默认折叠、点击 run 节点展开 agents 的现有行为保留）。

- 选中态：`selected` 的 agent 节点高亮（ring/边框强调）+ 视口聚焦（React Flow `setCenter`/fitView on node）；其 run 自动展开。
- React Flow 开 `onlyRenderVisibleElements`。
- 活跃 run 数本身有容器上限兜底（W4），归档默认折叠 → 常态节点数有界。

### W7.3 Fleet 批量端点

现状 `event-page.tsx` 每 5s `listEventRuns` + **N 次 `getRun`**（每次内部还有 flags/usage N+1），100+ run 不可持续。

- 新端点 `GET /api/events/:eventId/fleet`（`run/routes.ts` 或 `events/routes.ts`）：
  ```ts
  { runs: RunPublic[], agentsByRun: Record<runId, AgentSummary[]>,
    schedulerRun: RunPublic | null, schedulerAgents: AgentSummary[],
    config: SchedulerConfig, status: SchedulerStatus }
  ```
  - runs 用 `listForEvent` 的轻量版：**不含 per-run usage**（`usageTotals` 是每 run 一条 session_entries 聚合，fleet 视图不需要；`getRun` 详情路径保留）。flags 用现有 `groupFlagsByRun` 批查。
  - agents：一条 `runId IN (...)` 查询按 run 分组。
  - scheduler run + agents 一并返回。
- `event-page.tsx` 的 fleet + scheduler 两个 query 合并为这一个；`keys.runs.fleet` 缓存键沿用。queue query 保持独立。

### W7 验证

- `bun run check` + `bun test` 全绿。
- 手测：左侧点 agent → graph 高亮且不开窗；graph 点节点 → dialog；`/events/:id/runs/:id` 404；归档折叠/展开；fleet 请求 1 个/轮询周期。

---

## 实施顺序

1. **W1**（模板，低风险，独立）
2. **W6**（计时，小而独立）
3. **W2**（队列状态机 + boot，含 queue_state 表，迁移 0006）
4. **W3**（调度者生命周期，与 W2 同一迁移文件加 scheduler_config.paused）
5. **W5**（source 通知，小）
6. **W4**（围栏语义 + gate 移除 + 自动 stop，测试面最大）
7. **W7**（前端 + fleet 端点，最后收口 UI）

每步完成后跑 `bun run check` + `bun run --filter @aegisx/server test`；全部完成后跑根 `bun test`。

## 明确不做

- graph 过滤/搜索（用户明确暂缓）。
- 队列对手动 run 的去重/认领（保持队列状态机简单）。
- 靶机槽远端状态查询、boot 自动恢复调度者/队列（除 W2.2 的 paused 写入）。

---

## 实施记录（2025 复核后）

全部 W1–W7 已实施并通过自动化验证：`bun run check` 三包全绿；`bun run --filter @aegisx/server test` 229/229，web 7/7。实施与本文的偏差：

1. **迁移编号**：仓库既有 0000–0005，新迁移为 `0006_benchmark_fixes`（queue_state 表 + scheduler_config.paused 合并一个迁移，SCHEMA_VERSION=12）。`bun run db:generate` 因既有 meta snapshot 缺失（0003–0005 为手写迁移，无 snapshot，0002 prevId 冲突）不可用，按仓库先例手写 SQL 并同步 `_journal.json`；schema-compat 测试在全新库上实际执行全部 7 个迁移验证。
2. **fleet 响应附加字段**：除文档 W7.3 所列字段外，实际响应还包含 `config`（含 paused）与 `status`——否则 event-page 合并后的单一 query 无法驱动 graph 状态按钮与 StartSchedulerDialog。
3. **W1.3 旧默认体常量**：以「当前 DEFAULT 重命名为 LEGACY + 新 DEFAULT 用 `.replace()` 增量派生」实现，保证 LEGACY 与线上已 seed 行逐字节一致（本次已用 git HEAD 逐字节比对验证）。

复核时清理：删除两处引用已删 `run-workspace.ts` 的注释；`_journal.json` 0006 的 `when` 调整为单调时间戳（drizzle 按 idx 排序，无功能影响）。

**待人工手测**（需本地环境）：
- W2.2：入队 → kill 服务端 → 重启 → 队列已暂停、pending 齐全 → 恢复后按序拉起。
- W3.1：暂停后关闭一个 run → 调度者无反应；恢复 → 收到同步消息并行动。
- W4.1：cap=4 时第 5 个 launch 被拒；close 一个后 drain 放行。
- W6：工具执行中打开 agent dialog，计时不归零。
- W7：graph 三组布局、归档折叠/展开、左侧点击只高亮不开窗、dialog 仅由 graph 节点打开、`/events/:id/runs/:id` 404、fleet 每轮询周期 1 个请求。

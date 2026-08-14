# AegisX 代码审查修复计划（2025-08）

来源：全库深度审查（server + web + shared，约 300 个源文件）。基线：216 测试全绿，`bun run check` 通过（仅存量 warning）。

分 6 个 Phase，按序实施；每个 Phase 独立可交付、可验证。**行号会漂移，定位一律以函数/符号名为准。**

## 总览

| Phase | 主题 | 价值 | 风险 | 规模 |
|---|---|---|---|---|
| P1 | 正确性：`finishing` 卡死、child 状态覆写 | 高 | 低 | 小 |
| P2 | 正确性：run 级消息游标跨 session 失效 | 高 | 低 | 小 |
| P3 | 并发加固：围栏 idle 唤醒 hole、冷恢复单飞 | 中 | 中 | 中 |
| P4 | 性能：usage 聚合 SQL 化、LiveBus 快照清理 | 中 | 低 | 中 |
| P5 | 重构与清理：service 去重拆分、小项、文档 | 中 | 中（纯重构） | 大 |
| P6 | 前端：`event-agents.tsx` 拆分 | 中 | 低（纯移动） | 中 |

---

## Phase 1 — 正确性修复（高优先级）

### 1.1 `finishing` 标志永不重置 → 崩溃后冷恢复的 run 永久 `running` 并占用并发槽

**问题**：`runs.finishing` 置 1 后全代码库无任何路径清回 0。正常流程无害（closed 行不再聚合），但崩溃恢复路径必中：

```
finish_run 置 finishing=1（teardown 尚未执行）→ 进程崩溃
→ recoverOnBoot 只写 status='closed'（finishing 仍=1）
→ 用户发消息冷恢复：restoreRunContext 把 status 翻回 'running'
→ recomputeRunStatus 的 WHERE finishing=0 守卫从此永久 no-op
→ run 在 DB 里永远是 running：
   • runningChallengeRunCount 永久占一个全局并发槽，逐步饿死排空器
   • 第二次 finish_run（WHERE finishing=0 → rows=0）永远 no-op
   • 只有手动 HTTP close/finish 能解
```

**修改**（`apps/server/src/run/service.ts`）：

1. `recoverOnBoot`：对每个 running/idle run 的 closed 转换补上重置：

```ts
updateRun(row.id, { status: "closed", finishing: false, updatedAt: ts })
```

2. `restoreRunContext`：围栏内的 status 翻转同样重置（恢复即视为新一轮生命周期，旧的 finish 意图作废）：

```ts
updateRun(runId, { status: "running", finishing: false, updatedAt: now() })
```

**测试**（`apps/server/test/run/` 新增或并入现有 service 测试）：

- 手动把某 run 置 `status='running', finishing=1` → 调 `recoverOnBoot()` → 断言行 `finishing=0, status='closed'`。
- 置 `status='closed', finishing=1` → 给 entry agent 发消息冷恢复 → 断言 `status='running'` 且 `finishing=0`；再走一次 `finish_run` 路径（或直接调 `markFinishing`）断言能再次 claim。

### 1.2 `markFinishing` 不检查 run 状态 → 迟到的 finish 对 closed run 二次 teardown

**问题**：`UPDATE runs SET finishing = 1 WHERE id = ? AND finishing = 0`——对已 closed（finishing=0）的 run，迟到的 `finish_run`（如 abort 后工具批仍执行）仍会 claim 成功，触发对已 teardown 的 run 二次 teardown、重复发 `run.finished` 事件。

**修改**（`service.ts` `markFinishing`）：

```ts
const res = sqlite.run(
  `UPDATE runs SET finishing = 1 WHERE id = ? AND finishing = 0 AND status IN ('running', 'idle')`,
  [runId]
)
```

**测试**：置 `status='closed', finishing=0` → `markFinishing` 返回 false。

### 1.3 关闭 run 时 spawn child 被 `runInBackground` 覆写为 `failed`

**问题**：`teardownRun` → `childRuntime.abortAll` 直接 dispose child session 并从 `childSessions` 删除；child 后台 `prompt()` 随后 reject，`runInBackground`（`apps/server/src/run/child-agents.ts`）继续执行 settle 分支：把 agent 标 `failed`（覆盖 teardown 刚写的 `idle`）、向已 closed 的 run 继续 `emitAgents`。

**修改**（`child-agents.ts` `runInBackground`）：`prompt()` 结束后（成功或异常），先判断是否被外部 teardown——判据是 `childSessions` 中该 agent 已被删除（`abortAll` 先删，正常路径由本函数自己删）：

```ts
try {
  await childSession.session.prompt(task)
} catch (error) {
  runError = ...
}
// 外部 teardown（run close/finish/timeout/delete）已 dispose 该 session 并
// 从 childSessions 移除：状态由 teardown 统一落库，这里直接退出。
if (!deps.childSessions.has(childAgentId)) {
  return
}
// ...原有 settle 逻辑不变
```

正常路径时序上 `runInBackground` 自己是最后删 map 的，判断在其之前，不受影响（单线程事件循环，无竞态）。

**测试**：stub host 让 child streaming 期间调 `runService.close(runId)` → 等后台 settle → 断言 child agent `status='idle'` 且 `error` 为空（而非 `failed`）。

**Phase 1 验证**：`bun run --filter @aegisx/server test`（全绿，含新增用例）+ `bun run check`。建议单独 commit。

---

## Phase 2 — run 级消息游标修复

### 2.1 `GET /runs/:id/messages` 的 `after` 游标在多 agent run 上静默丢消息

**问题**：`seq` 是 per-session 的（`unique(sessionId, seq)`），但 run 级查询（`apps/server/src/agents/session-queries.ts` `listRenderableEntries`）把多个 session 的 seq 放进同一有序流：

- `ORDER BY seq` 跨 session 交错，非时间序；
- `after`/`nextAfter` 跨 session 无意义：session A 100 条、session B 5 条时 `nextAfter=100`，B 之后追加的 seq 6…N 永远查不回来。

当前 web 端总是 `after=0` 全量拉取，掩盖了缺陷；但 SSE 重连按设计应经该接口增量重读，真用 `after` 即静默丢消息。带 `agentId` 的单 session 查询无此问题。

**方案**：run 级查询改用 **rowid** 作游标（SQLite rowid 表、append-only 场景下单调递增，无 schema 变更）：

1. `listRenderableEntries(db, scopeWhere, opts)` 增加游标模式参数：`cursor: { column: "seq" } | { column: "rowid" }`。rowid 模式下 `WHERE rowid > after`、`ORDER BY rowid`，条目仍携带各自 `seq`（backtrack / 单 agent 分页继续用 seq）。
2. `apps/server/src/run/queries.ts` `listMessages`：**run 级（无 agentId）** 用 rowid 游标；**per-agent 查询**维持 seq（语义本就正确，且 backtrack API 以 seq 为目标键）。
3. `apps/server/src/run/routes.ts` messages 路由：响应的 `nextAfter` 直接透传（run 级=rowid，agent 级=seq），在路由注释中写明两种语义。
4. web 端 `apps/web/src/api/runs.ts` `listMessages` JSDoc 注明：run 级 `after` 为 rowid 游标（当前调用点只用 `after=0`，无需改代码）。

**已知边界（接受）**：flat backtrack 删除 session 尾部行后，新插入行可能复用被删的 rowid，持有旧游标的客户端理论上会漏新行。实际无害：backtrack 后 UI 走 `store.reset(agentId)` + 全量重拉（见 `conversation.tsx`），且 SSE `message.committed` 会推送新条目。在 `listRenderableEntries` 注释中记录该边界。

**已拒绝的替代**：新增全局 `global_seq` 列（schema v12 + 回填迁移）。对本工具属于过度设计；rowid 已满足单调性与稳定性。

**测试**（`apps/server/test/agents/` 或 `test/run/`）：

- 同一 run 两个 agent 各建 session、交错写入（A 写 3 条、B 写 2 条、A 再写 2 条）→ run 级 listMessages 用返回的 `nextAfter` 增量拉取 → 断言零丢失、顺序为写入序。
- 对照旧实现写一个「会丢」的反例断言（用 per-session seq 作游标会漏 B 的后续条目），证明修复有效。

**Phase 2 验证**：server 测试全绿 + `bun run check`。建议单独 commit。

---

## Phase 3 — 并发加固

### 3.1 围栏不覆盖「warm idle run 被消息唤醒」路径（决策：补齐）

**问题**：fence 只在排空 / 直接 start / 冷恢复三处强制。向 **warm idle** run 发消息（scheduler `message_run`、用户手动、插件 `send`）直接开新轮，不经围栏：`maxConcurrentRuns=4` 时 4 running + N idle，把 idle 全部唤醒即可无限超帽——idle→running 同样烧模型算力。scheduler 持有 `message_run` 强工具，这是失控烧 token 的真实通道。

**决策**：补齐围栏。fresh turn（非 steer/followUp）开始前，若目标 run 当前 idle 且为 challenge-scope，则在**全局 fence 锁内**原子地「检查围栏 + 把 run 翻成 running」（与 create/restore 的占位方式一致，避免 TOCTOU）。满帽 → 抛 `RunActionError('capacity', …)` → HTTP 429 / 工具调用返回原因。

**修改**：

1. `apps/server/src/agents/lifecycle.ts`：`SessionLifecycleOptions` 新增可选异步钩子：

```ts
/** Fresh-turn gate（send 的非 streaming 分支、drive 之前、agent 锁内调用）。
 * 抛错 = 放弃该轮（send 直接向调用方传播）。steer/followUp 不经过此钩子。 */
onTurnGate?(id: string): Promise<void>
```

   `send()` 的非 streaming 分支中，`onBeforeNewTurn` 之前调用 `await options.onTurnGate?.(id)`。`drive()` 直呼路径（`deliverToParent`、系统 prime）**不经** gate——内部派发（如 child 结果投递 parent）不允许被容量拒绝丢消息。

2. `service.ts` 装配处实现钩子：

```ts
onTurnGate: async (agentId) => {
  const runId = runIdOf(agentId)
  if (!runId) return
  const row = queries.getRow(runId)
  if (!row || row.scopeType !== "challenge" || row.status !== "idle") return
  await withFence(async () => {
    const decision = checkLaunchFence(db, options.getSettings(), {
      scopeType: "challenge",
      eventId: row.eventId,
      challengeId: row.challengeId,
    })
    if (!decision.ok) throw new RunActionError("capacity", decision.message)
    // 原子占位：与 create/restore 相同的占位语义；后续 onTurnStart 的
    // recompute 会把它维持为 running。gate 抛错则 run 保持 idle。
    updateRun(runId, { status: "running", updatedAt: now() })
  })
}
```

   **锁序说明**：agent 锁内取 fence 锁（agent→fence）。现有 fence 持有段（`create` 的 check+insert、`restoreRunContext` 的 check+flip）不获取任何 agent 锁，无环。把该结论写进 `withFence` 的注释。

3. **插件回调的容错**：插件 `on()` 回调里的 `send()` 被 gate 拒绝时会抛 `RunActionError`——`RunEmitter.emit` 已有 try/catch（log + 吞），不会冒泡；observer 唤醒丢失属可接受降级。在 `run-handle.ts` `RunEmitter` 注释中补充此行为。

4. **冷恢复不双重检查**：冷恢复路径 `restoreRunContext` 已在 fence 内 flip 成 running → gate 看到 `status='running'` 直接跳过，无重复检查。

**测试**：

- stub host；cap=1，run A running；向 run B（warm idle）的 entry agent 发消息 → 期望抛 capacity；关闭 A 后重发 → 成功且 B 变 running。
- streaming 中 steer 不受 gate 影响（run 已 running，gate 短路）。
- child settle → `deliverToParent` 驱动 parent 新轮不经过 gate（确认 drive 路径无钩子）。

### 3.2 `restoreRunContext` 无 per-run 单飞 → 并发冷恢复互相拆容器

**问题**：`prepareAgent` 的 `if (!contexts.has(runId)) await restoreRunContext(...)` 可重入：同时向同一 closed run 的两个 agent 发消息（scheduler `message_run` + 用户手动），两个 restore 并行——`createToolboxContainer` 先 `remove` 同名容器再 create，第二个会拆掉第一个刚建好的容器。

**修改**（`service.ts`）：加 per-run restore promise 共享：

```ts
const restoring = new Map<string, Promise<void>>()

function restoreRunContextOnce(runId: string, row: typeof runs.$inferSelect) {
  const existing = restoring.get(runId)
  if (existing) return existing
  const p = restoreRunContext(runId, row).finally(() => {
    if (restoring.get(runId) === p) restoring.delete(runId)
  })
  restoring.set(runId, p)
  return p
}
```

`prepareAgent` 改调 `restoreRunContextOnce`。**注意**：并发的第二个调用者拿到同一个 promise，成功后各自继续 prepare 自己的 agent；失败时两者都收到异常，`restoreRunContext` 的 catch 已负责把 run 翻回 closed。

**测试**：stub host 慢速 create；并发向 closed run 的两个 agent `send` → 断言容器 `create` 只被调用一次、无 `remove` 二次调用、两个 agent 均在线。

**Phase 3 验证**：server 测试全绿 + `bun run check`。建议单独 commit。

---

## Phase 4 — 性能

### 4.1 usage 聚合 O(N) 全量 JSON.parse → SQL 聚合

**问题**：`sumUsageTotals`（`apps/server/src/agents/session-queries.ts`）每次 select 全部 `session_entries.data` 并逐行 `JSON.parse`。调用点挂在高频路径：每个 turn start/settle、flag、compaction 后的 `emitRun → queries.get → usageTotals(runId)`。长跑 run（数千 entries）每 turn 边界一次 O(N)，累计 O(N²)。

**修改**：`sumUsageTotals` 改为单条聚合 SQL（SQLite JSON1，行内 `type` 列已反范式化可直接用）：

- 各 token 字段：`SUM(CASE WHEN type IN ('compaction','branch_summary') THEN CAST(COALESCE(json_extract(data,'$.usage.input'),0) AS REAL) WHEN type='message' AND json_extract(data,'$.message.role') IN ('assistant','toolResult') THEN CAST(COALESCE(json_extract(data,'$.message.usage.input'),0) AS REAL) ELSE 0 END)`（input/output/cacheRead/cacheWrite/reasoning 同构，reasoning 路径 `$.message.usage.reasoning` / `$.usage.reasoning`）；
- cost：`$.message.usage.cost.total` / `$.usage.cost.total`；
- turns：`COUNT` + CASE（assistant message）；
- cacheHitRate：单独一条 `SELECT ... WHERE <scope> AND type='message' AND json_extract(data,'$.message.role')='assistant' AND (input+cacheRead+cacheWrite)>0 ORDER BY rowid DESC LIMIT 1`，rate 在 JS 算。

用 drizzle `sql` 模板 + `sqlite.all`（或 `db.all`）执行。`totalTokens` 仍按 pi 公式在 JS 合成（input+output+cacheRead+cacheWrite，见 `entry-usage.ts` 注释）。

**保持不变**：`accumulateEntryUsage`（JS 累加器）继续服务 `computeContextSample`（内存 entries 的实时 stat strip）与作为 SQL 版的对照实现。

**测试**：新增 parity 测试——随机生成含 assistant/toolResult/compaction/缺 usage/坏 JSON 字段的 entries 落库，断言 SQL 聚合结果与 `accumulateEntryUsage(readSessionEntries(...))` 完全一致（含 turns、cacheHitRate、undefined/0 语义对齐：`sumUsageTotals` 现有「全零返回 undefined」的行为保留）。现有 `test/events/usage.test.ts` 保持绿。

### 4.2 LiveBus 快照只增不减

**问题**：`apps/server/src/agents/live.ts` 的 `lastRun`（按 channel）、`lastContext`/`lastQueue`/`lastActivity`/`runningTools`（按 agentId）只在 `close()` 全清；长期运行内存缓慢增长。

**修改**：

1. `LiveBus` 增加 `forget(channel: string, agentIds: string[])`：删除该 channel 的 `lastRun` 及各 agentId 的全部快照。
2. `service.ts` `teardownRun` 末尾调用 `bus.forget(runId, agents.map(a => a.id))`。SSE 重连 replay 依赖这些快照，run 已 closed 不再有新订阅者需要 replay；若 closed run 后续被冷恢复，新事件会重建快照。

**测试**：`test/agents/live-bus.test.ts` 增补 forget 用例。

**Phase 4 验证**：server 测试全绿 + `bun run check`。建议单独 commit。

---

## Phase 5 — 重构与清理（纯重构，行为不变）

### 5.1 `run/service.ts` 去重与拆分（2381 行）

原则：**对外返回对象形状不变**，只做内部拆分与去重；现有 216 测试是行为护栏。

1. **合并模型切换**：`switchModel`（run 级，取 entry agent）与 `switchAgentModel`（per-agent）几乎逐行重复。抽 `switchAgentModelById(agentId, input)`；`switchModel` = 取 entry id 后委托。
2. **抽 `buildRunContext(...)`**：`create()` 与 `restoreRunContext()` 的平行段（容器参数组装、promptContext 构建、`contexts.set`、emitter 创建、`buildHandleHost` + `runSetup` 调用）合并为一个参数化函数；差异（initialPrompt override、prime 处理、fence/占位）留在各自调用方。
3. **抽 `run/agent-session-ops.ts`**：`mainAgentRunOf` / `requireIdleAgent` / `disposeLiveAgent` / `rebuildAgentSession` / `listAgentSessions` / `createAgentSession` / `activateAgentSession` / `backtrackAgent` 整体迁出，通过 deps 对象（db、queries、lifecycle、contexts、withLock、emit*、now）注入。
4. **抽 `run/model-resolver.ts`**：`defaultModelRef` / `resolveModelTarget` / `resolveSlotModelFromRef` / `resolveSlotModel` / `resolveModelDisplay`（依赖 configStore + providers 回调）。
5. 拆分后 `service.ts` 目标 ≤ ~1400 行（生命周期编排主体）。

### 5.2 小项清理

| 项 | 位置 | 修改 |
|---|---|---|
| 过时注释（grep/find/ls） | `run/container/container-manager.ts`（capture 注释）、`run/workspace/backend.ts`（文件头）、`run/workspace/tool-prompts.ts` 如有 | 更新为 read/write/edit + bash 现状 |
| `list` fallback 丢目录标记 | `backend.ts` `list`：`ls -1Ap ... || ls -1A`（fallback 无 `-p`，目录 `/` 后缀缺失） | 简化为单条 `ls -1Ap`（Kali GNU ls 恒支持） |
| `Database` 类型重复别名 | 8+ 文件各写 `type Database = ReturnType<typeof createDatabase>["db"]` | `db/index.ts` 导出 `export type Database = ...`，全部改 import |
| `unbound-method` warnings | `platforms/targets.ts`、`agents/lifecycle.ts`、`run/queue.ts`、`run/service.ts`、`events/routes.ts`、`settings/routes.ts`、`providers/routes.ts`（`bun run check` 输出清单） | method 引用处显式 `this: void` 标注或改箭头函数，直到 check 无该类 warning |
| 服务端消息语言不统一 | `service.ts`（"子 agent 不支持会话操作"、"Agent 正在运行…" 等） | 约定：**模型可见文本（工具描述/结果）与 API 错误消息一律英文；web UI 文案中文**。将散落的中文 RunActionError 消息改英文 |
| 队列跨 event 顺序名不副实 | `run/queue.ts` `pendingItems` | **决策：接受现状，补注释**——`ord` 为 per-event，跨 event 排空顺序未定义但不饥饿（低 ord 项恒可启动）；单用户下无公平性需求。不引入全局 ord（会破坏 per-event reorder 语义） |
| 文档漂移 | `docs/orchestration-redesign.md` §3 | 附录注明：插件 API 已演进为声明式 `agents` + `wire()`（取代 `setup()`/`createAgent`/`prime` 文本），以 `orchestration/types.ts` 为准 |

### 5.3 安全备注记录（不改代码）

在 `docs/orchestration-redesign.md` 或新增小节记录已接受的提示注入面：challenge 名称/描述来自远端平台，经 handlebars `noEscape` 进入 system prompt / initial prompt；scheduler 持 `start_run`/`enqueue_run` 等强工具，恶意平台数据理论上可间接驱动其烧 token。CTF 场景接受该风险；若未来接入不可信平台需加净化层。

**Phase 5 验证**：`bun run check`（无新增 warning）+ 全量 `bun run test` 全绿 + `bun run build`（web）通过。建议按 5.1 / 5.2 各一个 commit。

---

## Phase 6 — 前端拆分（纯移动，不改逻辑）

### 6.1 `event-agents.tsx`（1742 行）拆分

按现有内部组件边界拆到 `apps/web/src/features/events/` 下（均为**原样搬移**，仅调整 import 与导出）：

| 新文件 | 内容（原文件内符号） |
|---|---|
| `event-agents-shared.ts` | `UNCATEGORIZED`、`POLL_INTERVAL_MS`、`ROLE_LABELS`、`roleLabel`、`isAgentFinished`、`agentFinishBadge`、`TimelineEvent` 类型、`TIMELINE_ICONS`、`SCHED_NODE_ID`、`NODE_DIM`、`EDGE_STYLE`、`GRAPH_NODE_TYPES` |
| `timeline-tab.tsx` | `buildTimeline`、`TimelineTab` |
| `challenges-tree-tab.tsx` | `ChallengesTreeTab`、`ChallengeRow` |
| `plan-tab.tsx` | `PlanTab` |
| `runs-tab.tsx` | `RunsTab`、`RunRow` |
| `agents-tab.tsx` | `AgentsTab` |
| `agents-graph.tsx` | `AgentsGraph`、`layoutWithDagre`、`buildAgentsGraph`、`GraphNodeShell`、`SchedulerGraphNode`、`RunGraphNode`、`AgentGraphNode` |
| `agent-dialog.tsx` | `AgentDialog` |
| `scheduler-config-tab.tsx` | `SchedulerConfigTab`、`SchedulerConfigFields`、`StartSchedulerDialog` |
| `event-agents.tsx` | 仅保留 `EventAgents` 编排壳 |

约束：不动 `apps/web/src/components/ui/**`（只读）；不引入新依赖；props 签名不变。`conversation.tsx`（937 行）本次不拆（内聚度尚可，留待后续）。

**Phase 6 验证**：`bun run --filter @aegisx/web check` + `bun run build` 通过；手测 event 页五个 tab、Agents Graph、agent 弹窗、scheduler 配置正常。

---

## 全局验证与完成标准

每个 Phase 完成后（按序）：

```sh
bun run check          # oxlint + type-check + oxfmt，不引入新 warning
bun run test           # 全 workspace 测试全绿
bun run build          # P5/P6 必跑；P1–P4 可选
```

完成定义：P1–P4 新增测试全绿且覆盖文中场景；P5 重构后现有测试零修改通过（除非测试直接引用被移动的内部符号）；P6 纯移动 diff 可审（移动文件 + import 调整）。

## 明确不做（本轮）

| 项 | 理由 |
|---|---|
| `session_entries` 全局 `global_seq` 列 | rowid 游标已满足；见 P2 已拒绝替代 |
| 队列全局 ord / 跨 event 公平调度 | 单用户无公平性需求；会破坏 per-event reorder 语义（P5.2 仅补注释） |
| scheduler 提示注入净化层 | CTF 场景接受；仅文档记录（P5.3） |
| `conversation.tsx` 拆分 | 内聚度尚可，后续单独处理 |
| service 全面分层重写 | 仅做 5.1 列出的去重/拆分，避免大爆炸重构 |

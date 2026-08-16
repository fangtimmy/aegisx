# v9 编排简化：执行规划 + Handoff 提示词

状态：**待执行**
设计依据：[orchestration-v9-simplify.md](orchestration-v9-simplify.md)（行为规范，唯一真相源）
本文件把重构拆成 7 个独立可验证的工作包（WP），每个 WP 结束时 `bun run check` + 相关测试必须全绿并 git commit。禁止跨 WP 提前实施。

---

## 总则（对每个 WP 都成立）

### 验证命令

```sh
bun run check                 # oxlint + 类型检查 + oxfmt（全 workspace）
bun run test                  # 全量测试
cd apps/server && bun test test/run/xxx.test.ts   # 单文件
bun run db:generate           # 仅 WP2 用（drizzle 迁移生成）
```

### 铁律（写进每个 handoff 提示词）

1. 只做当前 WP 清单内的事。禁止顺手重构、改无关代码、改 `apps/web/src/components/ui/**`、改 AGENTS.md。
2. 修复报错以类型检查器和测试为准。**禁止**用 `as any`、注释掉代码、删除/弱化断言、吞错误来"让检查通过"。
3. 遇到设计文档没覆盖的情况或无法解决的错误：**停止并报告**，不要即兴设计新机制。
4. 匹配周边现有代码风格（导入排序、注释风格、命名）。
5. 每个 WP 一个 commit，消息格式 `refactor(v9-wpN): <摘要>`；测试新增/适配算进同一 commit。
6. 完成后输出报告：改动文件列表、关键取舍、与规范的偏差（应为零）、验证命令输出摘要。

### 全局不变量（改完后必须仍成立，WP3a/WP4 测试要覆盖）

per-agent 锁+代次；run 状态 SQL 派生；`finishing` 原子置位；fence 三处强制；队列 FIFO + failed 通知；两阶段超时；冷恢复 = fence + 重建容器 + 快照 open session，**不碰未被触发的 agent**；per-agent 模型切换；paused 门控；scheduler start/reset 语义。

---

## WP1：shared 类型与输入扩展（纯增量，无行为变化）

**目标**：新输入形状落进类型层，尚不接线。

1. `apps/shared/run.ts`（或 model 相关文件）新增：

```ts
/** 单个 solver 的创建规格。 */
export type SolverSpec = {
  /** canonical model ref；缺省 = 全局默认模型。 */
  model?: string
  /** 该 solver 专属提示词。 */
  prompt?: string
  /** strategy（默认）= 渲染 initial、prompt 进 Strategy 段（与 run 级叠加）；
   *  override = 完全替换 initial。 */
  promptMode?: "strategy" | "override"
}
```

2. `apps/server/src/run/run-factory.ts` 的 `CreateRunInput`：新增 `strategy?: string` 与 `solvers?: SolverSpec[]`（**保留** `orchestration?: string`，本 WP 不动它）。
3. `apps/shared/run.ts` 的 run 创建请求类型同步加 `strategy / solver_count / model / solvers` 字段（供 web api 层用）。

**验收**：`bun run check` 全绿；无任何行为变化（字段无人消费）。

---

## WP2：schema v14 + orchestration 引用机械清除

**目标**：迁移到位；`orchestration` 字段从持久层和所有展示层消失；插件层本 WP **不删**（内存中仍注册，create 暂以常量查找）。

1. `apps/server/src/db/schema.ts`：`SCHEMA_VERSION = 14`；删 `runs.orchestration` 列、`runs_orchestration_idx` 索引、`run_queue.orchestration` 列。
2. `bun run db:generate` 生成 `0008_*.sql`，**手改**：在 DDL 前加（注意先 DROP INDEX 再 DROP COLUMN，SQLite 限制）：

```sql
DROP INDEX IF EXISTS runs_orchestration_idx;
DELETE FROM session_entries; DELETE FROM sessions; DELETE FROM agents;
DELETE FROM runs; DELETE FROM run_queue;
DELETE FROM prompt_templates WHERE plugin != 'builtin' OR key = 'childSystem';
```

（wipe 执行态是设计 §4.1 定死的；不要 wipe 目录/flags/配置表。）
3. 类型错误驱动的机械清理（逐个修，不许即兴）：
   - `run/public.ts`：`toRunPublic` 删 orchestration 映射；`RunPublic`（shared）删 `orchestration` 字段。
   - `run/run-factory.ts`：create/restore 里 `requirePlugin(input.orchestration ?? "classic")` → `requirePlugin(input.scopeType === "event" ? "scheduler" : "classic")`（plugin 仅剩内存查找作用，下个 WP 删）。
   - `run/queue.ts`：enqueue upsert key 从 `(challengeId, orchestration)` 改为 `challengeId`；删 orchestration 读写。
   - `run/scheduler-admin.ts` / `run/scheduler-tools.ts`：`resolveAndCreate` 删 orchestration 参数；`enqueue` 默认值不再传；`RunSummary` / `queueItemText` / `list_runs` 输出删 orchestration。
   - `run/routes.ts`：`runInput` 删 `orchestration` 字段。
   - web 引用点（`timeline-tab` / `agents-graph` / `queue-list` 等 `run.orchestration` 展示）：删除该标签展示（本 WP 只删不补，新 UI 在 WP5）。
4. 测试适配：`test/run/queue.test.ts`（upsert key）、`test/db/schema-compat.test.ts`（版本号）、其余按失败点机械修。

**验收**：`bun run check` + `bun run test` 全绿；`grep -rn "orchestration" apps/server/src apps/web/src apps/shared` 仅剩：插件目录自身文件（`orchestration/` 目录、`orchestration-config` 路由/web api、settings 编排 tab——WP3/WP5 删）与注释。

---

## WP3a：插件层删除 + run-factory 直建（核心，最高风险）

**目标**：删除全部插件机械；challenge run 直建 N 个 solver（per-solver 模型与提示词两模式）；event run 直建调度者 + 内建唤醒；冷恢复不再重跑"声明"。

### 3a.1 删除文件

- `orchestration/{registry,classic,observer-solver,bootstrap-solver,trio,common,scheduler}.ts`
- `orchestration/run-handle.ts` 中 `RunEmitter` / `createRunHandle` / `RunHandleHost` / `AgentHandle` / `RunHandle` 全删；**保留** `EventScopeEmitter`，移到新文件 `orchestration/event-scope.ts`。
- `orchestration/types.ts` 瘦身为：`PromptContext`（删 `orchestrations` 变量）、`Capabilities` + `deriveCapabilities`（**删 `canSpawn`**）、`EventScopeEvent` / `EventScopePayload`。`run.multiSolver: boolean` 加入 `PromptContext.run`。
- `test/orchestration/` 下 `classic / observer-solver / bootstrap-solver / trio / scheduler / run-handle / types` 测试删除（`prompt-templates*.test` 保留并适配）。

### 3a.2 prompt 模块

- `prompt-defaults.ts`：
  - 删除 `LEGACY_CHILD_SYSTEM_PROMPT_TEMPLATE`、`DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE`、trio/observer/bootstrap 常量、`LEGACY_ORCHESTRATOR_*` 三代常量中无引用者。
  - `mainSystem` 新默认 = 现 `DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE` 删 spawn/`read_agent` 相关段 + 加多 solver 协作段（`{{#if run.multiSolver}}`：「你与其他 solver 共享工作区。开局先写 `SOLVER-<slot 序号>.md` 声明你的角度与计划，动手前读同伴笔记；所有产物用独立文件名，绝不覆盖他人文件。」）。现 body 存为 `LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE_V9` 供一次性刷新。
  - `orchestratorSystem` 新默认 = 现值删「Available orchestrations」段、工具清单同步 WP4 后形态（enqueue/start 无 orchestration、含 add_agent/message_agent）、加 per-solver 提示词与 add_agent 的用法段。现 body 存为 `LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V9`。
  - 新增 `DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE`（内容取自被删的 scheduler.ts 插件 `templates.initial`，即现 `DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE`——文件里已有，保留并转正）。
  - `initial` 模板不动（Strategy 段机制不变）。
- `prompt-templates.ts`：`BUILTIN_DEFAULTS` 变 4 键（mainSystem / initial / orchestratorSystem / schedulerInitial）；`loadTemplateMap(db)` 删 plugin 参数（只查 `plugin='builtin'`）；删 `seedPluginTemplates`；`PROMPT_TEMPLATE_VARIABLES` / `samplePromptContext` 同步（删 canSpawn，加 run.multiSolver）。shared 里 `PromptTemplateContext` 同步。
- `run/service.ts`：删 `bootOrchestration` 调用与 import，改为一行 `seedBuiltinTemplates(db)` + 保留 `migrateLegacyPromptSettings`；模板刷新调用更新为两对新常量（mainSystem、orchestratorSystem），删 childSystem/initial/orchestratorSystem 旧刷新对；追加一次性清理 `DELETE FROM prompt_templates WHERE plugin != 'builtin'`（幂等，防 WP2→WP3a 窗口期 plugin 行复活）。

### 3a.3 run-factory 重写（函数级规格）

删除：`runSetup` / `buildHandleHost` / `buildRunContext` 中插件相关参数与 `slotOverrides`；`RunContext` 删 `childTemplate`、`defaultModelRef` 保留（spawn child 已无消费者，仅作 run 默认模型 ref）；`resolveSlotModel` 调用全删。新增：

```ts
const MAX_SOLVERS_PER_RUN = 4
const SOLVER_TOOLS = (targetSupported: boolean): string[] =>
  ["submit_flag", "finish_run",
   ...(targetSupported ? ["get_target","start_target","extend_target","stop_target"] : [])]

/** 渲染第 i 个 solver 的首轮提示词。 */
function solverInitial(templateMap, ctx, runStrategy, spec): string {
  if (spec.promptMode === "override" && spec.prompt) return spec.prompt
  const strategy = [runStrategy, spec.prompt].filter(Boolean).join("\n\n")
  return renderTemplate(templateMap, "initial", { ...ctx, ...(strategy ? { strategy } : {}) })
}

/** challenge 域：直建 N 个 solver 行并逐个 prime。 */
async function createSolvers(runId, ctx, templateMap, solvers: SolverSpec[], runStrategy) {
  // for i: slot = `solver-${i+1}`；model = modelResolver.resolveSlotModelFromRef(solvers[i].model ?? null)
  //   systemPrompt = renderTemplate(mainSystem, { ...ctx, agent:{...}, capabilities: deriveCapabilities(SOLVER_TOOLS), model })
  //   insert agents 行 { slot, role:"solver", name:`Solver ${i+1}`, isEntry: i===0, model, systemPrompt, tools }
  //   prepareAgent → send(solverInitial(...))
}
```

- create(challenge)：解析 `input.solvers`（空 → `[{}]`；长度 1..`MAX_SOLVERS_PER_RUN`，越界抛 `RunActionError("invalid_state")`）；每个 ref 入口 `resolveSlotModelFromRef` 校验（不可解析即启动失败，错误信息含 ref）；run.model = solver-1 的 concrete ref；容器/fence/insert 逻辑不变；随后 `createSolvers`；emit `run.started`。
- create(event)：调度者模型 = `getSchedulerConfig(eventId).modelId ?? modelResolver.defaultModelRef()` 经 `resolveSlotModelFromRef`；insert orchestrator 行（slot `orchestrator`、entry、tools = §3a.4 清单、systemPrompt = render(orchestratorSystem)）；`attachSchedulerWakeup`（下条）；prime = render(schedulerInitial, ctx)。
- **内建唤醒**（替代 scheduler 插件的 wire，文案逐字保留）：

```ts
function attachSchedulerWakeup(eventId: string, sendToOrch: (text: string) => Promise<void>) {
  const emitter = eventHandleFor(eventId)  // EventScopeEmitter（惰性建）
  emitter.on("run.started",  e => void sendToOrch(`Run ${e.runId} 已启动${e.source === "manual" ? "（手动启动，由用户管理）" : ""}。`))
  emitter.on("run.idle",     e => void sendToOrch(`Run ${e.runId} 转入 idle${e.failed ? "（有 agent 失败）" : ""}。`))
  emitter.on("run.flagAccepted", e => void sendToOrch(`Run ${e.runId} 解出 flag。`))
  emitter.on("run.finished",    e => void sendToOrch(`Run ${e.runId} 已完成。`))
  emitter.on("run.timedOut",    e => void sendToOrch(`Run ${e.runId} 超时（${e.outcome}），决定延长/关闭/重排。`))
  emitter.on("run.resumed",     e => void sendToOrch(`Run ${e.runId} 已恢复。`))
}
```

  challenge/event 的 buildRunContext 都在恢复时重建它（event 域才挂）；`EventScopeEmitter.close()` 时机不变（scheduler run close 清空）。`sendToOrch` = `lifecycle.send(orchestratorAgentId, text)`；回调内 try/catch 已由 emitter 保证。
- restore：**不再创建任何 agent 行**。只做：fence + status 翻转 + 重建容器/modelRuntime/promptContext + （event 域）`attachSchedulerWakeup` + arm timers + emit `run.resumed`。session 由 prepareAgent 按快照惰性 open（现状不变）。
- `CreateRunInput` 删 `orchestration` 字段（WP1 加的 `strategy/solvers` 此处接线）。

### 3a.4 工具快照清单

- solver：`SOLVER_TOOLS(targetSupported)`（见上；**不含** spawn/read/message/list_agents）。
- orchestrator（WP3a 快照先写全，工具实现 WP4 补）：`enqueue_run, list_queue, remove_queue, clear_queue, reorder_queue, start_run, stop_run, message_run, close_run, read_run, set_run_timeout, list_challenges, get_challenge, list_runs, get_status, list_agents, add_agent, message_agent`。
- `run/tools.ts` 本 WP 不动（has-gating 自然不授予已删名字；WP3b 清定义）。

### 3a.5 测试

- `test/helpers.ts` / `support.ts`：run 创建 helper 的 `orchestration` 参数换成 `solvers`/`strategy`。
- 适配：service-create / lifecycle / timeout / finish-recovery / restore-singleflight / scheduler-events / scheduler-queue / sessions / agent-actions。
- 新增 `test/run/service-multisolver.test.ts`：
  - N=3 创建：3 个 agent 行（solver-1 entry）、三个 prime 文本各自到达 fake host、N>1 时 systemPrompt 含 multiSolver 段（N=1 不含）；
  - per-solver 提示词：override = 原文 prime；strategy = initial 渲染含 run 级+solver 级两段；
  - solvers 长度 >4 拒绝；model ref 不可解析拒绝；
  - finish 竞态：两个 solver 同时 finish_run，一个 teardown 一个 no-op（沿用现有多 agent 测试手法）。

**验收**：`bun run check` + `bun run test` 全绿；`fd . apps/server/src/orchestration` 只剩 `event-scope.ts`、`types.ts`、`prompt-defaults.ts`、`prompt-templates.ts`；旧库启动迁移成功（可临时拷 data/ 下 DB 验证后丢弃）。

---

## WP3b：spawn child 全链删除（机械）

1. 删 `run/child-agents.ts`、`test/run/child-agent-prompt.test.ts`、`test/run/service-child-teardown.test.ts`。
2. 清引用：`service.ts`（childRuntime/childSessions/deliverToParent/MAX_CHILDREN_PER_RUN/childSessions 清理循环）、`run-factory.ts`（deps/RunContext.childTemplate/buildAgentToolContext 的 spawnChild 等）、`deadlines.ts`（streamingAgentIds 只剩 lifecycle 一路）、`teardown.ts`（child 分支）。
3. `run/tools.ts`：删 `spawn_agent` / `read_agent` / `message_agent` / `list_agents` 工具定义与 `RunToolContext` 对应回调（spawnChild/messageAgent/getAgent/listAgents）；`lastAssistantText` 保留（scheduler read_run 用）。capabilities 的 canSpawn 已在 WP3a 删。
4. `agents.parentAgentId` 列保留（恒 null，不迁移）。
5. 测试：`test/run/tools.test.ts` 删对应用例。

**验收**：全绿；`rg -n "spawn|childRuntime|childSessions" apps/server/src` 无结果（注释除外）。

---

## WP4：调度者工具现代化 + add_agent + agent 级寻址

1. **队列透传**（修 field-findings §0 bug 残余）：`queue.ts` `EnqueueInput` 增 `strategy? / model? / solverCount? / solvers?`，序列化进 `params` 列；drainer `launch` 读取 `item.params` 透传给 `resolveAndCreate`；`resolveAndCreate` 签名改为 `{ challengeId, strategy?, model?, solverCount?, solvers?, timeoutMs?, source, queueItemId? }` 并映射到 `create`（model 应用于全部 solver；solvers 优先于 model/solverCount）。`run_queue.prompt` 列继续存 run 级 strategy。
2. **enqueue_run / start_run 工具**：删 orchestration/params 参数；增 `strategy? / model? / solver_count? / solvers?`（solvers 数组元素 = `{ model?, prompt?, prompt_mode? }`）。model 不可解析时抛错且**错误文本列出全部可用模型 ref**（从 `providers()` 派生）。
3. **add_agent**（服务 + 路由 + 工具）：
   - `run-factory.ts` 新增 `addAgent(runId, spec: { model?, prompt, promptMode? })`：
     - 现有 solver 数 ≥ `MAX_SOLVERS_PER_RUN` → 抛 invalid_state；
     - run closed → 先走既有 `restoreRunContextOnce`（fence 在内；**不 prepare 任何旧 agent**）；running/idle 直接继续；
     - slot = `solver-{maxSolverIndex+1}`；model/提示词渲染同 create（override 模式下 prompt 即首轮）；insert 行（isEntry=false）→ prepare → send。run.model 不变。
   - `POST /api/runs/:runId/agents`（body `{ model?, prompt, promptMode? }`，prompt 必填）→ service 暴露 `addAgent`。
   - 工具 `add_agent(run_id, prompt, model?, prompt_mode?)`。
4. **message_agent 工具**（跨 run 按 agent 寻址）：包装既有 `service.sendAgentMessage(agentId, {text, deliverAs})`；closed run 的冷恢复语义由该路径既有实现承担。
5. **read_run 参数化**：`read_run(run_id, agent_id?, last_n?=10)`——默认 entry；输出 = 状态头（agent status / run status / createdAt 起算 elapsed / deadline 剩余 / 最近一条消息时间）+ 该 agent 最近 `last_n` 条 renderable 消息（assistant 给正文、tool/toolResult 给一行摘要、user 给正文，总字符预算 20k 截断）+ `lastAssistant` 兜底。数据走 `queries.listMessages(runId, { agentId })` 取尾。
6. **orchestratorSystem 刷新核对**：确认 WP3a 的新模板与最终工具面一致（不一致在此修正 + 更新 LEGACY 常量对）。
7. 测试：
   - `test/run/service-add-agent.test.ts`：running 加（新 agent prime 到达、旧 agent 无新 turn）；idle 加；closed 加（容器重建、旧 agent session 未 open、run.status 翻 running）；cap 拒绝；override/strategy 两模式。
   - scheduler 工具测试：enqueue 带 model/solvers 落 params、launch 透传（fake create 断言收到的 solvers）；model 幻觉拒绝（错误含可用列表）；read_run agent 级返回形状。

**验收**：全绿；手动 smoke：起 server，创建 1-solver run → `POST /api/runs/:id/agents` 加第二个 → SSE 可见两个 agent 各自 turn。

---

## WP5：web 前端

1. 删 `api/orchestrations.ts`、`api/orchestration-config.ts`、`keys.ts`/`types.ts`/`index.ts` 对应导出；`App.tsx` 删 `/settings/orchestration` 路由与 redirects（改指 `/settings/general`）；`settings-screen.tsx` 删编排 tab。
2. `create-run-dialog.tsx` 重做表单：solver 数 stepper（1–4）；模型选择（复用 `model-switcher.tsx` / 设置页模型 widget 的数据源——providers API）；run 级 strategy 文本域（原 prompt 字段改名 strategy）；「高级」折叠 = 逐 solver 行（模型 + 提示词 + 模式 strategy/override）；提交体 `{ strategy, solver_count, model?, solvers? }`。删除编排选择器与 ORCHESTRATION_LABELS。
3. run 详情页（`agent-dialog.tsx` / `run-overview.tsx` 一带）：加「添加 solver」入口（弹窗：model + prompt + mode → `POST /api/runs/:id/agents`）；agent 列表展示 slot/model。
4. 提示词模板编辑（`prompt-editor.tsx` / settings 路由消费方）：键列表收敛为 4 键平铺（后端 BUILTIN_DEFAULTS 已变，前端去掉分组概念）。
5. 清理 orchestration 残留展示（WP2 已删数据字段，此处删 UI 空壳）。

**验收**：`bun run check` + `bun run build`（web）通过；手动 smoke：弹窗建 2-solver run、详情页加第 3 个 solver。

---

## WP6：收尾清扫

1. `rg -ni "orchestrat|plugin|spawn_agent|childSystem|agentModels"` 全仓扫尾：删死注释/死常量/死导出（`knip.json` 已配置，跑 `bunx knip` 参考但以人工判断为准）。
2. `docs/orchestration-redesign.md` 头部加「**SUPERSEDED by v9**」标注；`docs/orchestration-v9-simplify.md` 状态改「已实施」；README 的 Schema v8 段落更新为 v9 一句话。
3. 全量 `bun run check && bun run test && bun run build`。
4. 用户验收清单走查（设计稿 §十 不变清单逐条 + WP4 smoke）。

---

# Handoff 提示词

用法：**一个 WP 一个会话**。先贴「主提示词」，再贴对应 WP 提示词。会话结束检查 commit 与验证输出后，再开下一个 WP。WP3a 风险最高，建议你本人重点 review 该 diff。

## 主提示词（每个会话都先贴）

```text
你是 AegisX 仓库（/Users/timmy/Projects/aegisx，Bun monorepo：apps/server + apps/web + apps/shared）的执行工程师，负责实施 v9 编排简化重构的某个工作包（WP）。

先按顺序通读：
1. AGENTS.md（项目规则）
2. docs/orchestration-v9-simplify.md（设计定稿，行为唯一规范）
3. docs/v9-execution-plan.md 中本 WP 的章节（含总则）

铁律：
- 只做本 WP 清单内的事；每行改动都能追溯到清单条目。禁止顺手重构、改无关代码、改 apps/web/src/components/ui/**。
- 修错以类型检查器和测试为准。禁止 as any、注释代码、删/弱化断言、空 catch 来"消音"。
- 设计未覆盖或连续两次尝试仍解决不了的错误：停下来，写清现象与你的分析，等指示。不要发明新机制。
- 匹配周边代码风格（含导入排序、注释语言）。
- 开始前先跑 bun run check && bun run test 确认基线为绿（不绿先报告，不要动手）。

完成定义（缺一不可）：
1. 本 WP 验证命令全绿（规划中注明）。
2. git add 相关文件 + commit，消息：refactor(v9-wp<N>): <一句话>。
3. 输出报告：改动文件列表 / 关键取舍 / 与规范的偏差（应为零）/ 验证命令最后 20 行输出。

现在告诉我你已读完三份材料并复述本 WP 的任务清单（不超过 15 行），然后开始。
```

## WP1 提示词

```text
执行 docs/v9-execution-plan.md 的 WP1：shared 类型与输入扩展（纯增量）。
要点：SolverSpec 类型进 apps/shared；CreateRunInput 加 strategy/solvers（orchestration 字段保留不动）；shared 的创建请求类型加 strategy/solver_count/model/solvers。无任何行为接线。
验收：bun run check 全绿，bun run test 全绿，commit：refactor(v9-wp1): shared solver spec types。
```

## WP2 提示词

```text
执行 docs/v9-execution-plan.md 的 WP2：schema v14 + orchestration 引用机械清除。
要点：schema.ts 删两列并升 SCHEMA_VERSION=14 → bun run db:generate → 手改 0008 迁移（先 DROP INDEX runs_orchestration_idx，再加规划中列出的 DELETE wipe，再让生成的 DROP COLUMN 落后于 DELETE）→ 按类型错误逐点机械清理 server/web 的 orchestration 引用（清单见规划 WP2.3）→ queue upsert key 改为 challengeId → 测试机械适配。
注意：迁移会 wipe 本机 data/ 下执行态（设计已批准）；目录/flags/配置表不许动。
验收：规划 WP2 的两条验收；commit：refactor(v9-wp2): schema v14 + drop orchestration refs。
```

## WP3a 提示词

```text
执行 docs/v9-execution-plan.md 的 WP3a：插件层删除 + run-factory 直建。这是全重构最核心的一步，严格按规划 §WP3a 的函数级规格实施，特别地：
- 删 7 个插件相关文件，EventScopeEmitter 移到 orchestration/event-scope.ts；
- prompt-defaults/prompt-templates 按 §3a.2 收敛为 4 键，新正文常量与 LEGACY 刷新对按规划写；
- run-factory：createSolvers / solverInitial / attachSchedulerWakeup / restore 不再建 agent 行，逐条对照 §3a.3；
- solver 工具快照 = SOLVER_TOOLS(targetSupported)，不含任何 agent 间通讯工具；
- 测试：helpers 换 solvers/strategy 参数；新增 service-multisolver.test.ts 覆盖规划 §3a.5 五项。
禁止扩大范围：tools.ts 的旧工具定义、child-agents、web 均不动（后续 WP）。
验收：规划 WP3a 两条验收；commit：refactor(v9-wp3a): remove plugin layer, direct N-solver creation。
```

## WP3b 提示词

```text
执行 docs/v9-execution-plan.md 的 WP3b：spawn child 全链删除（机械）。
删 child-agents.ts 与两个 child 测试文件，清 service/run-factory/deadlines/teardown 引用，tools.ts 删 spawn_agent/read_agent/message_agent/list_agents 定义与 RunToolContext 对应回调（lastAssistantText 保留）。agents.parentAgentId 列保留。
验收：全绿 + rg 无 spawn|childRuntime|childSessions 残留；commit：refactor(v9-wp3b): remove spawn-child machinery。
```

## WP4 提示词

```text
执行 docs/v9-execution-plan.md 的 WP4：调度者工具现代化 + add_agent + agent 级寻址。
要点（细则见规划）：queue params 透传修 bug；enqueue_run/start_run 新参数（model 不可解析时错误须列出全部可用 ref）；run-factory.addAgent 三态语义（closed 先 restore 且不唤醒旧 agent）；POST /api/runs/:runId/agents；message_agent 工具包 service.sendAgentMessage；read_run(run_id, agent_id?, last_n?)；新增 service-add-agent.test.ts 与工具参数测试。
验收：全绿 + 规划 WP4 的手动 smoke；commit：refactor(v9-wp4): scheduler tools, add_agent, agent addressing。
```

## WP5 提示词

```text
执行 docs/v9-execution-plan.md 的 WP5：web 前端。
删 orchestrations/orchestration-config api 与编排设置 tab 及路由；create-run-dialog 重做为 solver 数/模型/strategy/高级逐 solver；run 详情加「添加 solver」；提示词模板编辑收敛 4 键平铺。UI 组件只用 apps/web/src/components/ui/** 现有件，禁止改该目录。
验收：bun run check + bun run build + 手动 smoke；commit：refactor(v9-wp5): web for simplified orchestration。
```

## WP6 提示词

```text
执行 docs/v9-execution-plan.md 的 WP6：收尾清扫。
rg 扫尾删死代码/死注释；orchestration-redesign.md 标 SUPERSEDED、v9 设计稿标已实施、README 更新；全量 check/test/build。
验收：三条命令全绿；commit：refactor(v9-wp6): final sweep + docs。
```

---

## 风险与人工检查点

| WP | 风险 | 建议人工介入点 |
|---|---|---|
| WP2 | 迁移 SQL 顺序错误（索引→列）导致旧库启动失败 | 在 data/ 拷贝上手动跑一次启动 |
| WP3a | 最大的一步；restore 语义、唤醒文案、prime 渲染上下文易错 | **逐行 review diff**；重点看 restoreRunContext 与 attachSchedulerWakeup |
| WP3b | 清引用时误伤 deadlines/teardown 的正确分支 | 看 streamingAgentIds/teardownRun diff |
| WP4 | add_agent 对 closed run 的恢复路径（不唤醒旧 agent） | 看 service-add-agent 测试的 closed 用例 |
| WP5 | 弱模型写 React 易烂 | 跑 build + 手动 smoke；不满意可只保留 API 层，UI 你自己收尾 |
```

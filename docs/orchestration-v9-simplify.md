# 编排模型 v9：彻底简化（一个调度者 + 每 Run N 个平等解题者）

状态：**已实施**（WP1–WP6 全部完成；`bun run check` / `bun run test` / `bun run build` 全绿）
前置：[field-findings.md](field-findings.md)（复盘问题记录；问题 1「启动选模型」由本重构结构性解决）
取代：[orchestration-redesign.md](orchestration-redesign.md)（v8；已标 SUPERSEDED）

---

## 一、动机与断言

v8 的插件抽象（`defineOrchestration`、声明式 `agents`、`wire()` 事件接线、模板注册链、判别联合、slot 幂等/快照优先级）为「多种编排形态」设计。几场真实赛事后的结论：

1. **实际使用的形态只有两种**：event 域的调度者 + challenge 域的 1..N 个平等解题者。observer-solver / bootstrap-solver / trio 没有不可替代的能力——监督由调度者/用户做（message），多角度由 N solver 并行覆盖。
2. **spawn child 没有用**：run 内委派子任务在实践中不产生价值。需要更多人手 = 加 solver 或开新 run。子 agent 概念整体删除。
3. **插件抽象的成本全是死重**：registry、类型层、RunHandle/AgentHandle 插件面、模板三级解析、per-slot 模型设置（agentModels）、编排配置 UI、恢复时的 slot 幂等逻辑——每个概念都为一等公民，但没有任何第三方插件存在。
4. run 的行为差异（solver 集 vs 调度者）完全可以用 `scopeType` + 创建参数表达，**不需要一个可扩展点**。

**v9 断言：编排没有插件，也没有子 agent。** 只有两类 run——challenge（1..N 个平等 solver）与 event（1 个调度者）；需要扩充 = 在 run 下加 solver 或开新 run。

不变量（全部保留，v8/v12 已验证）：per-agent 锁+代次、run 状态 SQL 派生、`finishing` 原子置位、围栏与全局 fence-lock、显式队列、惰性 session + agent 行快照、per-agent 模型切换、多 session/backtrack、冷恢复。

## 二、核心模型

### 2.1 challenge run = N 个平等 solver

- N ∈ [1, `MAX_SOLVERS_PER_RUN`]（默认上限 4，代码常量）。创建时定初始 N，之后可动态扩充（§3.3）。
- 所有 solver：同一容器/工作区、同一 `mainSystem` 模板、同一工具集（§7，**无任何 agent 间通讯工具**）；**模型可各异**；**首轮提示词可各异**（§3.2）。
- slot = `solver-1..N`；`solver-1` 为 entry（run 级默认对话目标、run.model 显示、动态扩充的默认模型基线）；N=1 时与 v8 classic 行为一致。
- 全部 solver 创建即 prime（各自的 initial）。
- finish 竞态沿用原子 claiming：谁先 `finish_run` 谁 teardown，其余 no-op/aborted。
- **solver 之间不互发消息**（明确推迟：将来用更好的沟通机制——见 field-findings §3/§9 的共享方向）。N>1 时的协作 = 共享工作区文件（各自写 `SOLVER-<n>.md`、独立文件名防覆盖），无实时协调。

### 2.2 event run = 1 个调度者

- slot `orchestrator`、entry、`orchestratorSystem` 模板、scheduler 工具面（§7.2）。
- 模型 = `scheduler_config.modelId ?? agent.defaultModelId`（slotModelOverrides 机制删除）。
- prime = `schedulerInitial`（event + instruction 渲染）。
- **唤醒逻辑内建化**：v8 由 scheduler 插件 `wire()` 订阅的 6 个事件（run.started/idle/flagAccepted/finished/timedOut/resumed → `orch.send(...)`）改为服务层硬编码——scheduler run 的 context（re）build 时挂到 `EventScopeEmitter`，close 清空。paused 门控、source=manual 标注等行为不变。这是将来 digest 聚合（field-findings §4）的单一落点。

### 2.3 调度者的可见性与控制（agent 级寻址）

调度者跨 run 操作到**单个 agent** 粒度：

- 看 run 下各 agent 的详细信息和实时工作状态（`read_run` 参数化到 agent 级，§7.2）。
- 单独向某个 agent 发消息（`message_agent`；目标 agent 所在 run 在跑时 steer/跟随，闲置时开新轮，closed 时冷恢复——只唤醒该 agent）。
- 在 run 下动态加 agent（`add_agent`，§3.3）。

## 三、输入与队列

### 3.1 CreateRunInput

```ts
type CreateRunInput = {
  scopeType: "challenge" | "event"
  challengeId?: string            // challenge 域
  eventId?: string                // event 域
  /** challenge 域：run 级 strategy（进 initial 的 Strategy 段，全部 solver 共享）。 */
  strategy?: string
  /** challenge 域：每个 solver 的规格。数组长度 = solver 数（1..MAX）。
   *  缺省 = [{}]（1 个 solver，全部默认）。 */
  solvers?: SolverSpec[]
  timeoutMs?: number
  source?: "manual" | "scheduler"
  queueItemId?: string
  container: {...}                // 不变
}

type SolverSpec = {
  /** 该 solver 的模型 ref（canonical，入队/启动时校验+解析）。缺省 = 全局默认。 */
  model?: ModelRef
  /** 该 solver 的专属提示词。缺省 = 无（只吃 run 级 strategy）。 */
  prompt?: string
  /** strategy（默认）：渲染 initial，prompt 进该 solver 的 Strategy 段
   *  （与 run 级 strategy 叠加：run 级在前、solver 专属在后）；
   *  override：完全替换渲染的 initial——首轮即原文。 */
  promptMode?: "strategy" | "override"
}
```

`slotModelOverrides` / `params` / `orchestration` 字段删除。

### 3.2 首轮提示词语义（三层）

1. **run 级 `strategy`**：进所有 solver 的 initial Strategy 段（「这是堆题、libc 2.35、优先远程探测」）。
2. **solver 级 `prompt` + `strategy` 模式**（默认）：题目描述/附件/环境等标准块保留，该 solver 的 Strategy 段 = run 级 + solver 专属（「你主攻 house of apple」）。
3. **solver 级 `prompt` + `override` 模式**：完全替换 initial——调度者要完全控制输入时的逃生舱。

### 3.3 动态扩充：add_agent

- API：`POST /api/runs/:runId/agents`，body `{ model?, prompt, promptMode? }`——**prompt 必填**（扩充总是带着任务来）。
- 调度者工具：`add_agent(run_id, prompt, model?, prompt_mode?)`。
- 行为：slot = 当前最大 solver 序号 + 1（`solver-N+1`）；entry 不变；用 `SolverSpec` 同一套 prompt 语义渲染首轮；insert agent 行 → prepare → send。不占新并发槽（容器已存在或随恢复建立）。
- **时机**：
  - run `running`/`idle` → 直接加（新 agent 与在跑 agent 并行；无 fence 检查——不新建容器，同 W4 先例）。
  - run `closed` → **自动冷恢复**（fence 检查 + 重建容器/run context），**不唤醒旧 agent**（它们保持休眠，session 行还在，之后被单独 message 才醒）——与现有「恢复只碰被触发的 agent」语义完全同构，add_agent 触发的是新 agent。

### 3.4 HTTP / UI（手动侧）

- `POST /api/challenges/:id/runs` body：`strategy?`、`solver_count?`（1..4，默认 1）、`model?`（单 ref，应用于全部 solver）、`solvers?`（高级：逐 solver 的 model/prompt/promptMode）。入队时校验 ref 可解析，拒绝时回显合法模型列表。
- UI 创建弹窗：solver 数 stepper + 模型选择器（默认 `agent.defaultModelId`）+ run 级 strategy；「高级」展开逐 solver 规格。「编排」选择器删除。
- run 详情页：加 agent 入口（同 add_agent 语义）。

### 3.5 run_queue

- `orchestration` 列删除；**upsert key = `challengeId`**（challengeId 是全局唯一 PK，天然一题一项；重入队 = re-arm）。
- solver 规格存 `params` JSON：`{ strategy?, model?, solverCount?, solvers? }`；drainer `launch` 读取并透传（修掉 field-findings §0 的 params 丢弃 bug 的残余）。

## 四、数据模型（schema v14）

### 4.1 迁移策略（沿 v8 先例）

| 类别 | 表 | 处理 |
|---|---|---|
| 目录/历史（用户资产） | events / event_platforms / challenges / challenge_remote / attachments / **challenge_flags** / platform_request_log | 保留 |
| 执行态 | runs / agents / sessions / session_entries / run_queue | **wipe**（编排字段删除 + 旧插件 agent 行/spawn child 行无法映射，迁移成本 > 价值） |
| 配置态 | scheduler_config / queue_state / prompt_templates | 保留；prompt_templates 删除 plugin≠'builtin' 行 |

SCHEMA_VERSION 13→14；boot 检测 v13 库 → wipe 执行态 + DDL。

### 4.2 DDL 要点

- `runs`：删 `orchestration` 列及其索引（scopeType 已完全区分两类 run）。
- `run_queue`：删 `orchestration` 列。
- `agents` / `sessions` / `session_entries`：不变（slot 仍 `solver-N` / `orchestrator`；`parentAgentId` 列保留但恒 null——删列收益低，留着无害；spawn child 相关 check 无）。
- `prompt_templates`：仅 `plugin='builtin'`；键收敛为 4 个（见 §6）。

### 4.3 配置收敛

- 删 config.json 的 `agentModels`（orchestration-config 存储）；读取时忽略该键（老配置文件直接兼容）。
- 模型决策链：**入队/加 agent 显式选择 → `scheduler_config.modelId`（仅调度者）→ `agent.defaultModelId`**。

## 五、创建、恢复与扩充（无插件路径）

```
create(challenge):
  解析 N 个 solver 模型（ref → concrete，失败即启动失败）
  → fence + insert run 行（run.model = solver-1 的 ref）
  → 建容器（锁外）
  → buildRunContext（modelRuntime + promptContext + 容器引用；childTemplate 删除）
  → 直接 insert N 个 agent 行（slot=solver-1..N、快照：渲染后的 systemPrompt/tools/model；
    每个 solver 各自渲染 initial：override ? 原文 : 标准 block + Strategy(run级+solver级)）
  → 逐个 prepare + send(各自 initial)      // 全部 prime
  → arm timers → emit run.started

create(event):
  解析调度者模型 → fence（免检）+ insert → 容器 → buildRunContext
  → 挂内建唤醒（EventScopeEmitter 订阅，§2.2）
  → insert orchestrator 行 → prepare + send(schedulerInitial)
  → arm timers → emit run.started

restore(runId)：                       // 冷恢复，challenge/event 同构
  fence + status→running + finishing=0
  → 重建容器 + modelRuntime + promptContext
  → event 域：重挂内建唤醒（全新 emitter，同 v8 wire 重建语义）
  → arm timers（剩余 deadline）→ emit run.resumed
  // agent 行不碰（已在 DB）；session 惰性，prepareAgent 按快照 open —— v8「恢复只碰被消息的 agent」不变

add_agent(runId, spec)：               // §3.3
  running/idle → slot 递增，insert agent 行（按 spec 渲染 initial）→ prepare + send
  closed     → restore（上方路径）后同上；旧 agent 不唤醒
```

v8 的 `createRunHandle`/`buildHandleHost`/`runSetup`/`primeSpecs`/`findAgentBySlot`/`createFreshAgent`/`resolveSlotModel` 全链删除——恢复不再需要「重建声明」语义，因为**没有声明**，agent 行本身就是全部真相。`add_agent` 复用同一套 insert + prepare + send 机械。

## 六、提示词模板收敛

`prompt_templates` 只剩 builtin 命名空间，**4 个键**：

| 键 | 用途 | 相对 v8 的变化 |
|---|---|---|
| `mainSystem` | 所有 solver | 删 spawn/peer 段；加多 solver 协作段：`{{#if run.multiSolver}}` 下写「你与 N-1 个同伴共享工作区：先写 `SOLVER-<n>.md` 声明角度、读同伴笔记、独立文件名防覆盖」（纯文件协作，无消息工具） |
| `initial` | challenge prime | 不变（Strategy 段语义扩展为 run级+solver级叠加；override 时整体不用此模板） |
| `schedulerInitial` | event prime | 由 scheduler 插件的 initial 模板转正（原 plugin='scheduler' 行内容迁为 builtin） |
| `orchestratorSystem` | 调度者 | 删「Available orchestrations」目录段；enqueue/start 描述更新为 model/solver_count/solvers；新增 add_agent / message_agent / read_run(agent 级) 用法 |

- `childSystem` 键删除（spawn child 不存在）。
- 渲染退化为单 Map 查找；`loadTemplateMap`/`renderTemplate` 签名简化（删 plugin 维度）。
- **模板行是用户数据，wipe 不动**：mainSystem/orchestratorSystem 正文变更沿用 `upgradeBuiltinTemplate` 一次性刷新（旧 body 精确匹配才刷新，用户编辑保留），新增对应 LEGACY 常量，删除无引用的旧常量。
- `PromptContext` 删 `orchestrations` 变量、`capabilities` 删 `canSpawn`；`run` 增加 `multiSolver: boolean`（N>1 时渲染协作段）。
- 设置页「提示词模板」分区变为平铺 4 键。

## 七、工具面

### 7.1 solver（固定，快照照旧写 agent 行）

```
submit_flag, finish_run,
get_target / start_target / extend_target / stop_target（targetSupported 时）
```

仅此而已——**无 spawn_agent / read_agent / message_agent / list_agents**（无子 agent、无 peer 通讯）。文件工具（read/bash/edit/write）恒开不变。`createMainTools` 相应瘦身；`RunToolContext` 删 spawnChild/messageAgent/getAgent/listAgents/lastAssistantText（查询函数本体保留给 read_run 服务端用）。

### 7.2 调度者

> **SUPERSEDED（SDK 收敛）**：本节描述的 18 个原生管理工具已下马——调度者改为通过容器内 `aegisx` Python SDK + bash 管理（见 [scheduler-python-sdk.md](scheduler-python-sdk.md)）。队列/生命周期/寻址语义不变，仅工具面收敛为 read/edit/write/bash。

队列 CRUD、`start_run`/`stop_run`/`close_run`/`set_run_timeout`、`list_challenges`/`get_challenge`/`list_runs`/`get_status` 不变；变化与新增：

| 工具 | 变化 |
|---|---|
| `enqueue_run` / `start_run` | 删 `orchestration`/`params`；增 `model?`、`solver_count?`、`solvers?`（逐 solver：model/prompt/prompt_mode）、`strategy?`（原 prompt 更名）。模型不可解析时错误回显合法模型列表 |
| `add_agent(run_id, prompt, model?, prompt_mode?)` | **新增**，§3.3 语义 |
| `message_agent(agent_id, text, deliver_as?)` | **新增**：跨 run 按 agent 寻址（复用 `POST /api/agents/:agentId/message` 的服务路径：closed → 冷恢复只醒该 agent） |
| `read_run(run_id, agent_id?, last_n?)` | 参数化：默认 entry；agent 级返回状态头（status/elapsed/deadline 剩余/最近活动）+ 最近 n 条消息（assistant 正文、tool 摘要）。`after_seq`/types 过滤等富化留待 field-findings P0 批次，v9 先做 agent 选择 + last_n |
| `list_agents(run_id)` | 不变（run 下 agent 清单 + slot/model/status） |

## 八、删除清单

**server**

- `orchestration/registry.ts`、`classic.ts`、`observer-solver.ts`、`bootstrap-solver.ts`、`trio.ts`、`common.ts`、`scheduler.ts`（插件文件全删）
- `orchestration/run-handle.ts`：RunHandle/AgentHandle/RunEmitter/`createRunHandle` 删除；`EventScopeEmitter` 保留（移至精简后的 `orchestration/event-scope.ts`）
- `orchestration/types.ts`：仅存 `PromptContext`、`Capabilities/deriveCapabilities`、`EventScopeEvent/Payload`（瘦身重写）
- **`run/child-agents.ts` 整文件删除**；`childSessions`/`childRuntime`/`MAX_CHILDREN_PER_RUN`/`deliverToParent` 在 service/run-factory/deadlines/teardown 的全部引用清除（deadlines 的 streamingAgentIds 只剩 lifecycle 一路；teardown 的 child 分支删除；recoverOnBoot 的悬挂 child settle 逻辑删除）
- `run/run-factory.ts`：§五 所列插件机械删除 + child 引用清除；create 直接建 agent 行；新增 add_agent 路径
- `run/model-resolver.ts`：删 `resolveSlotModel`（agentModels 入口消失）
- `run/service.ts`：删 `bootOrchestration`、agentModels 迁移；模板刷新按 §六 更新
- `run/routes.ts`：删 `/api/orchestrations`、`/api/orchestration-config`（GET/PATCH）；runInput 增 solver 规格；新增 `POST /api/runs/:runId/agents`
- `run/scheduler-admin.ts`：slotModelOverrides → 直接解析 `scheduler_config.modelId ?? default`
- `run/scheduler-tools.ts`：RunSummary 删 orchestration 字段；工具参数按 §7.2
- `run/tools.ts`：删 spawn_agent/read_agent/message_agent/list_agents 工具定义
- `infrastructure/config-store.ts`：删 getAgentModels/updateAgentModels

**shared**

- `RunPublic.orchestration` 字段删除（连带 `run/public.ts` 映射）；可加 `solverCount` 轻量派生字段供列表展示

**web**

- `api/orchestrations.ts`、`api/orchestration-config.ts` 删除
- `settings/orchestration-settings.tsx` 删除；settings-screen 编排 tab、`/settings/orchestration` 路由移除
- `create-run-dialog.tsx`：编排选择器 → solver 数 + 模型 + strategy + 高级逐 solver
- run 详情页：加 agent 入口
- timeline/agents-graph/queue-list 中 orchestration 标签清理
- 提示词模板编辑页收敛为平铺 4 键

**测试**：插件/registry/orchestration-config/child-agents/spawn 相关测试删除；lifecycle/fence/queue/deadlines/teardown/session-ops 核心测试保留并适配。

## 九、明确不做 / 推迟

| 项 | 理由 |
|---|---|
| run 内 solver 互发消息 | 推迟——将来用更好的沟通机制（方向见 field-findings §3/§9：共享 FS / 署名 note / 中央调度） |
| spawn child / 子 agent | 永久删除——实践中无用；扩充 = add_agent 或新 run |
| 编排插件 / 第三方编排 | 永久删除——两类 run + 参数已覆盖全部需求 |
| read_run 完整过滤 | v9 只做 agent 选择 + last_n；after_seq/types/max_chars 留 field-findings P0 |
| digest 聚合 / board / wind-down 等 | 全部留 field-findings 的 P0–P2 批次，在 v9 之上实施 |

## 十、不变清单（显式记录，防「重构悄悄改行为」）

per-agent 锁+代次；run 状态 SQL 派生 + sanctioned closed；finishing 原子置位；全局 fence-lock 三处强制（create / 冷恢复 / 排空）；队列 FIFO + 启动失败→failed+通知；两阶段超时（abort→grace→SIGKILL，outcome 事件）；冷恢复围栏+快照+单飞；per-agent 模型切换/多 session/backtrack/compact；paused 门控；queue_state per-event 暂停；recoverOnBoot 语义；scheduler start/reset 语义（closed→冷恢复保记忆，reset→全新）；「恢复只碰被触发的 agent」（add_agent 扩展同语义：恢复 run 不唤醒旧 agent）。

## 十一、实施阶段

| Phase | 内容 | 测试目标 |
|---|---|---|
| **P1 schema + 创建核心** | v14 迁移（wipe + DDL + 模板收敛至 4 键）；run-factory 去插件化（直接建 N solver 行 + per-solver initial + prime）；restore 简化；child-agents 全链删除；model-resolver/routes 输入变化 | N=1 与 v8 classic 全 parity（创建/prime/finish/超时/冷恢复/模型切换）；N=3 并行 + finish 竞态；per-solver 提示词两模式渲染；入队模型校验拒绝路径 |
| **P2 调度者内建化 + agent 级寻址** | 内建唤醒模块；scheduler-admin 模型直解；调度者工具更新（strategy/solvers/add_agent/message_agent/read_run agent 级）；orchestratorSystem/schedulerInitial 模板刷新；队列 upsert key=challengeId | 6 事件唤醒 parity；paused 静默；调度者冷恢复重挂；add_agent 三态（running/idle/closed 不唤醒旧 agent）；message_agent 跨 run 冷恢复 |
| **P3 前端 + 清理** | create-run 弹窗；run 详情加 agent；设置页收敛；orchestration 标签清理；shared 字段删除；删插件/child 测试；文档转正（本文件 + orchestration-redesign 标记 superseded） | `bun run check` + 全量测试；web build |

## 十二、已定决策记录

1. 编排插件整体删除（用户，2025-08）。
2. spawn child 永久删除（用户：「实际上没有用」）。
3. run 内 solver 通讯推迟（用户：「以后会有更好的沟通方式，但现在先不做」）。
4. per-solver 提示词双模式 strategy/override（用户：调度者可为每个 solver 指派提示词，可选覆盖 initial 或进 strategy 段）。
5. add_agent 时机：running/idle 直接加；closed 自动恢复容器、不唤醒旧 agent（用户拍板）。
6. `mainSystem` 键名保留（减少模板行迁移）。
7. `MAX_SOLVERS_PER_RUN = 4`（代码常量；不够用时再调）。
8. wipe 执行态（沿 v8 先例；目录/flags/配置保留）。

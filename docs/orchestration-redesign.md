# 编排插件架构（v8 重构）规格

状态：**设计定稿 v2（经子代理审查修订），待实施**
取代：[architecture.md](./architecture.md)（当前 v7）、[orchestrator.md](./orchestrator.md)、[lifecycle-redesign.md](./lifecycle-redesign.md)
Schema：v7（当前）→ **v8**（本设计；单用户本地，升版拒旧库，全量重写，不写数据迁移）

> 本设计 crystallize 自「统一 Run + 编排插件」系列讨论 + 一轮子代理批判性审查。
> 核心论断：**orchestrator 与 solver run 是同一种东西**——一个挂在 scope（challenge 或
> event）上、由某个编排插件定义内部 agent 格局的 Run。orchestrator 就是 `scope:'event'` +
> scheduler 编排的 Run。

---

## 一、目标与动机

1. **同构**：orchestrator 与 solver run 走同一条 agent 构建路径，差异只在模型/提示词/工具/编排插件。
2. **可插拔编排**：一个 Run 内部的 agent 组织方式（单 solver、监督式、串行探测、多模型对等…）由**编排插件**定义，一个编排一个 TS 文件。
3. **调度者退化**：调度者不再直接 start/stop run，而是维护一张**任务列表**，系统按序排空拉起；调度者仅在必要时接管。
4. **按 agent 寻址**：消息发往 agent（按持久 id），不是发往 run；恢复时只恢复被消息的那一个 agent。
5. **简化数据模型**：合并 runs + orchestrators；sessions 挂 agentId（保留冗余 runId 保性能）。

---

## 二、核心抽象

只有三个一等概念。

### Run —— 唯一的部署单元

一个 Run = 一个 scope（challenge 或 event）+ 一个编排插件 + 一个共享容器/工作区 + N 个 agent + 三态生命周期。

- `scope:'challenge'`：解题 run（classic / observer-solver / bootstrap-solver / trio…）。
- `scope:'event'`：调度者 run（scheduler 编排）。它通过 scheduling 工具操控同 event 下的其它 run。

**一 Run 一容器**，Run 内所有 agent 共享，默认 cwd = 设置的 `container.workspace`（`/workspace`）。

### Agent —— 对 pi agent 的统一包装

一个 agent = 一个 pi session + 角色 + 模型 + 提示词 + 工具。agent 之间只在这四点上不同。

- `role`：自由字段，`'orchestrator'` 保留给调度者，其余由插件定义。
- `id`：持久、跨恢复稳定；**一切跨 agent 的寻址用 id**。
- `slot`：Run 内唯一的 createAgent 幂等键（插件内部用）。
- 模型快照在 agent 上（trio 三模型就靠这个）。

### Orchestration Plugin —— 编排配方（一个 TS 文件）

声明式输入 + 命令式行为：用 `create()` / `resume()` 建 agent、挂事件触发器。调度者也作为插件提供。

---

## 三、插件 API（完整签名）

### 3.1 注册

```ts
function defineOrchestration<P>(plugin: OrchestrationPlugin<P>): OrchestrationPlugin<P>

interface OrchestrationPlugin<P = any> {
  id: string                                 // 唯一，如 'classic' / 'observer-solver' / 'scheduler'
  scope: 'challenge' | 'event'
  /** 输入声明（typebox）。创建 Run 的 UI 按它渲染；调度者 enqueue 时传值。 */
  params: TSchema
  /** 默认提示词模板（key → 默认文案），注册时写进 prompt_templates 表（见 §3.6），可编辑。 */
  templates?: Record<string, string>
  /** 首次创建 run 时调用一次：声明+持久化 agent、接线、踢首轮。 */
  create(run: RunHandle<P>, event?: EventHandle): void | Promise<void>
  /** 每次（重新）激活 run 时调用：仅重建接线（on 回调），不 drive。
   *  create 内部通常复用同一个 wire 函数，避免重复。 */
  resume(run: RunHandle<P>, event?: EventHandle): void | Promise<void>
  /** spawn_agent 派生 agent 的模板。省略 = 默认（仅 file 工具、单次、结果自动 deliver 给 parent）。 */
  spawn?: { systemPrompt: string; tools: string[]; model: 'default' | ModelRef }
}
```

> **create 的强约束**（见 §4.2/I2）：create 只允许「声明 createAgent + 接线 wire + 踢首轮」
> 三段，**禁止在 create 里放 resume 需要的可变状态**（如根据 params 初始化的内存结构）。
> 原因：恢复时只跑 resume，create 里的可变状态不会重建。需要跨恢复的状态请落 DB。

### 3.2 RunHandle

```ts
interface RunHandle<P = any> {
  id: string
  scope: 'challenge' | 'event'
  ctx: RunContext                            // challenge/event 数据、workspace、capabilities、附件…
  params: P                                  // 已校验输入
  initialPrompt: string                      // 渲染好的首轮提示词
  render(templateKey: string): string        // 渲染提示词模板（见 §3.6）

  /** 声明一个 agent。首次：持久化 agent 行（分配 id、写 slot/spec/model）。
   *  不建 session——session 在 prepare() 时惰性物化。返回句柄。 */
  createAgent(spec: AgentSpec): AgentHandle
  agent(slot: string): AgentHandle           // 按 slot 取（接线时用）
  readonly agents: AgentHandle[]             // 全部

  /** Run 级事件（任意 agent 触发）。agent 级用 AgentHandle.on。 */
  on(event: AgentEvent, cb: (e: AgentEventPayload) => void): () => void
}

interface AgentSpec {
  slot: string                               // Run 内唯一
  name: string
  role?: string                              // 默认 = slot；'orchestrator' 保留
  systemPrompt: string                       // 完整渲染好的字符串（用 run.render 构建）
  tools: string[]                            // 真实工具名（见 §六）；file 工具始终开启，不必列
  model: 'default' | ModelRef                // 'default' = 用 run 默认模型
}

type ModelRef = { provider: string; modelId: string; thinking: ThinkingLevel }
```

### 3.3 AgentHandle

```ts
interface AgentHandle {
  readonly id: string                        // 持久、跨恢复稳定；寻址用它
  readonly slot: string
  readonly role: string
  readonly isStreaming: boolean

  /** 准备环境：确保容器在线 + 这个 agent 的 session 在线（首次=create，恢复=open）。幂等，不发消息。 */
  prepare(): Promise<void>
  /** 发消息：开/续一轮（streaming→steer，否则新轮）。假定已 prepare（未 prepare 则自动补）。 */
  send(text: string): Promise<void>
  /** 便利 = prepare + send。触发器里常用。 */
  drive(text: string): Promise<void>
  steer(text: string): Promise<void>         // 注入当前轮
  abort(): Promise<void>                     // 中止当前轮（agent → idle；run 状态由聚合推导，见 §4.5）

  /** Agent 级事件。 */
  on(event: AgentEvent, cb: (e: AgentEventPayload) => void): () => void
  lastText(): string | null                  // 最近一条 assistant 文本（review 用）
}
```

### 3.4 EventHandle（仅 scope:'event' 的插件用）

```ts
interface EventHandle {
  /** 订阅本 event 下子 run 的生命周期事件（调度者用）。 */
  on(event: EventScopeEvent, cb: (e: { runId: string; agentId?: string }) => void): () => void
}
```
`scope:'event'` 的插件 `create(run, event)` / `resume(run, event)` 第二参拿到 `EventHandle`；`scope:'challenge'` 的插件忽略它（event 为 undefined）。

### 3.5 事件目录

```ts
// Agent 级（AgentHandle.on / RunHandle.on 兜全局）
type AgentEvent =
  | 'turnEnded'        // 该 agent 一轮结束（一轮 = pi prompt 到 idle 的完整循环，含多次工具调用）
  | 'flagAccepted'     // 该 agent 提交的 flag 被接受
  | 'timedOut'         // 该 agent 撞超时
  | 'spawned'          // 该 agent spawn 了一个子 agent
  | 'finishing'        // 该 agent 调了 finish_run，run 即将终止

// Event 级（EventHandle.on，子 run 生命周期）
type EventScopeEvent =
  | 'run.started'
  | 'run.idle'         // 子 run 转入 idle（该 run 所有 agent 都 settle）
  | 'run.flagAccepted'
  | 'run.timedOut'
  | 'run.finished'
```

> **「一轮」的定义**（澄清 I8）：pi 的一个 turn = `prompt()`/`send()` 驱动到 agent 自然 idle 的
> 完整循环，**内部可含多次 LLM 调用 + 多次工具调用**。所以 bootstrap 在一个 turn 内就能完成
> 全部探测；`turnEnded` = 探测完成。不存在「一轮只跑一个工具」的误解。

### 3.6 提示词模板注册与编辑（B2）

`apps/shared/settings-schema.ts` 的 `FlatSettings` 是封闭枚举，**插件无法往里塞 `prompts.observerSystem` 这类 key**。因此模板独立存储：

- 新表 **`prompt_templates`**（见 §九）：`(plugin, key)` 唯一，存 `body` + `updatedAt`。
- 插件 `templates?: Record<string,string>` 在注册时 upsert 默认文案进表（仅当该 key 无用户编辑时）。
- `run.render(key)` 查询顺序：`prompt_templates` 表（用户编辑）→ 插件 `templates` 默认 → 找不到则抛错。
- 设置页新增「提示词模板」分区，按 plugin 分组列出可编辑模板（不进 FlatSettings / SETTINGS_DEFS）。
- 内置模板（mainSystem / childSystem / initial / orchestratorSystem）也迁入此表，统一机制。

---

## 四、生命周期

### 4.1 Run 三态

| 状态 | 含义 | 容器 | session |
|---|---|---|---|
| `running` | ≥1 个 agent 正在 streaming | 在线 | 至少一个在线 |
| `idle` | 所有 agent 都 settle，无一 streaming | 在线（保留） | 在线（保留） |
| `closed` | 容器 + 所有 live session 释放 | 释放 | DB 保留，可冷恢复 |

Run 状态由其 agent **聚合推导**（算法见 §4.5），不是单独字段维护。

### 4.2 create / resume 调用时机（关键）

```
创建:  建 run 行 + 容器 → 调 create(run[,event])   〔建 agent 行、接线、踢首轮〕
温热:  不调（实例在内存，触发器直接生效）
关闭:  释放容器 + 所有 live session；dispose 全部 handle；清空 run 实例的 EventEmitter；agent 行 + 历史 session 留 DB
恢复:  被消息某 agent → 调 resume(run[,event])     〔仅重建接线，全新 emitter〕
       → 系统 prepare(该 agent) + send(用户消息)    〔只它一个 session 从 DB open〕
```

- **create 跑一次**；**resume 在每次「closed → 重开」时跑**；温热状态下两者都不跑。
- **create 内部复用 resume 的接线代码**（通常抽一个模块级 `wire(run)`，两者都调），零重复。
- **close 必须清空 EventEmitter 订阅**（否则 resume 再 `on()` 会重复回调——observer 被驱动两次）；resume 重建一个全新 emitter。
- 插件作者**完全不用想恢复**：把 create 限定为「声明+wire+踢首轮」三段，恢复自然正确。

### 4.3 惰性 session 物化

`createAgent` **不建 session**，只持久化 agent 行。session 在 `prepare()`/`drive()`/`send()` 首次触及时物化：

- 首次（无 session 行）→ `DbSessionManager.create`
- 恢复（有 session 行）→ `DbSessionManager.open`

因此**恢复只碰被消息的那个 agent**；其它 agent 哪怕被声明了也保持休眠，直到某个触发器 `drive()` 它才按需 open。

> 边界：若某 agent 在关闭前从未被 drive（如 observer 还没触发 run 就被关了），其 session 行不存在；恢复后触发器 drive 它时，`prepare()` 发现无 session → 当作首次 create。自然兜住。

### 4.4 两条系统内置规则（插件不必声明）

1. **spawn 的子 agent `turnEnded` → 自动把结果 deliver 给 parent agent**（`drive(parent, 结果文本)`）。
2. **任一 agent 调 `finish_run` → 终止整个 Run**（B4 修订）：
   - 设 **run 级「finishing」一次性标志**（任何 agent 的 `onBeforeNewTurn` 都不清除它）。
   - 发起 agent 的 turn settle 后（或若已 settle 则立即）终止 run：对其余 streaming agent 各自 `abort()`（**in-flight docker exec 不保证取消，best-effort**），全部 dispose。
   - 发起 agent 标 `completed`；其余 agent 标 `aborted`；释放容器 → `closed` + summary。

### 4.5 多 agent 并发模型（B1 —— 地基，必须单列设计）

现有 `createSessionLifecycle` 是「per-id 单 session + 单锁 + 单代次」，一个 run 只有一条 main session（child 走独立 map）。trio/observer 要求**一个 run 内 N 个对等、可独立 drive** 的 session。lifecycle 必须改成两级：

**(a) 两级锁**

| 锁 | 粒度 | 守护 |
|---|---|---|
| **agent turn lock** | per-agentId | drive/send/steer/abort 对同一 agent 串行；prompt 长跑在锁**外**，仅 turn 开始/结束的瞬间持锁 |
| **run state lock** | per-runId | run 状态聚合、容器建/关、finish 标志 |

**锁顺序**：agent turn 操作先取 agent 锁（含长跑 prompt）；状态聚合在 turn 开始/结束的临界区里**短暂**取 run 锁。两者**不交叉长跑**（run 锁内不做 prompt、不调 docker exec），避免死锁。

**(b) 代次守卫改 per-agentId**

`turnGeneration` 从 `Map<runId, number>` 改为 `Map<agentId, number>`：同一 agent 的新轮覆盖旧轮，旧轮 settle 为 no-op。不同 agent 的轮互不干扰（trio 三 agent 可并行跑）。

**(c) Run 状态聚合**（run state lock 内，瞬时完成）

```
onAgentTurnStart(agentId):  若 run.status !== 'closed' → run.status = 'running'
onAgentTurnSettled(agentId): 若该 run 已无 streaming agent 且无 finishing 标志 → run.status = 'idle'
onFinish / onClose / onTimeout: → run.status = 'closed'（释放容器）
```

**(d) 容器与 abort**

- 容器 per-run（共享）。abort(agent) 只停该 agent 的模型 loop；in-flight docker exec best-effort（跑完或被容器级 SIGKILL 收）。
- 多 agent run 的「关 run」= 释放共享容器（所有 agent 的 live session 一并 dispose）。

---

## 五、系统侧机制（插件不操心）

| 机制 | 说明 |
|---|---|
| 容器 | 每 run 一个 `sleep infinity` Kali 工具箱；bash 经 `docker exec` 转发；文件工具操作 host workspace（bind 进容器） |
| Session | DB 为单一真相源；`DbSessionManager` 写 `session_entries`；惰性 create/open |
| 并发运行时 | 两级锁 + per-agentId 代次 + run 状态聚合（§4.5） |
| EventEmitter / 触发路由 | agent 级 + run 级 + event 级；插件 `on()` 注册回调；close 清空、resume 重建全新 emitter |
| 任务队列 + 排空 | `run_queue` 表；排空器单飞（drain-lock + 去抖）；FIFO；用户/调度者都可入队 |
| 围栏 | 全局 `maxConcurrentRuns`（**只数 challenge-scope running run**，scheduler 不计）；per-event `maxConcurrentTargets`。排空时与直接 start 时都强制 |
| 超时 | 每 run 一个硬定时器；到期 → abort 所有 streaming agent → 等全 settle → run idle → 记 `lastTimeoutAt` → 通知调度者。无中点提醒。可延长 |
| 结构事件日志 | Timeline 数据源（v1 从 runs/agents/challenge_flags 派生 + run.meta 的 `lastTimeoutAt`；语义事件落地后再加 `activity` 表） |
| 工具接线 | 系统把工具名映射到按 run/agent 上下文接好线的实例。**file 工具集 v8 扩展为 read/bash/edit/write/grep/find/ls 全部始终开启**（当前仅 4 个，需确认 grep/find/ls 的 SDK builtin 启用方式，见 §六） |
| create 原子性 | 多 agent 建立失败全回滚：abort 已 kick 的 agent + dispose + 释放容器 + 标 closed |

---

## 六、工具目录（真实名，无别名）

**file 工具集（v8）= `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`，对所有 agent 始终开启，不必在 `tools` 里列。**

> 现状（v7）：`HOST_FILE_TOOLS = ["read","bash","edit","write"]` 仅 4 个，`createWorkspaceTools`
> 也只产 read/write/edit。v8 显式扩展到 7 个；`grep`/`find`/`ls` 是 SDK builtin，需在 P1 确认
> 其 enable 方式并补进 `HOST_FILE_TOOLS`。

| 工具 | 作用 | 典型授予 | v1 范围 |
|---|---|---|---|
| `submit_flag` | 记录/校验 flag（platformService） | solver 类 | — |
| `get_target` / `start_target` / `extend_target` / `stop_target` | 靶机生命周期 | solver 类（有靶机时） | — |
| `finish_run` | 终止整个 Run（写 summary） | 允许终止 run 的角色 | — |
| `spawn_agent` / `inspect_agent` | 派生/查看子 agent | 可委派的角色 | — |
| `message_agent` / `read_agent` / `list_agents` | **按 id** 跨 agent 通信 | observer / peer / scheduler | **v1 限定 run 内**（跨 run 会触发另一个 run 的冷恢复，副作用过大，推迟） |
| `enqueue_run` | 往任务列表加一项（challengeId, orchestration, params, timeoutMs, prompt） | scheduler | — |
| `start_run` / `stop_run` | 直接建/中止 run（逃生舱，prompt 引导优先 enqueue） | scheduler | — |
| `message_run` / `close_run` / `read_run` | 接管某 run（message_run 默认指 run 的 entry agent；可用 message_agent 指定具体 agent） | scheduler | — |
| `set_run_timeout` | 给某 run 设/延超时 | scheduler | — |
| `list_challenges` / `get_challenge` / `list_runs` / `get_status` | 只读盘点 | scheduler | — |

---

## 七、内置编排（完整代码）

### 7.1 classic —— 单 solver（= 今天）

```ts
function wire(run: RunHandle) {
  // 子 agent 完成自动 deliver（系统规则），无需在此声明
}
export default defineOrchestration({
  id: 'classic', scope: 'challenge',
  params: Type.Object({}),
  create(run) {
    run.createAgent({ slot: 'solver', name: 'Solver',
      systemPrompt: run.render('mainSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
              'finish_run', 'spawn_agent', 'inspect_agent'], model: 'default' })
    wire(run)
    const solver = run.agent('solver')
    solver.prepare()
    solver.send(run.initialPrompt)
  },
  resume(run) { wire(run) },
  spawn: { systemPrompt: 'childSystem', tools: [], model: 'default' },
})
```

### 7.2 observer-solver —— 监督式

```ts
function wire(run: RunHandle) {
  const solver = run.agent('solver')
  solver.on('turnEnded', () =>
    run.agent('observer').drive('Solver 结束一轮。用 read_agent 看进展，需要纠偏就 message_agent steer。'))
  solver.on('flagAccepted', () =>
    run.agent('observer').drive('Solver 提交了 flag，复核一下。'))
}
export default defineOrchestration({
  id: 'observer-solver', scope: 'challenge',
  params: Type.Object({ observerModel: ModelRefSchema }),
  templates: { observerSystem: DEFAULT_OBSERVER_SYSTEM },
  create(run) {
    run.createAgent({ slot: 'solver', name: 'Solver',
      systemPrompt: run.render('mainSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
              'finish_run', 'spawn_agent', 'inspect_agent'], model: 'default' })
    run.createAgent({ slot: 'observer', name: 'Observer',
      systemPrompt: run.render('observerSystem'),
      tools: ['message_agent', 'read_agent', 'list_agents'], model: run.params.observerModel })
    wire(run)
    const solver = run.agent('solver')
    solver.prepare()
    solver.send(run.initialPrompt)
  },
  resume(run) { wire(run) },
})
```

### 7.3 bootstrap-solver —— 串行（先探测后解题）

```ts
function wire(run: RunHandle) {
  // bootstrap 一个 turn = 完整探测循环（含多次工具调用），turnEnded 即探测完成
  run.agent('bootstrap').on('turnEnded', () =>
    run.agent('solver').drive('Bootstrap 探测完成，结果在 /workspace。开始解题。'))
}
export default defineOrchestration({
  id: 'bootstrap-solver', scope: 'challenge',
  params: Type.Object({}),
  templates: { bootstrapSystem: DEFAULT_BOOTSTRAP_SYSTEM },
  create(run) {
    run.createAgent({ slot: 'bootstrap', name: 'Bootstrap',
      systemPrompt: run.render('bootstrapSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target'], // 无 finish_run：探测完交棒
      model: 'default' })
    run.createAgent({ slot: 'solver', name: 'Solver',
      systemPrompt: run.render('mainSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
              'finish_run', 'spawn_agent', 'inspect_agent'], model: 'default' })
    wire(run)
    const boot = run.agent('bootstrap')        // 先跑 bootstrap
    boot.prepare()
    boot.send(run.initialPrompt)
  },
  resume(run) { wire(run) },
})
```

> bootstrap 在一个 turn 内持续探测直到自然 idle（不再调工具）→ `turnEnded` 触发 solver。
> 若担心 bootstrap 提前 idle，可在 prompt 里要求它探测完毕后显式确认；无需额外机制。

### 7.4 trio —— 3 个对等 solver（不同模型，共享容器+工作区）

```ts
export default defineOrchestration({
  id: 'trio', scope: 'challenge',
  params: Type.Object({ models: Type.Array(ModelRefSchema, { minItems: 3, maxItems: 3 }) }),
  templates: { trioSystem: DEFAULT_TRIO_SYSTEM },
  create(run) {
    const slots = ['solver-a', 'solver-b', 'solver-c'] as const
    slots.forEach((slot, i) =>
      run.createAgent({ slot, role: 'solver', name: `Solver ${i + 1}`,
        systemPrompt: run.render('trioSystem'),
        tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
                'finish_run', 'message_agent', 'read_agent', 'list_agents'],
        model: run.params.models[i] }))
    // 无触发器：靠 message_agent + 共享工作区文件自协调；谁先 finish_run 谁终止 Run
    for (const s of run.agents) { s.prepare(); s.send(run.initialPrompt) }
  },
  resume() { /* 无接线 */ },
})
```

> trio 的 finish 竞态：三个 agent 并行，谁先 `finish_run` 谁设 finishing 标志（§4.4 规则 2），
> 其余两个被 abort + 标 aborted。

### 7.5 scheduler —— 调度者（event scope）

```ts
function wire(run: RunHandle, event: EventHandle) {
  const orch = run.agent('orchestrator')
  event.on('run.idle',         ({ runId }) => orch.drive(`Run ${runId} 转入 idle。`))
  event.on('run.flagAccepted', ({ runId }) => orch.drive(`Run ${runId} 解出 flag。`))
  event.on('run.timedOut',     ({ runId }) => orch.drive(`Run ${runId} 超时，决定延长/关闭/重排。`))
}
export default defineOrchestration({
  id: 'scheduler', scope: 'event',
  params: Type.Object({ model: ModelRefSchema }),
  create(run, event) {
    run.createAgent({ slot: 'orchestrator', role: 'orchestrator', name: 'Scheduler',
      systemPrompt: run.render('orchestratorSystem'),
      tools: ['enqueue_run', 'start_run', 'stop_run', 'message_run', 'close_run',
              'read_run', 'get_status', 'list_challenges', 'get_challenge', 'list_runs',
              'message_agent', 'read_agent', 'list_agents', 'set_run_timeout'],
      model: run.params.model })
    wire(run, event)
    const orch = run.agent('orchestrator')
    orch.prepare()
    orch.send(run.initialPrompt)
  },
  resume(run, event) { wire(run, event) },
})
```

---

## 八、调度者模型

### 8.1 任务列表（run_queue）

- **持久化**（DB 表），跨重启保留。
- 调度者每次被唤醒**整表重写 `source='scheduler' AND status='pending'` 的行**（手动入队的 `source='manual'` 行**绝不触碰**）。重写用「重算 `ord` + 按 (challengeId,orchestration) 匹配既有行」而非 delete+insert，保留行 id 与已回填的 runId。
- 排空器按 `ord` **FIFO**，在围栏内拉起：容量足则立即创建 run，不足则留队等待。
- **用户可手动入队 / 改序 / 删除**（题目页点题 → 选编排 → 入队）。
- 优先级以后再做（现在纯有序 FIFO）。

### 8.2 排空与围栏（B3/B5）

**排空单飞**：多个触发（队列变化 / run 释放容量 / 启动）合并为一次排空 pass，去抖（≈200ms）。排空 pass 与所有 queue 写操作（enqueue / scheduler 重写 / 改序 / 删除）共用同一把 **per-event queue-lock**：读队首 → 围栏检查 → 建 run → 回填 queue 项，整段在锁内，**无并发排空**。

**围栏**：

1. **全局 challenge-scope running run 数 ≤ `scheduler.maxConcurrentRuns`**（默认 4）。**只数 `scopeType='challenge' AND status='running'`——scheduler run 不计入**（否则 scheduler + N solver 自我卡死）。
2. **不同的** target 题（target-capable 且未解）同时被攻 ≤ per-event `maxConcurrentTargets`（默认 1）。同题多 run 共享一个 target 槽。

违反时该项**留队等待**（不报错）。

**scheduler run 的拉起**（断递归）：scheduler run 由用户 `POST /scheduler/start` 显式创建，**不进 run_queue、不被 drainer 拉起**（drainer 只处理 challenge-scope 的 pending 项）。这切断「drainer → scheduler → enqueue → drain」递归。

### 8.3 超时（I3）

- 每 run 一个硬定时器（`timeoutMs`，默认 `scheduler.defaultRunTimeoutMs`）。
- 到期 → **遍历该 run 所有 streaming agent 各自 `abort()`** → 等全部 settle → run idle（保留容器，可续）→ 在 run.meta 记 `lastTimeoutAt` → 触发 `run.timedOut` 通知调度者。
- **无中点提醒**。
- 调度者 `set_run_timeout(runId, timeoutMs)` 可延长/缩短（重置 deadline + 重设定时器），允许运行中操作。

---

## 九、数据模型（schema v8，全量重写）

### runs（合并 orchestrators）

```
runs
  id PK
  scopeType        'challenge' | 'event'        notNull
  eventId          text FK events cascade        notNull   -- 恒有
  challengeId      text FK challenges cascade    nullable  -- challenge-scoped 时填
  orchestration    text                          notNull   -- 插件 id
  status           'running'|'idle'|'closed'     notNull
  -- 容器 + 工作区（通用）
  containerName, image, cpus, memoryMb, pidsLimit, workspacePath, sessionDir
  -- 默认模型（通用；agent 可覆盖）
  provider, providerLabel, modelId, modelLabel, thinkingLevel
  -- challenge 域（nullable；challenge-scoped 才填）
  source           'manual' | 'scheduler'        notNull default 'manual'
  timeoutMs        integer                       nullable
  deadlineAt       text                          nullable
  summary          text                          nullable
  error            text                          nullable
  -- 插件专属配置（json）：params 快照、lastTimeoutAt 等
  meta             text                          notNull default '{}'
  createdAt, startedAt, updatedAt, completedAt
  -- 约束/索引
  unique index (eventId) where scopeType='event'      -- 每 event 至多一个 scheduler run
  index (scopeType, eventId)
  index (challengeId)
  index (orchestration)
```

> 删除冗余 `scopeId`（S1）：scope 由 `scopeType + (challengeId|eventId)` 表达，eventId 恒在。

### scheduler_config（event 级调度者策略 + 配置收口，1:1 event；I6）

```
scheduler_config
  eventId              PK FK events cascade
  modelId              text nullable          -- ProviderModel.id；null=全局默认。scheduler run 的模型由此解析
  instruction          text notNull default ''
  maxConcurrentTargets integer notNull default 1
  activeRunId          text FK runs cascade nullable   -- 当前 scheduler run（无则未启用）
  createdAt, updatedAt
```

> scheduler 的所有可编辑旋钮（模型 / instruction / target cap）**都收口在此表**；run 行只持有
> 运行期实例（容器/session/status）+ 模型快照（冷恢复用）。「run 存在即启用」= `activeRunId` 非空。

### agents（泛化：自由 role + 自带模型 + aborted 终态；B4）

```
agents
  id PK
  runId            text FK runs cascade           notNull
  slot             text                           notNull
  role             text                           notNull   -- 自由；'orchestrator' 保留
  parentAgentId    text nullable                             -- spawn 委派
  -- 模型快照（下沉到 agent；trio 必需）
  provider, providerLabel, modelId, modelLabel, thinkingLevel
  status           'running'|'idle'|'completed'|'aborted'|'failed'   -- +aborted（被 finish_run/timeout 中止）
  sessionFile      text nullable                             -- sessions.id（DB）或 legacy jsonl 路径
  name, task       text nullable
  createdAt, startedAt, updatedAt, completedAt, error
  unique(runId, slot)
  index(runId)
```

### run_queue（新；B3/I5）

```
run_queue
  id PK
  eventId          text FK events cascade         notNull
  ord              integer                        notNull   -- FIFO 顺序
  challengeId      text FK challenges cascade     notNull
  orchestration    text                           notNull
  params           text                           notNull   -- json
  timeoutMs        integer                        nullable
  prompt           text                           notNull
  source           'manual' | 'scheduler'         notNull
  status           'pending' | 'running' | 'done' | 'cancelled'
  runId            text FK runs cascade           nullable  -- 拉起后回填
  createdAt
  index(eventId, ord)
  index(status)
  index(runId)
```

> **status 生命周期**（I5）：pending →（排空拉起）→ running（回填 runId）→（run closed/finished）
> → done；手动 DELETE 一个已 realized（running/done）的项 = 拒绝；cancel 只允许 pending 项。

### sessions / session_entries（挂 agentId + 保留冗余 runId；I1）

```
sessions
  id PK
  agentId          text FK agents cascade         notNull
  cwd              text                           notNull
  createdAt
  index(agentId)

session_entries
  id PK
  sessionId        text FK sessions cascade       notNull
  agentId          text FK agents cascade         notNull   -- 便于按 agent 查
  runId            text FK runs cascade           nullable  -- 冗余，同步写入；保 run 级查询性能（usage/read_run/listMessages）
  parentId         text nullable
  seq              integer                        notNull
  type             text                           notNull
  data             text                           notNull   -- 完整 SessionEntry JSON
  createdAt
  unique(sessionId, seq)
  index(agentId, seq)
  index(runId, seq)
```

> 删除 ownerType/ownerId 维度（单一归属：agent）。**保留冗余 `runId`**（I1）：现有
> `usageTotals`/`listMessages`/orchestrator `read_run` 全靠 `eq(sessionEntries.runId, runId)`
> 单表查询；删了会变 join + 性能回归。runId 由 DbSessionManager 在 commit 时同步写入。

### prompt_templates（新；B2）

```
prompt_templates
  plugin           text                           notNull   -- 插件 id（'builtin' for 内置）
  key              text                           notNull   -- 'mainSystem' / 'observerSystem' ...
  body             text                           notNull
  updatedAt        text                           notNull
  unique(plugin, key)
```

> 内置模板（mainSystem/childSystem/initial/orchestratorSystem）也迁入此表（plugin='builtin'）。
> `run.render(key)` 查表 → 回落插件默认。

> challenge_flags.runId 仍引用 runs。events / event_platforms / challenges / challenge_remote /
> attachments / platform_request_log 基本不变。

---

## 十、HTTP API（草图）

### Run / Agent

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/challenges/:id/runs` | 手动入队（source=manual）；返回 run_queue 项 |
| GET | `/api/runs/:id` | run + agents |
| GET | `/api/runs/:id/agents` | run 下 agent 列表 |
| GET | `/api/runs/:id/messages?agentId=&after=` | 某 agent 的持久消息 |
| GET | `/api/runs/:id/stream` | run 级 SSE（全部 agent，事件已带 agentId） |
| POST | `/api/agents/:agentId/message` | **按 agent 发消息**（closed → 自动 resume+prepare+send） |
| POST | `/api/agents/:agentId/stop` | 中止该 agent 当前轮 |
| POST | `/api/runs/:id/close` | 释放容器（→closed） |
| POST | `/api/runs/:id/finish` | 强制完成 |
| POST | `/api/runs/:id/timeout` | `{ timeoutMs }` 设/延超时 |
| GET | `/api/runs/:id/files[?path=]` | 工作区 |
| DELETE | `/api/runs/:id` | 删除 |

### 任务队列

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/events/:id/queue` | 列队（pending + running） |
| POST | `/api/events/:id/queue` | 入队（手动） |
| PATCH | `/api/events/:id/queue/:itemId` | 改序/改参数（仅 pending） |
| DELETE | `/api/events/:id/queue/:itemId` | 移除（仅 pending；realized 拒绝） |

### 调度者

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/events/:id/scheduler` | 配置 + 状态（队列、活跃 run、并发/靶机占用、activeRunId） |
| PATCH | `/api/events/:id/scheduler` | `{ modelId?, instruction?, maxConcurrentTargets? }` |
| POST | `/api/events/:id/scheduler/start` | 建/启动调度者 run（= create；设 activeRunId） |
| POST | `/api/events/:id/scheduler/stop` | 中止当前轮 |
| POST | `/api/events/:id/scheduler/close` | 释放（→closed；清 activeRunId） |
| POST | `/api/events/:id/scheduler/message` | 给调度者 agent 发消息 |
| GET | `/api/events/:id/scheduler/messages` · `/stream` | 持久消息 / SSE |

### 编排注册表 / 模板

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/orchestrations` | 列出可用插件（id, scope, params schema, templates）供 UI 渲染 |
| GET / PATCH | `/api/prompt-templates` | 列出 / 编辑模板（按 plugin 分组） |

---

## 十一、前端

### 11.1 结构

每 event 三个 tab：**概览**（新）/ **题目**（原 Overview 改名）/ **settings**。删除原 Runs、Orchestrator tab。

### 11.2 概览页（两列，加左导航看似三列）

**左列顶部 5 tab：**

1. **总览** —— 解题进度、活跃 agents 概要。
2. **Timeline** —— 全局结构事件流（按时间，跨所有 run/agent）。v1 结构事件：run created/finished/closed、agent created/spawned、flag accepted、run timedOut（来自 run.meta.lastTimeoutAt）。示例形态：
   ```
   14:20  Scheduler └─ spawned Run #12
   14:21  Run #12   └─ spawned Bootstrap
   14:23  Bootstrap └─ finished probing
   14:24  Solver    └─ started
   14:35  Solver    └─ flag candidate
   14:36  Run #12   ✓
   ```
   （语义事件「produced/consumed finding」「intervened」随事件通道一起做，v1 不含。）
3-5. **Challenges / Runs / Agents** —— 三种视图的列表：Challenges 按 category 树（✓ 解出 / ● 有活跃 run）；Runs 列表；Agents 按 role 聚合计数。

**右列 Agents Graph**（占大宽）：层级图，顶部 Scheduler → 派生多个 Run → Run 可展开显示内部 agents。节点显示状态/模型/耗时。左列或图中点 agent → **大弹窗**（复用现有 Overview + Timeline + Files 组件）。

### 11.3 ConversationStore 多 agent demux（I4 —— P4 必做子项）

SSE 总线已支持多 agent 扇出（`bus.emit(channel=runId, {agentId, ...})`），但前端 `ConversationStore` 当前按 run 单对话建模。P4 需：
- stream 协议：`ready` 事件携带该 run 的 agentId 列表；每个事件已带 agentId。
- ConversationStore 按 agentId 分桶重建对话；agent 详情弹窗订阅对应 bucket。
- 一个 run 的 SSE 通道 demux 成 N 个 agent 对话。

### 11.4 手动开 run 入口

题目树点题 → 弹「选编排 + 模型（按 params） + 超时」→ 入任务队列。

---

## 十二、恢复与崩溃

- **recoverOnBoot**：启动时所有 `running`/`idle` 的 run 行标 `closed`（进程内 session 已没），回收孤儿容器。DB session + agent 行保留，可冷恢复。
- **冷恢复**（给 closed run 的某 agent 发消息）：建容器 → `resume(run)`（**全新 emitter**，重挂接线，零 session 操作）→ `prepare(该 agent)`（从 DB open session）→ `send(消息)`。其它 agent 不碰，触发器按需 open。
- **emitter 清理**：close 时 dispose 全部 handle + 清空 run 实例的 EventEmitter；resume 重建全新 emitter（保证不重复回调）。
- **跨重启的 agent id 稳定**：agent 行持久化，id 不变；调度者/observer 记下的 id 在恢复后仍有效。
- **create 原子性**（I9）：多 agent 建立任一失败 → 全回滚（abort 已 kick 的 agent + dispose + 释放容器 + 标 closed）。

---

## 十三、明确不做（记录待日后）

| 不做 | 理由 |
|---|---|
| 事件/产物通道（finding produce/consume） | v1 靠文件系统 + 非结构化 message 协作；Timeline 仅结构事件 |
| 任务队列优先级 | v1 纯 FIFO + 硬围栏 |
| 语义 Timeline 事件（intervened / produced finding） | 随事件通道一起做 |
| **跨 run 的 message_agent / read_agent** | v1 限定 run 内；跨 run 会触发另一个 run 的冷恢复，副作用过大（B5/S2） |
| `activity` 表 | v1 Timeline 从现有表 + run.meta 派生；语义事件落地后再加 |

---

## 十四、实施阶段

| Phase | 内容 | 产出 |
|---|---|---|
| **P0 schema v8** | 合并 runs/orchestrators；泛化 agents（+aborted）；新增 run_queue/scheduler_config/prompt_templates；sessions 挂 agentId + 冗余 runId；索引计划 | 全新 schema，拒旧库 |
| **P1 统一运行时** | **lifecycle 两级锁重写**（per-agentId turn lock + per-runId state lock + per-agentId 代次 + run 状态聚合，§4.5）；`RunHandle`/`AgentHandle`/`EventHandle`；createAgent 持久化 + 惰性 session；create/resume/prepare/send/drive；EventEmitter（close 清空/resume 重建）；**HOST_FILE_TOOLS 扩展到 7 个**；单一 runService | run 与 orchestrator 同构 |
| **P2 编排注册表 + 内置插件** | `defineOrchestration`、`orchestrations/registry.ts`；prompt_templates 注册 + `render()`；classic/observer-solver/bootstrap-solver/trio/scheduler 五个插件 | 拓扑可插拔 |
| **P3 调度者任务队列** | run_queue + 单飞排空器 + queue-lock + 围栏（scheduler 不计入）；超时（多 agent abort、无中点、lastTimeoutAt）；enqueue_run/set_run_timeout；scheduler_config 收口 | 调度者退化 |
| **P4 前端概览页** | 概览/题目/settings 三 tab；5 tab 左列；Agents Graph；agent 详情弹窗；**ConversationStore 多 agent demux（§11.3）**；队列编辑 | UI 重做 |
| **P5 打磨** | 多 agent run 的冷恢复/usage 汇总（用冗余 runId）；工具接线收敛；文档更新 | 收尾 |

---

## 附：关键决策索引（讨论 + 审查结晶）

1. **统一实体**：orchestrator = `scope:'event'` 的 run，scheduler 是其编排插件。不保留独立 orchestrators 表。
2. **按 id 寻址**：跨 agent 通信用持久 agent id；slot 仅 createAgent 幂等用。**v1 限定 run 内**（跨 run 推迟）。
3. **create / resume 分离**：create 跑一次（建+接+踢），resume 仅接线（恢复时 + create 复用）。create 禁放可变状态。无 isFresh。
4. **drive 拆 prepare/send**：prepare=容器+session 上线（幂等），send=发消息，drive=两者。
5. **惰性 session**：createAgent 不建 session；prepare/drive 触及才 create/open。→ 恢复只碰被消息的 agent。
6. **多 agent 并发**：两级锁 + per-agentId 代次 + run 状态聚合（§4.5）。
7. **finish_run 语义**：run 级一次性 finishing 标志（不被 onBeforeNewTurn 清）；其余 agent abort + 标 aborted；in-flight tool best-effort。
8. **任务队列**：持久化、整表重写（只动 scheduler pending，保护 manual）、FIFO + 硬围栏、排空单飞、用户可改。
9. **超时**：多 agent 全 abort → idle；硬限到期通知（无中点）、可延长、记 lastTimeoutAt。
10. **scheduler 不计入并发槽**；由用户显式 start，不进队列、不被 drainer 拉起。
11. **工具无别名**：真实名；file 工具 v8 扩展为 7 个始终开启。
12. **提示词模板独立表** `prompt_templates`，`render()` 查表→回落默认；不污染 FlatSettings。
13. **session_entries 保留冗余 runId** 保 run 级查询性能。
14. **scheduler_config 收口**所有调度者可编辑旋钮（model/instruction/target-cap + activeRunId）。

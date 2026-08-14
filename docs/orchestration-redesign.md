# 编排插件架构（v8 重构）规格

状态：**已实施（P0–P5 全部完成；schema v8 上线，191 测试全绿）**
Schema：**v8（已上线）**（**保留目录/历史表，仅 wipe 执行态 runs/agents/sessions，不写执行态迁移**；见 §十四迁移策略与 `apps/server/drizzle/0002_v8_unified_run.sql`）

> 本设计经「统一 Run + 编排插件」系列讨论 + 四轮子代理批判性审查合并而成。核心论断：
> **orchestrator 与 solver run 是同一种东西**——一个挂在 scope（challenge 或 event）上、
> 由某个编排插件定义内部 agent 格局的 Run。orchestrator 就是 `scope:'event'` + scheduler
> 编排的 Run。

---

## 一、目标与动机

1. **概念同构 + scheduler 折叠**：orchestrator 与 solver run 走同一条 agent 构建路径，差异只在模型/提示词/工具/编排插件。lifecycle/host/bus 在 v7 已抽出，故本重构的收益主要在**概念统一**（统一 Run/Agent/Plugin 抽象）、**scheduler 退化为插件**、以及**容器暖启动/状态落库/recoverOnBoot/工具接线**这些重复的消除——而非行数指标。
2. **可插拔编排**：Run 内部的 agent 组织方式（单 solver、监督式、串行探测、多模型对等…）由**编排插件**定义，一个编排一个 TS 文件。
3. **调度者退化**：调度者用**显式队列工具**维护任务列表，系统按序排空拉起；调度者仅在必要时接管。
4. **按 agent 寻址**：消息发往 agent（按持久 id），不是发往 run；恢复时只恢复被消息的那一个 agent。
5. **简化并发与数据模型**：run 状态由 SQL 派生（无 run 级锁）；sessions 挂 agentId（保留冗余 runId 保性能）。

---

## 二、核心抽象

只有三个一等概念。

### Run —— 唯一的部署单元

一个 Run = 一个 scope（challenge 或 event）+ 一个编排插件 + 一个共享容器/工作区 + N 个 agent + 三态生命周期。

- `scope:'challenge'`：解题 run（classic / observer-solver / bootstrap-solver / trio…）。
- `scope:'event'`：调度者 run（scheduler 编排）。它通过 scheduling 工具操控同 event 下的其它 run。

**一 Run 一容器**，Run 内所有 agent（含 spawn 的子 agent）共享，默认 cwd = 设置的 `container.workspace`（`/workspace`）。

### Agent —— 对 pi agent 的统一包装

一个 agent = 一个 pi session + 角色 + 模型 + 提示词 + 工具。agent 之间只在这四点上不同。

- `role`：自由字段，`'orchestrator'` 保留给调度者，其余由插件定义；spawn 子 agent 的 role 由 spawn 模板给（默认 `'child'`）。
- `id`：持久、跨恢复稳定；**一切跨 agent 的寻址用 id**。
- `slot`：Run 内唯一的 createAgent 幂等键（插件内部用）；spawn 子 agent 的 slot 由系统合成（§4.5e）。
- `parentAgentId`：spawn 委派；非空 = spawn 子 agent。
- 模型快照在 agent 上（trio 三模型 + per-agent 模型切换就靠这个）。
- **systemPrompt + tools 快照在 agent 上**（createAgent 首次写入，冷恢复原样复用——见 §4.3/§九）。

### Orchestration Plugin —— 编排配方（一个 TS 文件）

声明式输入 + 命令式接线：单一 `setup()` 建 agent、挂事件触发器；声明式 `prime` 表达首轮启动。调度者也作为插件提供。

---

## 三、插件 API（完整签名）

### 3.1 注册（判别联合，编译期挡 scope 误用）

```ts
function defineOrchestration<P>(plugin: OrchestrationPlugin<P>): OrchestrationPlugin<P>

type OrchestrationPlugin<P = any> = ChallengePlugin<P> | EventPlugin<P>

interface PluginBase<P> {
  id: string
  params: TSchema                            // 输入声明（typebox）；UI/enqueue 按它渲染
  templates?: Record<string, string>         // 默认提示词文案，注册时 upsert 进 prompt_templates（§3.6）
  spawn?: SpawnTemplate                      // spawn_agent 派生模板；省略 = 默认（仅 file、role 'child'）
}

interface ChallengePlugin<P> extends PluginBase<P> {
  scope: 'challenge'
  /** 新建 run 与冷恢复 run 都跑：createAgent（slot 幂等）+ 接线（on）。不 drive。 */
  setup(run: RunHandle<P>): void | Promise<void>
}

interface EventPlugin<P> extends PluginBase<P> {
  scope: 'event'
  /** 同上，多一个 EventHandle 订阅子 run 生命周期。 */
  setup(run: RunHandle<P>, event: EventHandle): void | Promise<void>
}
```

> **为什么只有一个 `setup`**：单一 `setup` 让 create 与 resume 跑**同一段代码**，插件无从区分两者 →
> 没有可以藏可变状态的「create 专属路径」，不变量从结构上消失。首轮启动由声明式 `AgentSpec.prime`
> 表达，系统在**新建**时对 prime agent 自动 `prepare()+send(prime)`，恢复时忽略。`isFresh` 仅存于
> 系统内部，不对插件暴露。

### 3.2 RunHandle

```ts
interface RunHandle<P = any> {
  id: string
  scope: 'challenge' | 'event'
  ctx: PromptContext                         // 统一渲染上下文（§3.7）
  params: P                                  // 已校验输入
  initialPrompt: string                      // scope-aware 渲染好的首轮提示词。
                                            // 手动/调度者入队时 queue.prompt 覆盖它；插件 prime: run.initialPrompt 自然承接
  /** 渲染提示词模板：当前插件 templates → builtin → 抛错（§3.6）。模板在 handle 构造时一次性载入内存 Map。 */
  render(templateKey: string, extraVars?: Partial<PromptContext>): string

  /** 声明一个 agent（slot 幂等）：
   *    首次 → 持久化 agent 行，含 systemPrompt/tools/model 快照；systemPrompt 用「该 agent 自己的 tools 派生的 capabilities」渲染（§3.7）。
   *    恢复 → 按 slot 复用既有行，**持久化快照优先**（用户 per-agent 切的模型 / 编辑过的提示词都保留），传入 spec 仅首次生效。
   *  不建 session——session 在 prepare() 惰性物化。 */
  createAgent(spec: AgentSpec): AgentHandle
  agent(slot: string): AgentHandle
  readonly agents: AgentHandle[]

  on(event: AgentEvent, cb: (e: AgentEventPayload) => void): () => void
}

interface AgentSpec {
  slot: string                               // Run 内唯一
  name: string
  role?: string                              // 默认 = slot；'orchestrator' 保留
  systemPrompt: string                       // 完整渲染好的字符串（用 run.render 构建）
  tools: string[]                            // 真实工具名（§六）；file 工具始终开启，不必列
  model: 'default' | ModelRef                // 'default' = 用 run 默认模型（仅首次；恢复用快照）
  prime?: string                             // 新建 run 时的首轮启动文本；系统 prepare+send(prime)；恢复时忽略
  entry?: boolean                            // 入口 agent（message_run 默认/前端默认对话）；每 run 至多一个（DB 级约束 §九）
}

interface SpawnTemplate {
  role?: string                              // 默认 'child'
  systemPrompt: string                       // 模板 key，系统用 child 上下文（name/task）+ 清零 capabilities 渲染
  tools: string[]
  model: 'default' | ModelRef
}

type ModelRef = { provider: string; modelId: string; thinking: ThinkingLevel }
```

### 3.3 AgentHandle（收敛 send，去掉冗余别名）

```ts
interface AgentHandle {
  readonly id: string                        // 持久、跨恢复稳定；寻址用它
  readonly slot: string
  readonly role: string
  readonly isStreaming: boolean

  prepare(): Promise<void>                   // 准备环境：容器在线 + 该 agent session 在线（首次=create，恢复=open）。幂等，不发消息
  send(text: string, deliverAs?: 'steer' | 'followUp'): Promise<void>   // streaming→steer，否则新轮（自动补 prepare）
  abort(): Promise<void>                     // 中止当前轮（agent→idle；run 状态由 SQL 聚合推导）

  on(event: AgentEvent, cb: (e: AgentEventPayload) => void): () => void
}
```

> 保留 `prepare`(环境)/`send`(消息) 拆分，砍冗余别名（drive≡send、steer⊂send）。`lastText()` 移出插件 facing handle → 内部 tool-context。

### 3.4 EventHandle（仅 scope:'event' 的插件用）

```ts
interface EventHandle {
  on(event: EventScopeEvent, cb: (e: EventScopePayload) => void): () => void
}
```

### 3.5 事件目录 + payload + 回调约束

```ts
type AgentEventPayload =
  | { type: 'turnEnded'; error?: string }
  | { type: 'flagAccepted'; flag: string; status: string }
  | { type: 'timedOut'; outcome: 'idle' | 'closed' }       // 见 §8.3 分支
  | { type: 'spawned'; childAgentId: string }
  | { type: 'finishing'; summary: string }

type EventScopePayload =
  | { type: 'run.started' | 'run.idle' | 'run.flagAccepted' | 'run.finished'; runId: string; agentId?: string }
  | { type: 'run.timedOut'; runId: string; outcome: 'idle' | 'closed' }
```

> **回调约束**：插件 `on` 回调在 generation-gated 的 per-agent settle 临界区内**同步**触发——stale settle
> 既不触发回调也不触发 run 聚合（§4.5b）。回调里 `send` 同一 agent 排到该 settle 之后；`send` 别的 agent
> 立即开新轮。**回调必须廉价、除 `send()` 外无副作用**；系统对回调调用包 **try/catch**（log + 吞，绝不冒泡）。
> re-entrancy 靠 per-agent chainLock 串行。

### 3.6 提示词模板注册与编辑（独立表）

`FlatSettings` 是封闭枚举，插件无法塞 `prompts.observerSystem` 这类 key。模板独立存储：

- 新表 **`prompt_templates`**（§九）：`(plugin, key)` 唯一，`body` + `updatedAt`。内置模板（mainSystem/childSystem/initial/orchestratorSystem）迁入此表（plugin='builtin'）。
- 插件 `templates?` 在注册时 upsert 默认文案：**仅当该 (plugin,key) 无用户编辑时**写默认。
- **`run.render(key)` 解析顺序**：**当前插件的 templates → builtin → 抛错**（同 key 时插件自己的默认压过 builtin）。
- 模板在 RunHandle 构造时一次性载入内存 Map，render 只查内存。
- **空串语义**：用户显式编辑为空 → 渲染为空串（不回退默认）。
- 设置页新增「提示词模板」分区，按 plugin 分组编辑（不进 FlatSettings）。

### 3.7 统一 PromptContext（per-agent capabilities，消除脚枪）

```ts
type PromptContext = {
  event: { id, name, platform?: string, promptHint?: string }
  challenge?: { id, name, description, category, points?, attachments, attachmentPaths }   // challenge-scope 才有
  agent?: { role, name, task?: string, isEntry?: boolean }                                 // spawn/子 agent 渲染用
  model?: { provider, modelId, name?, thinking }
  run?: { id, environment, workspace, isContainer, targetSupported, platformIntegrated, containerImage, cpus, memoryMb, pidsLimit }
  capabilities?: { canFinish, canSubmitFlag, canManageTarget, canSpawn }                    // per-agent，见下
  instruction?: string                                                                      // scheduler-scope 才有
}
```

- **capabilities 是 per-agent、由该 agent 的 `tools` 数组派生**（非 run 级）：`canFinish = tools 有 'finish_run'`、`canSubmitFlag = 有 'submit_flag'`、`canManageTarget = 有任一 '*_target'`、`canSpawn = 有 'spawn_agent'`。createAgent 渲染 systemPrompt 时注入该 agent 自己的 caps——bootstrap（无 finish_run）渲染时 `canFinish=false`，与工具集一致。
- `run.initialPrompt`：challenge-scope 用 challenge/event/model/run 渲染 `initial`；event-scope（scheduler）用 event+instruction+event 状态渲染。
- spawn 子 agent：系统用父 ctx + `{ agent: { role:'child', name, task } }` 调 `run.render(spawn.systemPrompt, …)`，**capabilities 置零**（child 无 flag/target/finish/spawn）。

---

### 3.8 附录：插件 API 现状（v12 演进，以 `orchestration/types.ts` 为准）

本节 §3.1–§3.3 的 `setup()` / `createAgent()` / `prime` 文本为 v8 设计稿，已**被声明式 `agents` + `wire()` 取代**（v10–v12 演进，无独立迁移文档）：

- 插件在定义时声明 `agents: AgentSlotSpec[]`（slot / role / name / isEntry / parent / systemPrompt 模板键 / tools / prime），不再在 `setup()` 里逐个 `createAgent()`；`createAgent` 的幂等键、快照优先级、systemPrompt 渲染收进 `createRunHandle`（`orchestration/run-handle.ts`）。
- `setup()` 改名为 **`wire(run)`**（challenge-scope）/**`wire(run, event)`**（event-scope），只做事件接线；不创建 agent、不 drive。
- `prime` 声明式保留：新建 run 时系统对 prime agent 自动 `prepare()+send(initialPrompt)`，恢复时忽略。
- 插件注册仍用 `defineOrchestration`（判别联合）；运行时行为以 `orchestration/types.ts` + `orchestration/registry.ts` + `run-handle.ts` 的实现为准，本节其余签名（PromptContext / capabilities / spawn 模板）仍然有效。

### 3.9 安全备注：已接受的提示注入面（2025-08 记录，不改代码）

以下面为**已接受的风险**（本地单兵 CTF 场景），仅记录不治理：

1. **远端平台内容注入 prompt**：challenge 名称/描述来自远端平台，经 handlebars `noEscape` 进入 system prompt / initial prompt（`prompt-templates-store.ts` 的 renderTemplate）。恶意平台数据理论上可注入指令文本；单用户本地部署下信任已配置的平台源。
2. **scheduler 强工具面**：event-scope 调度者持 `start_run` / `enqueue_run` / `close_run` / `set_run_timeout` 等强工具；若平台可注入调度者 prompt，理论上可间接驱动其烧 token / 操作 run。CTF 场景接受；若未来接入不可信平台，需在此处加净化层（模板渲染前对远端字段做转义/白名单）。

---

## 四、生命周期

### 4.1 Run 三态（SQL 派生 + 显式 closed 转换）

| 状态 | 含义 | 容器 | session |
|---|---|---|---|
| `running` | ≥1 个 agent（含 spawn 子 agent）正在 streaming | 在线 | 至少一个在线 |
| `idle` | 所有 agent 都 settle，无一 streaming | 在线（保留） | 在线（保留） |
| `closed` | 容器 + 所有 live session 释放 | 释放 | DB 保留，可冷恢复 |

> **维护路径**：① **SQL 派生**（running↔idle，§4.5b，每次 agent turn start/settle 后一条 UPDATE 重算）；
> ② **sanctioned 显式 closed 转换**（finish / close / timeout-SIGKILL / recoverOnBoot，直接写 `closed`）。
> 两条都合法；**除此之外不可自由 `update`**。聚合 SQL 的 `WHERE status IN ('running','idle')` 守卫保证
> closed 后聚合不再动它。围栏/catalog/get_status 仍是单表 `WHERE status=...`。

### 4.2 setup 调用时机（create 与 resume 跑同一段代码）

```
创建:  建 run 行 + 容器（任何 agent 首轮之前）→ 跑 setup(run[,event])   〔createAgent 持久化（含快照）+ 接线〕
       → 系统对每个带 prime 的 agent 自动 prepare()+send(prime)
温热:  不调（实例在内存，触发器直接生效）
关闭:  UPDATE status='closed' → 锁外异步 terminate container + dispose sessions；dispose 全部 handle；清空 EventEmitter；agent 行 + 历史 session 留 DB
恢复:  被消息某 agent → 围栏检查（§8.2）→ 建容器 → 跑 setup(run[,event])   〔全新 emitter，重挂接线，零 session 操作〕
       → prepare(该 agent，用持久化快照) → send(用户消息) → 重新武装超时定时器（§8.3）
       〔只它一个 session 从 DB open〕
```

- **setup 在创建和恢复时跑同一段代码**；温热下不跑。
- 插件**无从区分 create/resume**，无从藏只建一次的可变状态。
- **close 清空 EventEmitter**；resume 重建全新 emitter。
- **scheduler run 冷恢复与 challenge run 一致**：给 closed 调度者发消息 → 冷恢复（保留历史）；start 仍是 newSession 语义——遇已存在 closed 行 → 删旧行 + 全新 run。

### 4.3 惰性 session 物化（用持久化快照）

`createAgent` **不建 session**，只持久化 agent 行（含 systemPrompt/tools/model 快照）。session 在 `prepare()`/`send()` 首次触及时物化：

- 首次（无 session 行）→ `DbSessionManager.create`
- 恢复（有 session 行）→ `DbSessionManager.open`，**用 agent 行的 systemPrompt/tools/model 快照**重建 createHost（不重渲染、不回退默认——用户 per-agent 的编辑/模型切换都保留）。

因此**恢复只碰被消息的那个 agent**；其它 agent 保持休眠，直到某个触发器 `send()` 它才按需 open。

> 边界：某 agent 关闭前从未被 drive → 无 session 行；恢复后触发器 `send` 它时 `prepare()` 当作首次 create。

### 4.4 两条系统内置规则（插件不必声明）

1. **spawn 的子 agent `turnEnded` → 自动 deliver 给 parent**（`parent.send(结果文本)`）。
2. **任一 agent 调 `finish_run` → 终止整个 Run**（无锁、原子）：
   - `runs.finishing` 列，`finish_run` 在 tool-execute 时条件 `UPDATE runs SET finishing=1 WHERE id=? AND finishing=0`。**rows-affected=1 的那个 agent 负责 teardown**；其余 finish_run（rows=0）no-op（照常结束自己这轮）。
   - 负责 teardown 的 agent 等（或已）settle 后：对其余 streaming agent 各自 `abort()`（per-agent 锁内，in-flight docker exec best-effort），全无 streaming 后 `UPDATE status='closed'` + 锁外释放容器。
   - 发起 agent 标 `completed`；其余（含撞上来的第二个）标 `aborted`。
   - **finishing 置位 → teardown 之间到达该 run 的消息：落库（session_entries）但不重投**（run 终止中）。

### 4.5 并发模型（per-agent 锁 + SQL 派生，无 run 级锁）

v7 lifecycle 是 per-id 单 session/锁/代次。v8 多 agent 要求一 run 内 N 个对等 session。**不加 run 级锁**——run 状态由 SQL 派生：

**(a) per-agent 锁 + 代次（唯一并发机制）**

- drive/send/steer/abort 按 agentId 串行（per-agent chainLock）；prompt 长跑在锁外，仅 turn 开始/结束瞬间持锁。
- 代次守卫 per-agentId：同 agent 新轮覆盖旧轮，旧轮 settle 为 no-op。
- 不同 agent 的轮互不干扰（trio 三 agent 并行）。
- **回调**（on）在 generation-gated 的 settle 临界区内同步触发（§3.5）。

**(b) run 状态由 SQL 派生（无 run 锁、无内存集合）**

`agents.status` 逐 agent 持久化（turn start→`running`、settle→`idle`/`completed`/`aborted`）。每次 agent turn start/settle 后一条 SQL 重算 run 状态：

```sql
UPDATE runs SET status =
  CASE WHEN EXISTS(SELECT 1 FROM agents WHERE run_id=:runId AND status='running')
       THEN 'running' ELSE 'idle' END
WHERE id=:runId AND status IN ('running','idle') AND finishing=0
```

SQLite 单写者序列化保证一致；无需内存 `streamingAgents` 集合、无需 run 锁、无需「锁序无环」证明。

**(c) `finishing` 列 + 原子置位（无锁的 finish 语义）**

见 §4.4 规则 2。条件 UPDATE 的 rows-affected 决定谁来 teardown；聚合 SQL 的 `finishing=0` 守卫保证置位后 run 不会被错误翻回 idle。

**(d) closed 显式转换**

finish/close/timeout-SIGKILL/recoverOnBoot 直接 `UPDATE status='closed'`。聚合的 `WHERE status IN ('running','idle')` 守卫保证 closed 后聚合不再动它；teardown 在 UPDATE 之后锁外异步进行。

**(e) spawn 子 agent 的地位**

- `role` 由 spawn 模板给（默认 `'child'`）；`parentAgentId=caller`；**slot 系统合成**为 `child-<8字符id>`（满足 `unique(runId,slot)`）。
- **计入聚合**（child 在跑 → run `running`，占并发槽）。
- **spawn cap = 代码常量** `MAX_CHILDREN_PER_RUN`（默认 1，v8 不暴露配置）。
- run finish/close/timeout 时 child 一并 abort + dispose。
- **恢复边界**：setup 只重建插件**声明**的 agent；runtime spawn 的 child 不在 setup 里。child 关闭前在跑 → 恢复后不重 drive（结果丢失，parent 用 `read_agent` 取半成品）。**recoverOnBoot 把悬挂的 child `status='running'` 行 settle 为 idle**。

---

## 五、系统侧机制（插件不操心）

| 机制 | 说明 |
|---|---|
| 容器 | 每 run 一个 `sleep infinity` Kali 工具箱；bash 经 `docker exec` 转发；文件工具操作 host workspace。create 在 run 创建时；close 在 UPDATE closed 后锁外异步 teardown |
| Session | DB 单一真相源；`DbSessionManager` 写 `session_entries`；惰性 create/open，用 agent 行快照重建 |
| 并发 | **per-agent 锁 + 代次**（唯一并发机制）+ run 状态 SQL 派生 + `finishing` 列原子置位。**无 run 级锁**（§4.5） |
| EventEmitter / 触发路由 | agent 级 + run 级 + event 级；close 清空、setup 重建全新 emitter；回调 try/catch |
| 任务队列 + 排空 | `run_queue`；调度者用**显式队列工具** CRUD；排空器**单飞**；**全局 fence-lock** 包住 check+launch + queue 写 |
| 围栏 | 全局 `maxConcurrentRuns`（**只数 challenge-scope running run**，scheduler 不计；含 spawn 子 agent 在跑的 run）；per-event `maxConcurrentTargets`。排空/直接 start/发消息冷恢复三处强制；**全局锁内原子 check+launch**（§8.2） |
| 超时 | 每 run 一个硬定时器；到期 abort 所有 streaming agent + 有界宽限：宽限内全 settle→**idle**，否则 SIGKILL→**closed**；都记 `lastTimeoutAt` + `run.timedOut{outcome}` 通知。无中点。可延长。冷恢复重武装 |
| 模型切换 | per-agent：`POST /api/agents/:id/model`；run 级 UI = 切 entry agent |
| 结构事件日志 | Timeline 数据源（v1 从 runs/agents/challenge_flags + runs.lastTimeoutAt 派生；语义事件落地后再加 `activity` 表） |
| 工具接线 | 系统把工具名映射到接好线的实例。**file 工具集 v8 = read/bash/edit/write（同 v7，4 个）**——不扩 grep/find/ls（见 §六） |
| create 原子性 | 多 agent 建立任一失败 → 全回滚（abort 已 prime 的 agent + dispose + 释放容器 + 标 closed） |
| spawn cap | 代码常量 `MAX_CHILDREN_PER_RUN`（默认 1，§4.5e） |

---

## 六、工具目录（真实名，无别名）

**file 工具集（v8）= `read` / `bash` / `edit` / `write`，对所有 agent 始终开启。**
> 维持 v7 的 4 个。grep/find/ls 曾在更早版本存在，commit `545767e` **刻意删除**（薄封装、专家 agent 用 bash 即可、退休 requireBinary/分页维护）；v8 不重新引入。它们**不是 SDK builtin**，是 workspace/tools.ts 的自定义包装。

| 工具 | 作用 | 典型授予 | v1 范围 |
|---|---|---|---|
| `submit_flag` | 记录/校验 flag | solver 类 | — |
| `get_target` / `start_target` / `extend_target` / `stop_target` | 靶机生命周期 | solver 类（有靶机时） | — |
| `finish_run` | 终止整个 Run | 允许终止 run 的角色 | — |
| `spawn_agent` | 派生子 agent | 可委派的角色（**必须同时授 `read_agent`**，作「查看运行中 child」逃生舱） | — |
| `message_agent` / `read_agent` / `list_agents` | **按 id** 跨 agent 通信 | observer / peer / **所有 spawn-capable 角色**（read_agent 归属校验限本 run） | **v1 限 run 内**（跨 run 推迟） |
| `enqueue_run` / `list_queue` / `remove_queue` / `clear_queue` / `reorder_queue` | **显式队列 CRUD**（计划=队列内容，LLM 直接增删改，无 turn 边界耦合） | scheduler | — |
| `start_run` / `stop_run` | 直接建/中止 run（逃生舱） | scheduler | — |
| `message_run` / `close_run` / `read_run` | 接管某 run（默认指 **entry agent**） | scheduler | — |
| `set_run_timeout` | 设/延超时 | scheduler | — |
| `list_challenges` / `get_challenge` / `list_runs` / `get_status` | 只读盘点 | scheduler | — |

> **删 `inspect_agent`**（统一 read_agent）。**scheduler 不授 `message_agent`/`read_agent`**（跨 run 已禁）；保留 `list_agents`，跨 run 定位靠 `message_run`/`read_run`（指 entry）。

---

## 七、内置编排（完整代码）

### 7.1 classic —— 单 solver

```ts
export default defineOrchestration({
  id: 'classic', scope: 'challenge',
  params: Type.Object({}),
  setup(run) {
    run.createAgent({ slot: 'solver', name: 'Solver', entry: true,
      systemPrompt: run.render('mainSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
              'finish_run', 'spawn_agent', 'read_agent'],
      model: 'default', prime: run.initialPrompt })
  },
  spawn: { systemPrompt: 'childSystem', tools: [], model: 'default' },
})
```

### 7.2 observer-solver —— 监督式

```ts
function wire(run: RunHandle) {
  const solver = run.agent('solver')
  solver.on('turnEnded', () =>
    run.agent('observer').send('Solver 结束一轮。用 read_agent 看进展，需要纠偏就 message_agent steer。'))
  solver.on('flagAccepted', () =>
    run.agent('observer').send('Solver 提交了 flag，复核一下。'))
}
export default defineOrchestration({
  id: 'observer-solver', scope: 'challenge',
  params: Type.Object({ observerModel: ModelRefSchema }),
  templates: { observerSystem: DEFAULT_OBSERVER_SYSTEM },
  setup(run) {
    run.createAgent({ slot: 'solver', name: 'Solver', entry: true,
      systemPrompt: run.render('mainSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
              'finish_run', 'spawn_agent', 'read_agent'], model: 'default', prime: run.initialPrompt })
    run.createAgent({ slot: 'observer', name: 'Observer',
      systemPrompt: run.render('observerSystem'),
      tools: ['message_agent', 'read_agent', 'list_agents'], model: run.params.observerModel })
    wire(run)
  },
  spawn: { systemPrompt: 'childSystem', tools: [], model: 'default' },
})
```

### 7.3 bootstrap-solver —— 串行（先探测后解题）

```ts
function wire(run: RunHandle) {
  run.agent('bootstrap').on('turnEnded', () =>   // 一个 turn = 完整探测循环
    run.agent('solver').send('Bootstrap 探测完成，结果在 /workspace。开始解题。'))
}
export default defineOrchestration({
  id: 'bootstrap-solver', scope: 'challenge',
  params: Type.Object({}),
  templates: { bootstrapSystem: DEFAULT_BOOTSTRAP_SYSTEM },
  setup(run) {
    run.createAgent({ slot: 'bootstrap', name: 'Bootstrap',
      systemPrompt: run.render('bootstrapSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target'], // 无 finish_run → canFinish 派生为 false
      model: 'default', prime: run.initialPrompt })
    run.createAgent({ slot: 'solver', name: 'Solver', entry: true,
      systemPrompt: run.render('mainSystem'),
      tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
              'finish_run', 'spawn_agent', 'read_agent'], model: 'default' })
    wire(run)
  },
})
```

> entry（solver）与 prime（bootstrap）独立；capabilities 由 tools 派生（bootstrap 渲染时 canFinish=false）。

### 7.4 trio —— 3 个对等 solver（不同模型，共享容器+工作区）

```ts
export default defineOrchestration({
  id: 'trio', scope: 'challenge',
  params: Type.Object({ models: Type.Array(ModelRefSchema, { minItems: 3, maxItems: 3 }) }),
  templates: { trioSystem: DEFAULT_TRIO_SYSTEM },
  setup(run) {
    const slots = ['solver-a', 'solver-b', 'solver-c'] as const
    slots.forEach((slot, i) =>
      run.createAgent({ slot, role: 'solver', name: `Solver ${i + 1}`,
        systemPrompt: run.render('trioSystem'),
        tools: ['submit_flag', 'start_target', 'stop_target', 'extend_target', 'get_target',
                'finish_run', 'message_agent', 'read_agent', 'list_agents'],
        model: run.params.models[i], prime: run.initialPrompt,
        ...(i === 0 ? { entry: true } : {}) }))
  },
})
```

> finish 竞态：谁先 finish_run 谁的条件 UPDATE 置 finishing（rows=1，负责 teardown）；其余 no-op，teardown 时标 aborted。

### 7.5 scheduler —— 调度者（event scope）

```ts
function wire(run: RunHandle, event: EventHandle) {
  const orch = run.agent('orchestrator')
  event.on('run.idle',         (e) => orch.send(`Run ${e.runId} 转入 idle。`))
  event.on('run.flagAccepted', (e) => orch.send(`Run ${e.runId} 解出 flag。`))
  event.on('run.timedOut',     (e) => orch.send(`Run ${e.runId} 超时（${e.outcome}），决定延长/关闭/重排。`))
}
export default defineOrchestration({
  id: 'scheduler', scope: 'event',
  params: Type.Object({ model: ModelRefSchema }),
  setup(run, event) {
    run.createAgent({ slot: 'orchestrator', role: 'orchestrator', name: 'Scheduler', entry: true,
      systemPrompt: run.render('orchestratorSystem'),
      tools: ['enqueue_run', 'list_queue', 'remove_queue', 'clear_queue', 'reorder_queue',
              'start_run', 'stop_run', 'message_run', 'close_run',
              'read_run', 'get_status', 'list_challenges', 'get_challenge', 'list_runs',
              'list_agents', 'set_run_timeout'],
      model: run.params.model, prime: run.initialPrompt })
    wire(run, event)
  },
})
```

---

## 八、调度者模型

### 8.1 任务列表（run_queue）—— 显式队列工具（LLM 直接 CRUD）

- **持久化**，跨重启保留。
- **显式队列工具**：`enqueue_run` / `list_queue` / `remove_queue` / `clear_queue` / `reorder_queue`。计划 = 队列当前内容，LLM 直接增删改，**无 turn 边界时间耦合、无静默破坏**（取代 v3/v4 的 prune 启发式）。
- **enqueue_run upsert** 按 `(challengeId, orchestration)`：命中已有行（含 `done`/`cancelled`/`failed`）→ 复位 `status='pending'`、`runId=null`、更新 `ord`/`params`/`prompt`/`timeoutMs`；否则插入新行。
- 排空按 `ord` **FIFO**，围栏内拉起：容量足则立即建 run，不足则留队。
- 用户走 §10 API 手动入队/改序/删除（pending/done/cancelled/failed 可删；running 拒绝）。优先级以后再做。
- **启动失败路径**：drainer 拉起失败（容器/模型不可用）→ item `status='failed'` + 记 error；**scheduler 被 send 一条失败通知**（「item X 启动失败：<reason>，已标记 failed，可用 remove_queue 清理或重新 enqueue」）。scheduler 决定重排/放弃。避免 pending 死循环。

### 8.2 排空与围栏（全局 fence-lock 原子）

**排空单飞**：触发（队列变化 / run 释放容量 / 启动 / 冷恢复）合并为一次排空 pass，去抖（≈200ms）。

**全局 fence-lock**：`maxConcurrentRuns` 是**全局**上限，per-event 锁挡不住跨 event 竞态。用**一把全局 chainLock**（固定 key `'global-fence'`）包住所有「围栏 check + launch」（排空 / 直接 start / 发消息冷恢复）+ queue 写操作。本地单用户无 contention，一把全局锁即可，顺带把「排空单飞」变成琐事。

**围栏（三处强制：排空 / 直接 start / 发消息冷恢复）**：

1. **全局 challenge-scope running run 数 ≤ `scheduler.maxConcurrentRuns`**（默认 4）。只数 `scopeType='challenge' AND status='running'`（**scheduler 不计**；含 spawn 子 agent 在跑的 run）。**冷恢复一个 closed run = 占一个槽**，发消息前同样检查，满则拒绝（保持 closed）。
2. **不同 target 题**（target-capable 且未解）同时被攻 ≤ per-event `maxConcurrentTargets`（默认 1）。同题多 run 共享一个 target 槽；冷恢复同题 run 复占原槽。

**scheduler run 的拉起**（断递归）：用户 `POST /scheduler/start` 显式创建，**不进 run_queue、不被 drainer 拉起**。

### 8.3 超时（分支结果：idle 或 closed）

- 每 run 一个硬定时器（`timeoutMs`，默认 `scheduler.defaultRunTimeoutMs`）。
- 到期 → **遍历该 run 所有 streaming agent 各自 `abort()`** → **有界宽限（如 30s）等 settle**：
  - **宽限内全部 settle** → run **`idle`**（容器温热，可续）。
  - **仍未 settle**（SDK 卡死）→ **SIGKILL 容器**强制结束 → run **`closed`**（冷可恢复）。
- 两种结果都在 `runs.lastTimeoutAt` 记戳 → 触发 `run.timedOut { outcome: 'idle'|'closed' }` 通知调度者（§3.5）。
- **无中点提醒**。
- `set_run_timeout(runId, timeoutMs)` 延长/缩短（重置 deadline + 重设定时器），运行中可用。
- **冷恢复时重新武装**：resume 按 `deadlineAt - now` 剩余值重挂定时器。

---

## 九、数据模型（schema v8）

> **迁移策略**：保留目录/历史表（events / event_platforms / challenges / challenge_remote / attachments / **challenge_flags** / platform_request_log），仅 wipe 执行态（runs / agents / sessions / session_entries）+ 新建 run_queue / scheduler_config / prompt_templates。详见 §十四。

### runs（合并 orchestrators）

```
runs
  id PK
  scopeType        'challenge' | 'event'        notNull
  eventId          text FK events cascade        notNull
  challengeId      text FK challenges cascade    nullable          -- challenge-scoped 才填
  orchestration    text                          notNull           -- 插件 id
  status           'running'|'idle'|'closed'     notNull           -- SQL 派生 + 显式 closed（§4.1）
  finishing        integer boolean default 0                       -- finish_run 原子置位（§4.4/§4.5c）
  -- 容器 + 工作区
  containerName, image, cpus, memoryMb, pidsLimit, workspacePath, sessionDir
  -- 默认模型（agent 可覆盖）
  provider, providerLabel, modelId, modelLabel, thinkingLevel
  -- challenge 域（nullable；challenge-scoped 才填）
  source           'manual' | 'scheduler'        notNull default 'manual'
  timeoutMs        integer                       nullable
  deadlineAt       text                          nullable
  summary          text                          nullable
  error            text                          nullable
  queueItemId      text FK run_queue cascade     nullable          -- scheduler 源拉起时回填；run closed/finished → item 转 done 用此 + runId 守卫
  -- 结构化快照（独立列）
  params           text                          notNull default '{}'   -- 插件输入快照
  lastTimeoutAt    text                          nullable               -- Timeline 查的时间戳
  meta             text                          notNull default '{}'   -- 杂项
  createdAt, startedAt, updatedAt, completedAt
  -- 约束/索引
  unique index (eventId) where scopeType='event'          -- 每 event 至多一个 scheduler run
  index (scopeType, eventId); index (challengeId); index (orchestration)
```

> 删 `scopeId`（scope 由 scopeType + challengeId/eventId 表达）、`halfwayNotifiedAt`（无中点）。
> **queue.prompt → run.initialPrompt → prime**：排空拉起 run 时 `run_queue.prompt` 覆盖渲染出的 `initial` 模板结果作 `run.initialPrompt`；插件 `prime: run.initialPrompt` 自然承接。

### scheduler_config（event 级策略，1:1 event；收口）

```
scheduler_config
  eventId              PK FK events cascade
  modelId              text nullable          -- ProviderModel.id；null=全局默认。start 时解析成 run 的 params 快照
  instruction          text notNull default ''
  maxConcurrentTargets integer notNull default 1
  createdAt, updatedAt
```

> **删 `enabled`**（v7 持久 arm 开关）：v8「启用 = 存在非 closed 的 scheduler run」。注意 v7/v8 行为相同——`recoverOnBoot` 都把 running/idle 标 closed、且无 auto-start，重启后需手动 start（见 §14）。

### agents（泛化 + 快照 + aborted + isEntry DB 约束）

```
agents
  id PK
  runId            text FK runs cascade           notNull
  slot             text                           notNull                   -- spawn child = child-<8字符id>
  role             text                           notNull                   -- 自由；'orchestrator'/'child' 保留约定
  parentAgentId    text nullable                                            -- 非 null = spawn 子 agent
  isEntry          integer boolean default 0                                -- entry 标记
  -- 模型 + 提示词 + 工具快照（createAgent 首次写；冷恢复原样复用，§4.3）
  provider, providerLabel, modelId, modelLabel, thinkingLevel
  systemPrompt     text                           notNull                   -- 渲染好的完整字符串
  tools            text                           notNull                   -- JSON 数组（真实工具名）
  status           'running'|'idle'|'completed'|'aborted'|'failed'           -- +aborted
  sessionFile      text nullable                                            -- sessions.id
  name, task       text nullable
  createdAt, startedAt, updatedAt, completedAt, error
  unique(runId, slot)
  unique index (runId) where isEntry=1          -- DB 级「每 run 至多一个 entry」
  index(runId)
```

> 快照优先（§4.3）：冷恢复用 systemPrompt/tools/model 快照重建 createHost，不重渲染、不回退默认 → per-agent 模型切换/提示词编辑都保留。

### run_queue（新）

```
run_queue
  id PK
  eventId          text FK events cascade         notNull
  ord              integer                        notNull
  challengeId      text FK challenges cascade     notNull
  orchestration    text                           notNull
  params           text                           notNull
  timeoutMs        integer                        nullable
  prompt           text                           notNull                 -- 拉起时覆盖 run.initialPrompt
  source           'manual' | 'scheduler'         notNull
  status           'pending' | 'running' | 'done' | 'cancelled' | 'failed'
  runId            text FK runs cascade           nullable                 -- 拉起后回填
  error            text nullable                                           -- failed 时记原因
  createdAt, updatedAt
  index(eventId, ord); index(status); index(runId)
```

> **status 生命周期**：pending →（排空拉起）→ running（回填 runId）→（run closed/finished，由 run 侧经 `runs.queueItemId + runId` 守卫 UPDATE）→ done；拉起失败 → failed（记 error + 通知 scheduler）；cancel/re-enqueue 仅 pending。
> **DELETE 允许** pending/done/cancelled/failed（running 拒绝）。

### sessions / session_entries（挂 agentId + 保留冗余 runId）

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
  agentId          text FK agents cascade         notNull
  runId            text FK runs cascade           nullable      -- 冗余同步写；保 run 级查询性能
  parentId         text nullable
  seq              integer                        notNull
  type             text                           notNull
  data             text                           notNull
  createdAt
  unique(sessionId, seq); index(agentId, seq); index(runId, seq)
```

### prompt_templates（新）

```
prompt_templates
  plugin           text notNull      -- 插件 id（'builtin' for 内置）
  key              text notNull
  body             text notNull
  updatedAt        text notNull
  unique(plugin, key)
```

> challenge_flags.runId 仍引用 runs。events / event_platforms / challenges / challenge_remote / attachments / platform_request_log 基本不变（保留迁移）。

---

## 十、HTTP API（草图）

### Run / Agent

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/challenges/:id/runs` | 手动入队（source=manual）；返回 run_queue 项 |
| GET | `/api/runs/:id` | run + agents（含 entryAgentId） |
| GET | `/api/runs/:id/agents` | run 下 agent 列表 |
| GET | `/api/runs/:id/messages?agentId=&after=` | 某 agent 持久消息 |
| GET | `/api/runs/:id/stream` | run 级 SSE（全部 agent，事件带 agentId） |
| POST | `/api/agents/:agentId/message` | **按 agent 发消息**（closed → 围栏检查 → setup + prepare + send + 重武装定时器） |
| POST | `/api/agents/:agentId/model` | **per-agent 模型切换**（run 级 UI = 切 entry agent） |
| POST | `/api/agents/:agentId/stop` | 中止该 agent 当前轮 |
| POST | `/api/runs/:id/stop` | **run 级停止 = 中止该 run 所有 streaming agent** |
| POST | `/api/runs/:id/close` | 释放容器（→closed） |
| POST | `/api/runs/:id/finish` | 强制完成 |
| POST | `/api/runs/:id/timeout` | `{ timeoutMs }` 设/延超时 |
| POST | `/api/runs/:id/flag` | 手动 flag 录入（source=manual，保留「一题多解」数据流） |
| GET/POST | `/api/runs/:id/target[/:action]` | 靶机 inspect/start/extend/stop |
| GET | `/api/runs/:id/files[?path=]` · `/download` | 工作区 |
| DELETE | `/api/runs/:id` | 删除 |

### 任务队列

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/events/:id/queue` | 列队（pending + running + failed） |
| POST | `/api/events/:id/queue` | 入队（手动） |
| PATCH | `/api/events/:id/queue/:itemId` | 改序/改参数（仅 pending） |
| DELETE | `/api/events/:id/queue/:itemId` | 移除（pending/done/cancelled/failed；running 拒绝） |

### 调度者

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/events/:id/scheduler` | 配置 + 状态 |
| PATCH | `/api/events/:id/scheduler` | `{ modelId?, instruction?, maxConcurrentTargets? }` |
| POST | `/api/events/:id/scheduler/start` | 建/启动调度者 run（遇已存在 closed 行 → 删旧 + 全新；newSession 语义） |
| POST | `/api/events/:id/scheduler/stop` · `/close` · `/message` | 控调 |
| GET | `/api/events/:id/scheduler/messages` · `/stream` | 持久消息 / SSE |

### 编排注册表 / 模板

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/orchestrations` | 列出插件（id, scope, params schema, templates） |
| GET / PATCH | `/api/prompt-templates` | 列出 / 编辑模板（按 plugin 分组） |

---

## 十一、前端

### 11.1 结构

每 event 三 tab：**概览**（新）/ **题目**（原 Overview 改名）/ **settings**。删除原 Runs、Orchestrator tab。

### 11.2 概览页（两列，加左导航看似三列）

**左列顶部 5 tab：** 总览（解题进度/活跃 agents）/ Timeline（全局结构事件流，含 `run.timedOut{outcome}` 来自 `runs.lastTimeoutAt`）/ Challenges 树 / Runs 列表 / Agents 按 role 聚合。
**右列 Agents Graph**：Scheduler → Run → 展开 agent；点 agent → **大弹窗**（复用 Overview+Timeline+Files）。

### 11.3 ConversationStore 多 agent（P4，工作量小）

> **现状利好**：`conversation-store.ts` **已经按 agentId 分桶**（所有 Map 以 agentId 为键，SSE 事件已带 agentId）。故 v8 的「多 agent demux」**不是新架构，主要是 UI 接线**：stream `ready` 携带 agentId 列表；agent 详情弹窗订阅对应 bucket；run 入口默认订阅 `entryAgentId`。风险较前几版高估，P4 工作量小。

### 11.4 手动开 run 入口

题目树点题 → 弹「选编排 + 模型（按 params） + 超时」→ 入任务队列。

---

## 十二、恢复与崩溃

- **recoverOnBoot**：启动时所有 `running`/`idle` run 标 `closed`，**并把该 run 全部 agent 行标 `idle`**（含悬挂的 spawn child），回收孤儿容器。DB session + agent 行保留。scheduler run 标 closed → 显示「未启用」，需手动 start（同 v7）。
- **冷恢复**（给 closed run 的某 agent 发消息）：**围栏检查（§8.2，全局 fence-lock 内原子，占并发槽）** → 建 container → `setup(run)`（全新 emitter，重挂接线，零 session 操作）→ `prepare(该 agent)`（用 agent 行的 systemPrompt/tools/model **快照**从 DB open session）→ `send(消息)` → 按 `deadlineAt` 剩余值重武装超时定时器。其它 agent 不碰，触发器按需 open。
- **emitter 清理**：close 清空 run 实例 EventEmitter；setup 重建全新。
- **跨重启 agent id 稳定**：agent 行持久化，id 不变。
- **scheduler 冷恢复**：给 closed 调度者某 agent 发消息 → 走与 challenge run 相同的 restoreRunContext 路径（重建容器 + eventHandle + 快照 open session）；手动 start 仍是全新 run（删旧行）。
- **create/setup 原子性**：多 agent 建立任一失败 → 全回滚。

---

## 十三、明确不做（记录待日后）

| 不做 | 理由 |
|---|---|
| 事件/产物通道（finding produce/consume） | v1 靠文件系统 + 非结构化 message 协作；Timeline 仅结构事件 |
| 任务队列优先级 | v1 纯 FIFO + 硬围栏 |
| 语义 Timeline 事件（intervened / produced finding） | 随事件通道一起做 |
| **跨 run 的 message_agent / read_agent** | v1 限 run 内；跨 run 会触发另一个 run 的冷恢复 |
| `activity` 表 | v1 Timeline 从现有表 + `runs.lastTimeoutAt` 派生 |
| **`runs.status` 纯派生（不持久化）** | 保留持久化派生（单表查询性能）+ SQL 重算（§4.5b） |
| **spawn cap 可配置** | v8 仍是代码常量（默认 1） |
| **重新引入 grep/find/ls** | 维持 v7 删除决定（commit 545767e） |
| **scheduler boot 自动重拉起** | 默认不开（避免重启后突然烧 token）；可作可选配置 deferred |

---

## 十四、v7 → v8 行为变更 + 迁移策略

### 14.1 迁移策略（取代「全量拒旧库」）

| 类别 | 表 | 处理 |
|---|---|---|
| **目录/历史（用户资产）** | events / event_platforms / challenges / challenge_remote / attachments / **challenge_flags** / platform_request_log | **保留**（schema 改动小：challenge_flags.runId 仍引用 runs） |
| **执行态（瞬态）** | runs / agents / sessions / session_entries | **wipe**（v8 结构差异大：runs 合并 orchestrators + finishing/queueItemId、agents 加 systemPrompt/tools/isEntry/模型快照、sessions 删 owner 维度——迁移成本 >> 价值） |
| **新增** | run_queue / scheduler_config / prompt_templates | 新建（prompt_templates 写入 builtin 默认） |

> 保留用户导入的赛事 + 解题记录（一题多解），只重建执行层。SCHEMA_VERSION 仍 bump 到 8 拒旧库，但启动时若检测到 v7 库则**保留目录表、清空执行态表、建新表**。

### 14.2 行为变更清单（防「重构悄悄改行为」）

| 变更 | v7 | v8 |
|---|---|---|
| 发消息 | `POST /api/runs/:id/message`（发 run） | `POST /api/agents/:agentId/message`（发 agent） |
| run 级停止 | `POST /api/runs/:id/stop`（abort main） | 同路径，= 中止 run 所有 streaming agent |
| 提示词模板存储 | `FlatSettings` 的 `prompts.*` key | 独立 `prompt_templates` 表（builtin 迁移） |
| 中点超时提醒 | 30min 半程通知 scheduler | **移除**（仅到期通知） |
| 超时结果 | abort → idle | 分支：宽限内 settle→idle；SIGKILL→closed；事件带 outcome |
| `runs.source` 枚举 | `'manual' \| 'orchestrator'` | `'manual' \| 'scheduler'` |
| agent role | 固定 `'main' \| 'child'` | 自由文本；入口靠 `isEntry`（DB unique） |
| `mainAgent()` 查询 | `role === 'main'` | `isEntry = true` |
| 模型快照 | 在 `runs` | 在 `agents`（per-agent；切换 per-agent；冷恢复用快照） |
| **agent systemPrompt/tools** | 运行时重渲染 | **快照持久化**（createAgent 首次写；冷恢复原样复用） |
| orchestrator `enabled` 字段 | 持久 arm 开关 | **删**（启用 = 存在非 closed 的 scheduler run；重启行为同 v7：需手动 start） |
| file 工具 | 4 个（read/bash/edit/write） | **维持 4 个**（不扩 grep/find/ls） |
| `inspect_agent` 工具 | 有 | **删**（统一 read_agent；spawn-capable 角色必带） |
| 队列管理 | （无） | 显式 CRUD 工具（enqueue/list/remove/clear/reorder） |
| orchestrator 实体 | 独立 `orchestrators` 表 + service | 合并进 `runs`（scope='event'）+ scheduler 编排插件 |
| session 归属维度 | ownerType/ownerId + runId/agentId | 仅 agentId + 冗余 runId |
| 中点字段 | `halfwayNotifiedAt` | 删除 |
| spawn child slot | role='child' 隐式 | `child-<8字符id>`（显式合成） |

---

## 十五、实施阶段（P1 拆分 + 每 phase 测试目标）

| Phase | 内容 | 测试目标 |
|---|---|---|
| **P0 schema v8** | 合并 runs/orchestrators（+finishing/queueItemId）；agents 泛化（+isEntry/+aborted/模型快照/**+systemPrompt/tools 快照**）；run_queue/scheduler_config/prompt_templates；sessions 挂 agentId+冗余 runId；**目录表保留迁移**；索引；删 scopeId/ownerType/halfwayNotifiedAt/enabled | schema 升级 + 目录保留；isEntry unique；迁移用例 |
| **P1a lifecycle per-agent 泛化**（纯重构，不改对外 API） | per-agentId 锁 + 代次；**run 状态 SQL 派生 + finishing 列**（无 run 级锁）；现有 run/orchestrator 行为不变 | 多 agent 并发 settle；代次 guard per-agent；finishing 原子置位（第二个 finish no-op）；spawn child 计入聚合 |
| **P1b 数据层** | 惰性 session 的 DbSessionManager 改造（用 agent 行快照重建）；sessions/session_entries 挂 agentId + 冗余 runId；recoverOnBoot reconcile agent 状态 | 惰性 create/open；**冷恢复用快照**（per-agent 模型/提示词保留）；recoverOnBoot 无假 running |
| **P1c RunHandle + 加载器**（仅 classic 端到端） | RunHandle/AgentHandle/EventHandle；setup/send/prepare/prime/entry；prompt_templates + render（插件→builtin→抛错）+ 内存缓存；capabilities 由 tools 派生；queue.prompt→initialPrompt→prime 链路；接 classic 一个插件跑通 | classic parity；prime/entry；capabilities 派生正确 |
| **P2 内置插件 + 模板** | 迁 observer-solver/bootstrap-solver/trio/scheduler；统一 PromptContext；判别联合；spawn 清零 caps | 每插件 setup/finish 竞态；bootstrap canFinish=false；spawn 渲染 caps 清零 |
| **P3 调度者队列** | run_queue + **显式队列工具**（enqueue/list/remove/clear/reorder）；**全局 fence-lock** 包 check+launch+queue 写；围栏含冷恢复；超时（有界宽限/SIGKILL 分支/重武装/outcome 事件）；**启动失败→failed+通知**；run→queue 经 queueItemId+runId 守卫转 done | 全局 fence-lock 原子（跨 event 不超帽）；队列 CRUD；启动失败路径；超时 idle/closed 分支；done 转移守卫 |
| **P4 前端概览页** | 三 tab；5 tab 左列；Agents Graph；agent 弹窗；ConversationStore 多 agent（**已 agentId 分桶，主要 UI 接线**）；队列编辑 | 多 agent UI 接线；entry 默认订阅 |
| **P5 打磨** | usage 汇总（冗余 runId）；工具接线收敛；文档更新 | usage 聚合正确 |

---

## 附：关键决策索引（讨论 + 四轮审查结晶）

1. **统一实体**：orchestrator = `scope:'event'` 的 run，scheduler 是其编排插件。
2. **单一 `setup`**（取代 create/resume）+ 声明式 `prime`：消除「create 禁放可变状态」隐形不变量。
3. **单一 `send(text, deliverAs?)`**（取代 drive/send/steer）：保留 `prepare`(环境)/`send`(消息) 拆分。
4. **判别联合**：`scope:'challenge'→setup(run)` / `scope:'event'→setup(run,event)`。
5. **`entry` 形式化 + DB 约束**（`unique(runId) where isEntry=1`），取代 `role==='main'`。
6. **惰性 session + createAgent slot 幂等**：恢复只碰被消息的 agent；**用 agent 行 systemPrompt/tools/model 快照重建**（per-agent 模型/提示词保留）。
7. **并发极简**：**per-agent 锁 + 代次**（唯一并发）+ **run 状态 SQL 派生**（无 run 级锁、无内存集合）+ **`finishing` 列原子置位**（rows-affected 决定 teardown）。**无「锁序无环」证明负担**。
8. **run.status 双路径**：SQL 派生（running↔idle）+ sanctioned 显式 closed（finish/close/SIGKILL/recoverOnBoot）。
9. **finish 竞态**：条件 UPDATE 原子置 finishing；第二个 finish no-op；窗口内消息落库不重投；其余 agent abort/aborted。
10. **spawn 子 agent**：计入聚合、占槽；cap=代码常量；slot=`child-<8字符id>`；恢复后不重 drive（read_agent 取半成品）；recoverOnBoot settle 悬挂 child。
11. **队列 = 显式 CRUD 工具**（enqueue/list/remove/clear/reorder），**无 turn 边界 prune**；启动失败→failed+通知；done 经 queueItemId+runId 守卫转移。
12. **全局 fence-lock** 包围栏 check+launch+queue 写（maxConcurrentRuns 是全局上限）；三处强制（排空/直接 start/冷恢复）；scheduler 不计并发槽、不进队列、不冷恢复（start=newSession）。
13. **超时分支**：宽限内 settle→idle；SIGKILL→closed；事件带 outcome；无中点；可延长；冷恢复重武装。
14. **per-agent 模型 + per-agent capabilities**（由 tools 派生，消除「共享模板引用未有能力」脚枪）。
15. **统一 PromptContext**（scope-aware；render 顺序：当前插件→builtin→抛错；spawn 清零 caps）。
16. **prompt_templates 独立表**；render 内存缓存；空串=渲染空。
17. **session_entries 保留冗余 runId**；recoverOnBoot reconcile agent 状态。
18. **删 activeRunId / enabled / inspect_agent / halfwayNotifiedAt**；file 工具维持 4 个（不扩 grep/find/ls）。
19. **scheduler_config 收口** model/instruction/maxConcurrentTargets；runs 加 params/lastTimeoutAt/finishing/queueItemId 独立列。
20. **回调约束**：generation-gated settle 临界区内同步触发；try/catch；除 send() 外无副作用。
21. **迁移策略**：保留目录/历史表（含 challenge_flags），仅 wipe 执行态 runs/agents/sessions。

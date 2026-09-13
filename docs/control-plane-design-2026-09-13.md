# 控制平面重设计：领域事件流、调度者计划与效果调度器

日期：2026-09-13 · 状态：**已实施（同日落地，实施记录见文末）** · 范围：领域事件流（A）/ 调度者计划（B）/ 效果调度器（C）

本文只做设计与取舍记录，不改动任何代码。文中现状结论带 `文件:行号` 实证，行号对应当日 main。标注 **【已定】** 的是讨论中收敛的决策，**【建议】** 的仍是开放项。

## 0. 背景：剩余的两个根模型问题

2026-09-10 的架构评审（已归档）清掉了所有权分散、时间不可控、双实现温床三类结构债。本轮处理剩下的两个根模型问题——不是实现缺陷，而是根模型选择的次生代价。

**根模型一：控制平面的核心决策放在概率组件上。** 资源分配决策（派谁、停谁、下一步打哪）由调度者 LLM agent 做出，而其唤醒与响应是尽力而为的。为了「让正确的 agent 在正确的时间知道正确的事」，系统并存九个特设机制：

| # | 机制 | 实证 |
|---|---|---|
| 1 | per-agent 停滞 watchdog | `agent-runtime.ts:17`（AGENT_STALL_MS）、`:302-361` |
| 2 | 赛事级 fleet-watchdog | `run/fleet-watchdog.ts`（209 行） |
| 3 | 调度者 heartbeat | `channels-delivery.ts:324-345`（heartbeatDue 注释自认：「纯事件驱动会让安静的赛事与死掉的赛事不可区分」）、`:350-369` |
| 4 | dm urgent 冷唤醒 | `channels-delivery.ts:95-116`（coldWake）、`:266-269` |
| 5 | boot-reentry 重入提示 | `run/boot-reentry.ts` |
| 6 | queue starved edge（pending 2→1） | `queue.ts:128-164`（starvedFired 边沿记忆） |
| 7 | flush tick + 投递/队列暂停门 | `channels-delivery.ts:286-322`、`queue.ts:534-565` |
| 8 | haltEvent 五闸门 | `service.ts:637-667`（注释自认：没有 inbox hold，投递引擎会带着 halt 前积压唤醒调度者） |
| 9 | steer 合并 / 投递截断折页 | `agent-runtime.ts:198-218`、`channels-delivery.ts:191-199`（MAX_DELIVER_CHARS 折页） |

每个机制单独看都有道理、注释都写清了动机，合起来是在用特设补丁重新发明分布式系统里早已定型的概念：failure detector + 可靠唤醒。且确定性兜底（fence 启动侧强制校验、drainer 围栏判定）只保「执行」，不保「决策质量」——调度者失眠、误判、token 耗尽时，系统的上限是停摆报警。

**根模型二：同一现实有五份投影。** 「某道题现在怎么样了」分布在 `agents`/`sessions` 行、`challenge_flags`、`challenge_remote` 平台镜像、`progressOf` 推导、进程内注册表（AgentRuntime / WorkspaceContext / 容器引用计数）。一致性靠幂等锚点与注释维持：target slot 双视图对齐（`service.ts:311`）、`solved_at` 防二次清理（`db/schema.ts:73-75`）、`markRunning` 防取消竞态（`queue.ts:412-423`）。调度行为可观测性 = 读 LLM 的 DM 散文，无结构化 decision log。

附带两处：组装根的环未解（`service.ts` 1,575 行；`AgentFactoryDeps` 30 个字段 `agent-factory.ts:165-228`，近半为 service 闭包回调，factory ↔ queue ↔ channels ↔ service 经 RunPort late-bind 互指）；pi 序列化格式绑架数据层（`session_entries` 逐字节存 jsonl 行；`host-session.ts:98-103` 以 `as unknown as SessionManager` 跨私有类型边界）。

## 1. 三件承重结构与依赖

```
A 领域事件流（唯一事实源，状态皆投影）
   ↑ 供事实与因果
B 策略引擎 + 调度者计划函数（决策点驱动）
   ↑ 消费原语
C 效果调度器（延迟动作的统一原语）
```

- **A 是地基**：B 的 `plan.proposed` / `plan.result` / `fence.blocked` / `decision_point.*` 都是 A 上的事件；A 可独立先行。
- **B 是主体**：调度者从「持管理凭据的行动者」变为「决策源」；执行面零改动。
- **C 是横切**：B 的决策点合并与计划应用链直接消费 C 的原语，不新增定时机制。
- 实施顺序见 §5。不在本文范围：沙箱生命周期对齐（D）、自有会话模型（E）。

## 2. A — 领域事件流：唯一事实源，状态皆投影

### 2.1 边界：三个流，不是一个

| 流 | 表 | 定位 | 量级 |
|---|---|---|---|
| 领域事件 | `events`（新增） | 控制平面事实：谁被派了、为什么、fence 拒了什么、计划是什么 | 低频（每 turn / flag / 队列操作一条） |
| 通信 | `channel_messages`（现有，不动） | 内容平面 + 读游标语义，body 占体积 | 中 |
| 会话 | `session_entries`（现有，不动） | agent 认知内容，byte-for-byte pi jsonl 行 | 高（每行一条，envelope 税不值） |

控制面经瘦事件 `channel.posted`（引用 messageId）感知通信；usage 投影继续 fold `session_entries`（`event-pipeline.ts:93-120` 的增量 accumulator 原样保留）。

### 2.2 一条纪律：单一写路径 + 同事务投影

同步 SQLite 让事件溯源最贵的部分（最终一致的异步投影、补偿、重建管道）直接蒸发：**命令处理器在一个事务里 append 事件 + 更新投影**，强一致、零延迟。

```ts
function command(...):
  BEGIN
    facts = decide(...)          // 纯决策：校验、fence、状态机
    for e of facts: insert events
    for e of facts: project(e)   // 更新 agents / spawn_queue / challenge_flags / ...
  COMMIT
```

- **控制面基线表**（§2.5 所列：agents、spawn_queue / queue_state、challenge_flags / challenge_remote、challenges 的控制字段）形状基本不变，但**降级为投影**：只能被 projector 写。用户编辑态（scheduler_config、prompt_templates、settings、event_platforms、attachments）**不**事件化——没有需要因果重放的消费方，给它们上事件正是臆想式机器。
- 结构强制靠**模块边界**而非 lint 语义：全部投影写收敛进单一 projector 模块，这些表的 drizzle 写路径只允许它 import（读走查询门面）。`no-restricted-imports` 分不清同一 import 的读与写，不做逾越其能力的声称；projector 之外的直写由 review 层拦截 + 漂移测试兜底——诚实地说，这是「结构收敛 + 约定」，不是 lint 硬保证。
- 今天 service 里散落的 `updateAgent()` 直写收敛为「发事实，投影自动跟上」。每个字段写对应一个**有意义的动词**（`lastTimeoutAt` 不是字段更新，是 `agent.timed_out` 的一部分），防止事件类型退化为 CRUD 镜像。

### 2.3 Envelope

```sql
CREATE TABLE domain_events (            -- `events` 已是赛事实体表（db/schema.ts:23），流表避让
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 全局单调；亦是 SSE 的 Last-Event-ID（若启用，见 §2.7）
  type TEXT NOT NULL,                    -- 'agent.spawned'，注册表校验
  event_id TEXT,                         -- 热维度三列（可空，建索引）
  challenge_id TEXT,
  agent_id TEXT,
  actor_kind TEXT NOT NULL,              -- user | agent | system
  actor_id TEXT,                         -- agentId / 'drainer' / 'progress-machine' / ...
  causation_id INTEGER,                  -- 触发本事实的那条事件
  payload TEXT NOT NULL,                 -- 按 type 注册 schema 的 JSON
  created_at TEXT NOT NULL
);
-- 索引：(type,id) (event_id,id) (challenge_id,id) (agent_id,id) (causation_id)
```

事件类型在一个 TS 注册表里单点声明（type / payload schema / 投影契约 / 变量说明），配漂移测试——与 `PROMPT_TEMPLATES` 注册表同款做法。

### 2.4 事件目录（v1，约 30 类型；实施时按投影需求裁剪）

**赛事与题目**

| 事件 | 载荷要点 |
|---|---|
| `event.created` / `platform.bound` / `platform.unbound` | 绑定信息 |
| `challenge.imported` / `challenge.synced` | 同步 delta（available / solved / target 字段变化） |
| `challenge.overridden` | 手工覆写（manualSolveState / requiredFlags，含操作者） |
| `challenge.solved` | 首次进入 solved 的锚点（幂等防二次清理的事实化） |

**Agent**

| 事件 | 载荷要点 |
|---|---|
| `agent.spawned` | 完整 spawn 快照（model、systemPrompt、tools、source、queueItemId?、deadlineAt；**token 只落投影，不进事件流**——append-only 流无法事后清洗凭据）——agents 投影行由它建 |
| `agent.started` / `agent.turn_started` / `agent.turn_settled` | 回合结果：outcome、error?、summary?、tokens |
| `agent.session_prepared` | sessionId、toolDefinitions 快照（prepare 边界写 sessionFile / toolDefinitions 的事实化） |
| `agent.model_switched` | from、to、thinkingLevel（存活中换模型，落 SDK-clamped 实际值） |
| `agent.delivered` | 投递引擎结果：via（steer / followUp / fresh / cold_resume）、字节数 |
| `agent.deadline_armed` / `agent.timed_out` | deadline 事实化（timed_out 含 outcome 与 lastTimeoutAt） |
| `agent.reopened` | 冷恢复 |
| `agent.terminated` | **唯一终态路径发的唯一事实**：status、summary?、actor |
| `agent.deleted` | 级联前的最后事实（含频道清理作用范围） |

**调度与计划**

| 事件 | 载荷要点 |
|---|---|
| `decision_point.opened` / `decision_point.closed` | id、triggers[]；closed 带 outcome：plan / no_plan / violation / error |
| `plan.proposed` | planId、rationale、actions[]、decisionPointId?（actor = 调度者） |
| `plan.result` | planId、逐 ref 结果（慢动作回报也走这里） |
| `queue.enqueued` | itemId、ord、source（user / scheduler / plan:\<planId\>） |
| `queue.launched` / `queue.item_failed` / `queue.item_cancelled` / `queue.item_done` / `queue.reordered` | 排水与队列秩序的事实 |
| `queue.paused` / `queue.resumed` | 来源 |
| `fence.blocked` | 候选项、code、via（plan / queue / manual）——每次拒绝留痕，decision log 的金矿 |

**Flag 与靶机**

| 事件 | 载荷要点 |
|---|---|
| `flag.submitted` / `flag.accepted` / `flag.rejected` | flagId、值、来源、tier（first / extra / partial）、平台判定信息 |
| `target.action` | challengeId、start / stop / extend、结果与实例信息 |

**桥接与运维**

| 事件 | 载荷要点 |
|---|---|
| `channel.posted` | channelKey、messageId、authorType、authorAgentId?、urgent?（瘦引用，body 留在 channel_messages） |
| `boot.recovered` / `watchdog.escalated` | 恢复摘要；收敛后的看门狗升级告警 |

### 2.5 投影映射

| 投影表 | 由哪些事件维护 |
|---|---|
| `agents` | agent.* 全族 |
| `spawn_queue` / `queue_state` | queue.* |
| `challenge_flags` / `challenge_remote` / `challenges`（控制字段：requiredFlags / manualSolveState / solvedAt） | flag.* / challenge.* |
| `channel_reads`（游标） | 逻辑不变，读 channel_messages + channel.posted |
| usage | fold session_entries（现 accumulator 保留） |
| **decision log（新增）** | decision_point.* / plan.* / fence.blocked / agent.terminated / watchdog.escalated / boot.recovered——web 可查询视图 |

### 2.6 因果链与可观测性

「web-02 上为什么多了一个 agent」沿 causation 回放：

```
flag.accepted(web-01, tier=first)              ← flag.submitted ← agent-a3f1 提交
  └ decision_point.opened(D-47, triggers=[...])
      └ plan.proposed(P-31, rationale="web-01 收官，同族预算转向 web-02",
                      actions=[close(agent-a3f1), enqueue(web-02)])
          └ plan.result(P-31, [close ok, enqueue ok])
              └ queue.enqueued(item-88, source=plan:P-31)
                  └ queue.launched(item-88, agent-b7c2)
                      └ agent.spawned(agent-b7c2, model=..., deadlineAt=...)
```

调度不可观测的痛点到此为止：每个决策带 rationale、每次拒绝带 fence code、每条链可遍历。

### 2.7 SSE 与开机恢复

- v1 **不做** SSE Last-Event-ID 重放：事件流刻意不含会话与频道 body（§2.1），重放重建不了 UI 的两大持久面；且今天 seed 的本就是 volatile LiveBus 状态 + `agent.updated` 行（`run/sse.ts:145-184`，持久面一直走 messages API 回读）——不存在「被移除的依赖」。Last-Event-ID 留作 decision log 视图的后续增强（纯事实、天然可断点续传），有实证需要再上。volatile 层（tool 输出流、activity 徽章、context 快照）继续走 LiveBus，`run/host/live.ts` 语义不变。
- 开机恢复收缩为：投影表**就是**状态，`recoverOnBoot` 剩「in-flight 状态事实化（running → idle/terminated 重整）+ 引擎按投影重布触发器」；「resetRunning + 逐赛事 pause + 孤儿容器清扫」的特设时序并入标准恢复路径。孤儿容器清扫保留（容器是 DB 之外的外部资源）。
- deadline 一次性语义冻结不变：boot 后遗留 deadline 不重布防（`agent-runtime.ts:254-262`）。

### 2.8 演进

事件只追加、永不改写；类型演进只做加法（新类型、新可选字段），破坏性变更 = 新类型名。旧库本来就不升级（基线制）：bump `SCHEMA_VERSION`（现值 23，`db/schema.ts:21`）、重建基线。

### 2.9 明确不做

不做 saga / 流程管理器（drainer 仍是确定性循环，只是它写的每个状态都成了事实）；不做 async projector（同事务投影，无需）；不做 upcaster（无升级路径）；不把 session_entries 拆进事件流（量级不配）。

## 3. B — 控制平面归策略引擎，调度者降为「计划函数」

### 3.1 定位：从 API 客户端到决策源

今天：调度者是**持管理凭据的行动者**——bash heredoc 调 Python SDK，每个调用直接改变系统状态（原生工具面为空，`agent-factory.ts:297-300`）。
目标：调度者仍是有记忆、有会话的 LLM agent，仍读自然语言上下文；但它的**产出**是一个类型化计划，由确定性引擎校验、落地。**执行面零改动**：`spawn_queue`、drainer、fence、service 方法全部保留，变化的只是队列条目的生产者。

分工原则：**代码拥有控制平面，LLM 拥有判断；通信是自由文本，控制走结构化计划。**

### 3.2 计划文档（词表 v1）【已定：无 start 动作、无 DAG 依赖语法】

```ts
type PlanAction =
  | { ref: string; kind: "enqueue"; challengeId: string; prompt?: string;
      model?: string; timeoutMs?: number }
  | { ref: string; kind: "message"; agentId: string; text: string; urgent?: boolean }
  | { ref: string; kind: "stop" | "close"; agentId: string }
  | { ref: string; kind: "finish"; agentId: string; summary: string }
  | { ref: string; kind: "setDeadline"; agentId: string; timeoutMs: number }
  | { ref: string; kind: "cancelItem"; itemId: string }
  | { ref: string; kind: "reorder"; itemIds: string[] }
  | { ref: string; kind: "setQueuePaused"; paused: boolean }
  | { ref: string; kind: "noOp"; reason: string }

type Plan = { rationale: string; actions: PlanAction[] }
```

- `ref`：调度者自生成短 id。作用：逐条结果关联、重发幂等、校验错误精确到条。
- `rationale`：1–3 句决策理由，进 decision log，不参与执行。
- `noOp` 一等动作：「不动」必须显式声明并留档——静默从「不可判定」（想过了不动 vs 根本没醒）变「可判定」。
- **无 `start`**【已定】：它是词表里唯一「提交时 fence」的动词（fence 全仓仅 `agent-factory.ts:690` 与 `drainer.ts:169` 两处调用），是「提交时校验、落地时失效」误判 capacity 的唯一来源。且在计划世界没有存在理由：drainer 去抖仅 200ms（`drainer.ts:13`），队列路径近乎即时；队列历史是可观测性资产；paused 就是 paused，不存在「暂停中绕道派发」的合法场景。重启语义 = `close` + `enqueue`；复活同 agent = `message`（冷唤醒）。
- **无 `after`/DAG 语法**【已定】：需要它的唯一动作类（即时 spawn）已移出词表；剩余顺序语义被「队列 + launch 时 fence + 慢动作按序重校验」覆盖（§3.5）。让 LLM 在 JSON 里写 DAG 是引入新错误类，收益为零。
- 预算语义不新增：`timeoutMs` 仍是 per-agent 兜底，总量靠 agent 上限 + close 表达（与现状一致）。

### 3.3 提交通道：SDK `submit_plan`【已定收进 SDK】；传输档位【建议：stdin 先行】

- `aegisx.submit_plan(plan)` 收进 Python SDK，成为**唯一管理写动词**；读面（`snapshot()` / `challenges.get` / `agents.read` 等）保留。分界线画在「改变状态」上：**读走 SDK（灵活），写走计划（类型化）**。其余管理动词删除，GUIDE.md 的管理错误码表退役（错误以计划校验结果出现，不再需要模型学一张 12 行错误码表）。
- 校验必须住服务端（永远不信客户端）：SDK 函数签名做类型提示，服务端端点做真校验。回合协议与载体无关：引擎判定「决策点有回音」= 查是否存在 `causation` 指向该决策点的 `plan.proposed` 事件。
- heredoc 的痛在命令穿 shell 引用层（嵌套引号 + `$` 展开）。两档：
  - **便宜档【建议先做】**：bash 工具旁加 `python` 工具，参数为脚本原文，宿主 `exec(["python3", "-"])` 写 stdin——中间没有 shell 层，模型写的就是纯 Python，零转义，宿主侧约几十行改动（hijacked exec 本就支持双向流）。
  - **贵档【暂缓】**：常驻 REPL（`python3 -i` 随 workspace 存活，bash 工具改喂数行按提示符收输出）。多买到的只有跨调用变量持久化，而 GUIDE 已声明无 REPL 语义（复用逻辑落 `scheduler_lib.py` 再 import）；为此引入会话监督、输出帧协议、解释器挂死处理不值。出现模型确实需要保持大对象跨调用的实证再上。
- 已标注代价：控制路径从宿主侧挪进容器，**调度者的行动能力与容器共享失效域**（容器僵死则无交计划通道）。缓解：调度者容器 lifecycle 管理、永不 sweep；「回合有、计划无」违约路径保证可观测、有界（§3.6）。

### 3.4 返回值：按成本分相，提交即见后果【已定方向：返回带 queueAfter】

动作按耗时两相（**分类在应用时刻按目标状态判定**）：

- **快动作**（毫秒级、无 fence）：`enqueue` / `cancelItem` / `reorder` / `setDeadline` / `setQueuePaused` / `message`（目标存活时——steer 或 drive 发起即返回）。
- **慢动作**（有界等待或容器 I/O）：`close` / `finish`（有界 abort 最长 5s，`service.ts:162`、`agent-runtime.ts:399-407`）；`message` 目标为终态时也归慢相（冷唤醒触发 resume：容器 + 会话重建）。`stop` 在现状是**无界** await（`service.ts:498-501`——pi 的 abort 不打断进行中的工具调用）——计划执行器须给 `stop` 单独的有界等待（超界按 close 的 force-dispose 语义处置），这是新增要求，不是现状保证。

```ts
type SubmitPlanResult = {
  results: PlanRefResult[]       // 每条 ref：applied / rejected(code, message) / deferred
  queueAfter: QueueItemPublic[]  // 快动作应用后的队列视图
  deferred: Array<{ ref: string; kind: string }>  // 慢动作，结果下一决策点经 plan.result 回报
}
```

校验错误（引用不存在 / 状态错 / ref 重复 / `solved_blocked` / 自指终态动作——对提交者自身的 stop/close/finish 拒绝，调度者生命周期走引擎与用户路径 / schema）同步返回，**同回合修复**——今天的等价流程是「SDK 抛 AegisxError → 下一轮才知道 → 重写脚本」，一个修复回路横跨多个 turn；新模型里它是一次工具结果往返。计划的不透明由此消解：提交即见队列变化，同回合内可修正重交。

### 3.5 顺序语义【已定】

- **列出顺序 = 应用顺序**，校验从不重排。计划非事务、无回滚——部分应用 + 逐 ref 结果 + 下一决策点全貌，就是恢复模型。
- 快动作按序列 inline；慢动作按序进 per-event 单飞后台链，**每条在自己落地的时刻重新校验状态**（fence、目标状态），而非提交时刻。
- 跨相规则：快动作永远不等慢动作前驱——词表审计后（`start` 已移出），没有任何快动作的有效性依赖某个慢动作的效果。
- 槽位类顺序（stop/close 腾位 → 补位）**由队列保证而非计划**：enqueue 不 fence，drainer launch 时逐项 fence（`drainer.ts:169`），agent 终态触发排水（`agent-status.ts:211`）；等待期间题被解出则 drainer cancel（challenge_solved → cancel），竞态被队列吸收。这正是队列存在的意义，计划设计继承它而不是重新发明。
- 连续两次提交在 per-event 应用链上串行。

示例（卡死 worker 重启）：

```
submit_plan([close(X), enqueue(A, model=opus)])
  → close(X)   deferred（有界 abort，最长 5s）
  → enqueue(A) inline，queueAfter 立即显示新 pending 项
  → close 落地（agent.terminated → scheduleDrain）→ drainer fence 重查通过 → launch
  → plan.result(P, [r1: ok, r2: ok])
```

### 3.6 决策点驱动

调度者回合不再由投递触发，而由引擎在**决策点**确定性驱动。决策点 = 合并后的触发集 + 载荷（触发事实 + 裁剪到相关的快照 + digest）。

| 触发 | 对应当今机制 |
|---|---|
| `agent.settled`（终态 / idle） | 投递引擎的 settled 通知 |
| `flag.accepted` / 部分进度 | orch-notices flagAccepted / flagPartialProgress |
| `queue.changed`（用户入队 / 低水位 / 暂停恢复） | queueStarved 边沿 + queueStateChanged |
| `launch.failed` / `agent.timedOut` | launchFailed / agent.timedOut |
| `user.directive`（人给调度者的 DM） | dm urgent 冷唤醒 |
| `solver.asked`（solver 经 orch 求援 / 提问） | orch 投递面（`channels-delivery.ts:35-41`，调度者的投递面就是 orch）——合并、非紧急；未读 orch 内容开启决策点 |
| `platform.target`（实例就绪 / 失败） | **无当今机制**（NoticeEvent 联合里没有 target 类）——新增触发，由 `target.action` 事实供料 |
| 周期复核（心跳） | 投递引擎 heartbeat |
| `boot.resync`（重启恢复） | boot-reentry 提示 |

规则：

1. **合并**：一个窗口内的非紧急触发合成一个决策点（解出清理连关三个兄弟 agent = 一个回合，不是三个）；紧急触发（首次 flag、launch 失败）立即冲刷。即今天 flush tick 做的事，从投递引擎搬进引擎、语义显式化。
2. **回合协议**：决策点注入为特殊载荷（不再是频道消息）；回合内可自由发频道消息（回答 solver 的 ask、给 #team 广播——**通信保持自由文本**），但必须以 `submit_plan` 收束（noOp 可）。`submit_plan` 常开、不限于决策点回合（调度者主动性保留：模型醒着的任何时候都能交计划）。
3. **违约确定性**：回合结束没有计划 → 引擎补一条严格提醒重试一次 → 仍无则记「决策点 D-x 无决策」进 log，继续运转 → 连续违约升级为对用户的 urgent 告警。唤醒本身不可能失败——引擎驱动的就是自己进程内的 session，没有跨进程投递可丢。
   - `scheduler_config.paused`（用户禁用调度者，W3）→ 引擎不发决策点、不做违约升级——第三道闸门收在引擎一处，与队列暂停并列。
   - unattended 模式下，升级告警走 `watchdog.escalated` urgent orch 通知（与今天 `eventStalled` 同通道——无人值守时它就是报警面）。
   - outcome=error 的回合（provider 失败）**不计**违约：引擎经 retry 原语退避后重发同一决策点。
4. 心跳 = 引擎自有周期触发；自上次 noOp 以来状态指纹未变则跳过（省掉「安静赛事每小时烧一次心跳 turn」的固定成本大半）。

### 3.7 九个补丁的归宿

| 现有机制 | 归宿 |
|---|---|
| per-agent 停滞 watchdog | 收缩：`agent.settled` 已是决策点；只有「决策点产出 noOp/无决策且局面持续 ≥ stallMs」才升级告警 |
| fleet-watchdog | 唤醒职责删除；残留职责并入违约升级路径 |
| 调度者 heartbeat（lastDeliveredAt 簿记、静默时钟） | 删除，被引擎周期触发替代；digest 变为决策点载荷标准段（渲染逻辑原样搬家） |
| dm urgent 冷唤醒 | 「调度者终态但赛事未完」是引擎可见状态，复活 = reopen + 决策点的确定性动作；投递引擎的 urgent/coldWake 分叉消失 |
| boot-reentry | 变成标准 `boot.resync` 决策点载荷变体 |
| queue starved edge（starvedFired） | 降级为引擎触发器的合并策略，不再是有自己 Map 的机制 |
| flush tick + 投递/队列暂停门（对调度者部分） | 收敛为引擎级一个事件闸门（与 scheduler paused 并列）；**solver 面投递保留**——#team/dm 的通信投递引擎照旧 |
| haltEvent 五闸门 | 收敛为两个动作：引擎停发决策点 + 队列暂停（inbox hold / 调度者暂停 / 投递门的组合不再需要） |
| steer 合并 / over-budget fold | 不动（solver 面投递的渲染规则） |

净效果：投递引擎退回它本来的职责——把**人话**送到 agent 上下文里；控制回路的全部可靠性问题收口到引擎一处。

### 3.8 读面与账本

- Python SDK 砍管理动词（`queue.*`、`agents.stop/close/finish/message/set_timeout/start/compact`），保留只读深查与**通信写**（`channels.post` / `ask`）。分界线的精确表述是**资源与生命周期状态 vs 通信**，不是「读 vs 写」——频道发帖也是状态变化，但它是通信。`compact` 不进计划词表：压缩不是调度决策，worker 的上下文由 steer 掌控。
- `orch` 频道保留为**投影**：决策点、计划、应用报告各落一条人可读账本行（模板体系沿用，orch-notices 的事件→模板管线换出口），供人与 web UI 审计。不再承担唤醒职能 → urgent 语义与 paused 门对 orch 失效。
- 调度者发起的 `setQueuePaused(true)` 带自动过期（或 UI 标注来源决策点），防「自暂停后死亡卡死队列」。

### 3.9 崩溃、幂等、并发

- 计划是事实不是内存态：`plan.proposed` / `plan.result` 落库。崩溃在两态之间 → 重启重放未应用计划（校验重跑，fence 可能已变，这正确）。
- 调度者超时重发同一计划：去重键为 `(schedulerAgentId, ref)`，对 `plan.proposed` 历史解析——同 ref 同内容 = 幂等返回原结果；同 ref 不同内容 = `duplicate_ref` 拒绝。enqueue 恒为 append 的语义不受影响，超时重发不会双入队。
- 用户并发：用户在计划应用中途入队/关 agent——两边过同批锁与 fence，无新竞态类别；被抢的 action 结构化失败，下一决策点模型自见。
- 每赛事串行应用（单飞链），对应 drainer 的单飞语义。
- 重放尊重暂停语义：交互模式 boot 的「队列暂停等人复核」写保留（drain 对 paused no-op，`queue.ts:386-406` 的 paused 过滤），计划重放同样尊重 queue / scheduler paused；unattended 照旧续排。

### 3.10 风险与开放问题

- **模型不理会协议**：偶发不调 `submit_plan`。违约路径兜底（重试一次 → 留档 → 升级），且该失败模式可观测、有界、可恢复，优于今天的静默不醒。
- **表达力上限**：多步策略（「先探三个靶再决定」）分解为多个决策点；引擎职责是把 apply → settle → 下一决策点的环转紧。真出现多步事务需求再加 plan stages——现在不加。
- **决策到落地延迟**：turn settle 后立即应用，秒级，不是下一个心跳。
- **主要工程量在语料**：调度者提示词与模板从「写脚本的操作员」切到「交计划的规划者」——提示词工程，不是架构工程。

## 4. C — 效果调度器

### 4.1 现状：原语统一，语义未统一

`run/clock.ts`（2026-09-10 落地）统一了定时器**原语**（Clock + TimerHub，fake clock 可注入）。但各子系统仍手写**调度语义**，同型机制至少五处独立实现：

| 子系统 | 手写语义 | 实证 |
|---|---|---|
| drainer | 去抖(200ms) + 单飞 + trailing trigger + capacity 自唤醒(5s) | `drainer.ts:13,18,109-227` |
| 投递引擎 | per-agent promise 链 + 全局 flush interval + 静默钟 | `channels-delivery.ts:65-86,286-345` |
| fleet-watchdog | 周期 + episode 去重记忆 + 进展窗口 | `run/fleet-watchdog.ts` |
| 容器 lifecycle | sweep interval + idle TTL + SIGKILL 宽限 | `run/container-lifecycle.ts` |
| agent runtime | 一次性 deadline + grace + stall 重布 + 有界 abort | `agent-runtime.ts:246-407` |
| 平台轮询 | 间隔 + 有界重试 | `platforms/flags.ts` / `targets.ts` |

归纳为五个 recurring 原语：**debounce 后沿合并 / per-key 串行单飞 / 有界重试自唤醒 / 一次性截止 + 宽限 / 周期巡检 + 边沿去重**（+ 静默钟 helper）。

### 4.2 目标形态

Clock 之上加一层 effect 原语，子系统**声明效果**而非手写定时器状态机：

```ts
effects.debounce(key, ms, fn)      // 后沿合并（drain 200ms、决策点合并）
effects.chain(key, fn)             // per-key 串行单飞（投递链、计划应用链）
effects.retry(key, ms, bound, fn)  // 有界自唤醒（capacity retry、平台轮询）
effects.after(ms, fn)              // 一次性（deadline / grace；TimerHub 薄封装）
effects.every(ms, fn)              // 周期（flush、watchdog、sweep）
```

- TimerHub 仍是底层；fake clock 驱动一切（现状已达成，effect 层继承，全仓一个时间推进习语）。
- 收益：语义不再各写一遍（今天 drainer 的 trailing trigger、投递链的 catch-continue、watchdog 的 episode map 是三份同型不同细节的实现）；run/ 的裸定时器状态机归零。
- 已有例外维持：`app.ts` 的 bootstrap 重试退避与 providers 上游 fetch 超时**有意不接**（真实墙钟计量，2026-09-10 评审记录在案）。

### 4.3 与 B 的咬合与恢复语义

- B 的决策点合并 = `debounce(decisionPointKey)`；计划应用链 = `chain(eventId)`；B 不新增定时机制。
- effects 不持久化。恢复规则：**事实在事件库，效果从投影导出**——pending 队列项 → `debounce(drain)`；watchdog / sweep / flush 重启即周期。不可安全导出的效果不导出（deadline 一次性语义：boot 后遗留 deadline 不重布防，现状冻结）。交互模式 boot 的暂停写保留——派生的 drain effect 对 paused 事件 no-op（与 `pendingItems()` 的 paused 过滤一致，`queue.ts:386-406`）；unattended 照旧续排（`agent-factory.ts:905-930` 语义不变）。

### 4.4 迁移映射

| 现有 | 归宿 |
|---|---|
| drainer 的去抖 / 单飞 / trailing / capacity-retry 四合一 | `debounce` + `chain` + `retry` |
| 投递 flush tick + lastDeliveredAt 静默钟 | `every` + 静默钟 helper；B 落地后 heartbeat 退役，solver 面投递保留 |
| fleet-watchdog 周期 + episode 记忆 | `every` + 边沿记忆（B 后收缩为升级路径） |
| 容器 sweep + idle TTL | `every` |
| per-agent deadline / grace / stall | `after` + `chain`（留在 runtime，TimerHub 不变；stall 在 B 后收缩） |
| 平台轮询 | `retry` |
| B 新增：决策点合并、计划应用链 | `debounce` + `chain`（消费原语，不新增机制） |

## 5. 实施顺序

1. **A 先落**：事件流 + 同事务投影 + decision log 投影。直接切换、按表分批（先 queue / flags 等低风险表，后 agents）——基线制下没有旧库要保护，双写观察期是伪装的兼容层，漂移断言属一次性脚手架，与本仓「不留兼容层」相悖。web 的 decision log 视图立即可用。
2. **C 并行**：纯重构，行为不变，现有测试兜底。
3. **B 切片一**：`submit_plan` 端点 + SDK 函数 + 应用器；调度者双轨（SDK 管理面仍在，计划并行可用，独立可验证）。
4. **B 切片二**：决策点引擎接管唤醒，调度者切计划制。
5. **收尾**：删 SDK 管理动词、watchdog / heartbeat / stall 收缩、orch 转投影、九补丁归位。

每批完成后 `bun run check` + `bun run test`（动 agent API 面 + `bun run test:sdk`）全绿再进。

## 6. 代价声明

- **A**：写入放大（每次状态变化多一条事件写；单机 SQLite 无压力）+ projector 是新的表维护逻辑面。
- **B**：调度者产品手感从「常驻顾问」变「被点名的规划者」；提示词与模板语料重写是最重工程量；控制路径与调度者容器共享失效域（§3.3 已标注缓解）。
- **C**：一次性迁移 churn，行为不变。

## 7. 实施记录（2026-09-13 同日落地）

| 批次 | 内容 | 提交 |
|---|---|---|
| 1（并行） | A：`domain_events` 表 + registry/store/projector（同事务投影）+ 决策日志 API，queue/flags/challenges 写路径迁移（schema v24 基线）∥ C：`run/effects.ts`（debounce/chain/retry/after/every），drainer / 投递 / 看门狗 / 容器 sweep 行为不变迁移 | `431892a` ∥ `6546eab` |
| 2（并行） | A：agents 表全部写迁移到事件流（token 走 projectorInput 不入载荷；drainer 侧 `fence.blocked`；targets.ts targetIgnored 收口）∥ W：web「决策日志」页签 | `39a7ca0` ∥ `24e3b66` |
| 3 | B：`POST /api/events/:eventId/plan` + `run/plan/applier.ts` + `aegisx.submit_plan`（双轨，SDK 管理动词暂留）；`plan.proposed`/`plan.result` 事件 | `c8c6891` |
| 4 | B：决策点引擎（`run/decision-points/engine.ts`）接管调度者唤醒；投递引擎退回 solver 面；heartbeat / boot-reentry / starved 边沿 / inbox hold / 调度者 digest 附着删除；提示词语料切换计划协议 | `a67dd23` |
| 5（并行） | SDK 砍管理动词（保留读 + 通信 + submit_plan；删除孤儿路由 agents/finish、agents/timeout）；per-agent 停滞定时器删除、收缩进引擎（noOp 后指纹停滞 ≥ stallMs 升级）∥ web 决策日志补全 plan / decision_point / agent 全族渲染与因果链引用 | `eb4e2f6` ∥ `47c5d64` |
| 收尾 | 本文档状态转已实施 + architecture.md / AGENTS.md 同步 | （本提交） |

**实施中的偏差记录**（与 §2–§4 正文对照）：

- 事件目录按投影需求扩展：新增 `queue.item_reset/removed/edited/cleared`、`flag.deleted`、`challenge.progress_reset`、`agent.session_switched`、`agent.recovered`；`decision_point.closed` 的 outcome 无 `no_plan` 值（noOp 计为 plan，避免死值）。
- §2.2 的投影写强制收敛为**模块边界**（单一 projector 文件）+ 约定，非 lint 语义（`no-restricted-imports` 分不清读写）。
- §2.7 的 SSE Last-Event-ID 未实施（正文已降级为后续增强）。
- §3.4 的 `stop` 有界化落地为 applier 内 `stopAgentBounded`（closeAbortGraceMs 上限，超界走标准 settle 路径）。
- `platform.target` 触发器暂缓（platforms 层组装先于 agent service，无引擎通路；靶机失败经 agent.settled/timedOut 间接到达）。
- §3.8 的 `setQueuePaused` 自动过期未做，落地为 `queue.paused` 事件的 planId 标注（正文的「或」分支）。

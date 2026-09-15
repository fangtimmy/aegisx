# 架构重设计：分层装配、计划原生工具化、控制面事件化与读模型投影化

日期：2026-09-15 · 状态：**设计（已评审修订，未实施）** · 范围：A 分层装配 / B 计划原生工具化 / C 决策点状态事件化 / D 读模型投影化与会话保留；E 执行隔离与外围收敛**明确暂缓**（§6）

本文只做设计与取舍记录，不改动任何代码。现状结论带 `文件:行号` 实证（对应当日 main）。标注 **【已定】** 的是方向性决策（含 2026-09-15 与用户的范围裁定：A–D 做、E 不做），**【建议】** 的仍是开放项。前置阅读：[control-plane-design-2026-09-13.md](control-plane-design-2026-09-13.md)（A/B/C 三件承重结构）与 [sandbox-session-design-2026-09-13.md](sandbox-session-design-2026-09-13.md)（D/E 两项），本文是它们的续篇，处理「正确概念贯彻不完全」遗留的四个结构痛点。

## 0. 总体判断与范围

前两轮重设计已解决根模型问题：`domain_events` + 同事务投影（事实在库、状态皆投影）、决策点引擎（调度者唯一唤醒源）、每 agent 一次性沙箱 + 短时铸造凭据、自有会话存储。这些根模型决策**全部保留**（§9）。本轮处理的是同一原则没有贯彻到底的四处：

| # | 痛点 | 一句话 |
|---|---|---|
| P1 | 组装根是一张闭不上的循环依赖图 | agent 内核与控制平面是对等互指模块，而非上下层 |
| P2 | 计划提交走容器 HTTP 旁路 | 关联靠时间窗启发式，幂等靠全表扫描 |
| P3 | 控制平面有一半活在内存里 | 决策引擎每赛事状态易失，重启靠 LLM 回合重同步 |
| P4 | 读面是临场重算的 | stats/usage 三份副本临场聚合；SSE 不可续传把一致性复杂度推给浏览器；会话条目无界增长 |

**范围【已定】**：§2–§5（A/B/C/D）纳入实施；§6 的 E（控制面进程 + 可抛弃 agent worker 的执行隔离）与外围收敛（平台 adapter 公共件、配置归一、bootstrap 契约数据化、unattended profile）暂缓——暂缓不是否决，是本轮不做。另一个讨论过的更根本替代方案（确定性策略打底、LLM 只在拐点出手）经评估**否决**：平台核心价值恰是 LLM 的自适应调度，且现有架构已把 fence/queue/排水做成确定性兜底、LLM 错误写不坏系统，平衡点是对的；保留的工程方向是把驱动调度者的机制成本（P2/P3）降到接近零。

## 1. 痛点清单（实证）

**P1 · 组装根与循环依赖。** `createAgentService`（`run/service.ts`，1,807 行）同时是 agent 生命周期管理、调度者管理面、flag 钩子、工作区文件面、以及全部兄弟模块的接线员。构造期循环（service ↔ factory ↔ queue ↔ channels ↔ engine）无法用普通 const 闭合（`service.ts:232-235` 注释自认），为此发明了 `run/ports.ts` 的写一次/读前必须 bind 的 late-binding 槽位（`service.ts:236-238`）；`AgentFactoryDeps` 28 个字段、其中 9 个是 service 闭包回调（`service.ts:1500-1541`）。代价是复利的：每接入一个子系统都要加一对闭包 + 一个 port；测试只能走整机装配（`test/helpers.ts` 514 行的 `makeAgentService` 镜像每一个 option；`run/channels.test.ts` 1,778 行是症状而非原因）。根因：**agent 内核（容器 + 会话 + 回合驱动 + settle）和控制平面（queue/fence/engine/channels）互相需要，是横向闭包关系而非纵向依赖**。

**P2 · 计划提交是容器 HTTP 旁路。** 调度者经 bash + Python SDK 走 `POST /api/events/:eventId/plan` 交计划（control-plane §3.3 的选择，其代价声明自认「调度者的行动能力与容器共享失效域」）。两个次生代价：(a) **关联是时间窗启发式**——`correlatePlan`（`decision-points/engine.ts:429-508`）在回合 settle 后扫该赛事全部 `plan.proposed` 事件、逐条 `Date.parse` 对比窗口下界；(b) **幂等是无界扫描**——`proposedHistory`（`plan/applier.ts:143-206`）在每次 submitPlan 读全量 `plan.proposed` + `plan.result` 事件重建 ref 历史，O(事件数) 随赛事时长线性增长，无投影无游标。

**P3 · 控制平面的易失半区。** 决策点引擎的每赛事状态——pending 触发、打开中的决策点、violation 计数、stall episode、quietFingerprint——全在易失的 `states: Map`（`engine.ts:238`）。后果：崩溃时打开中的决策点永远没有 `closed` 事实（decision log 悬尾）；violation/stall 重启归零；每次重启每个有活调度者的赛事烧一个 `boot.resync` LLM 回合（`service.ts:1685-1688` → `engine.ts:677-692`），对安静赛事是纯浪费——而 unattended appliance 下重启是常态。control-plane §4.3 的原则「事实在事件库，效果从投影导出」没有覆盖引擎自身。

**P4 · 读面三宗。** (a) **统计临场重算**：`buildEventStats`（`events/stats.ts`，约 548 行单函数）混合 SQL 聚合与 JS 线性扫描（循环内 `find`/`filter`，约 `stats.ts:249/289/438`），usage 汇总全仓三份（stats SQL / `session-queries.sumUsageTotals` / web `accumulateUsage` 逐回合 fold）；`catalog.ts` 的 `getEvent = listEvents(eventId)[0]` 让单赛事读付全量聚合。同事务投影的基础设施已在，投影却只覆盖控制面基线表。(b) **流不可续传**：SSE 无 Last-Event-ID（control-plane §2.7 有意推迟），web 端长出 `conversation-store.ts`（532 行、约 12 个 Map、epoch 纪律、retain 驱逐、「首快照前的 commit」幽灵守卫 `conversation-store.ts:341-344`）——一套手写的客户端缓存一致性协议，存在原因是快照与活跃事件的无序竞态。(c) **会话无界增长**：`session_entries` 无任何保留策略（architecture.md 自认），全库最大表，stats 对其全表扫描；v26 已列化 usage 但不做 rollup 材料化，原始行永远不能安全裁剪。

**P5 · 外围裂缝（本轮不动，记录在案）。** platforms adapter 的 targetAction 三连 / 分页循环 / synthetic event id 在 3-4 个 adapter 重复；flags.ts 一个约 270 行函数串四种判定 regime；providers 配置在 JSON ConfigStore 与 SQLite 两个家、`publicProvider` 把 apiKey 原样回给 UI（`providers/routes.ts:173`）、「脱路径转发」两份实现（`providers/relay.ts` 与 `scripts/relay.ts`）；bootstrap.ts 七个关注点合一、组织方契约 env 别名三级优先链、`spec.eventName ??= "tsecbench"` 平台名泄漏进默认值（`bootstrap.ts:305`），且此类契约 shim 仍住 server 代码、按赛事增长；unattended 分支散在 recoverOnBoot / fleet-watchdog / bootstrap 多处。

**P6 · 单进程一切（本轮不动）。** HTTP + SSE + 全部 agent loop + docker 控制 + SQLite 写同进程。≤32 agent 的单机使命下是合理取舍，但故障域共享、重启即全场冷恢复；其解（执行隔离）见 §6-E。

## 2. A — 分层装配

### 2.1 目标分层

```
L0 事实与投影   db + domain-events（store/registry/projector）+ queries（不变）
L1 会话存储     sessions/session_entries + pi-session-adapter（不变，归位）
L2 agent 内核   容器 + 会话 + 回合驱动 + settle；对外只暴露动词接口（§2.2）
                ——不认识 queue/fence/engine/notices 中的任何一个
L3 控制平面     queue / fence / drainer / decision engine / plan applier /
                channels / orch-notices / fleet-watchdog / scheduler-admin
L4 面           routes / SSE / app / bootstrap：组合根，唯一持全图的地方
```

依赖规则【已定】：

- **L3 → L2 只经内核动词接口**；**L2 → L3 只经组合根注册的出站回调**（回合 settle、终态、状态事实）。单向，无环。
- **L3 模块之间允许单向依赖**（queue 是被依赖的存储型模块，applier/依赖它），禁止环。今天的环全部来自 L2/L3 互指，内核抽出后自然消解：channels.send = 内核 send，engine.send = 内核 send，queue.launch = 内核 prepare——不再是闭包。
- fence 的**代码**归 L3（`fence.ts` 不动），但驻留点是内核 spawn 序列里的 **admission 临界区钩子**【已定】：今天 fence 检查 + `agent.spawned` 投影写（行插入）在一个全局临界区内原子完成（`agent-factory.ts:726-771`），行插入即占位（building 的 agent 已计入并发上限），prompt/model/workspace 渲染发生在临界区**之前**（`agent-factory.ts:633-719`）——这段序列是内核对自己的行做的操作，整体留在内核；组合根把「checkSpawnFence + 全局 fence 锁」绑进钩子（L2 认识「admission 钩子」这个抽象点，不认识 fence 的内容与锁）。锁序不变式（fence 临界区绝不获取 agent 锁，`service.ts:224-227`）随钩子契约重述。drainer 与用户面的 launch 入口是 **L3 spawn-service**（admission 语义 + launch 序列：prime send 与 `channels.deliver`，`agent-factory.ts:777-793`），不是裸内核动词。

### 2.2 内核的窄接口

```
prepare(agentId, spec)            // spawn 序列：渲染 → admission 临界区（钩子，§2.1）→ 行插入 → 容器 + host session + 工具注入
send(agentId, text, deliverAs?, opts?)  // steer / followUp / fresh turn / 冷恢复；opts.assertLive 是投递引擎的活性竞态守卫（channels-delivery → agent-runtime），不能丢
abort(agentId)
settle(agentId, opts)             // 唯一终态路径
armDeadline(agentId, iso)
// 只读：hasSession / isStreaming / sessionOf / workspaceKeyOf
// 工作区运行时：ensureWorkspaceRuntimeFresh / forgetWorkspace（今散在 service.ts:851-857/1699/1711 的消费一并归位）
// 多会话操作（现 agent-session-ops）：listSessions / createSession / activateSession / backtrack
```

内核拥有：`runtimes` 注册表（`service.ts:195`）、`AgentRuntime`、spawn 组装（含 admission 钩子）、settle 语义、`destroySandbox`、per-agent `chainLock`、状态核的内核半。

**agent-status 拆分**【已定，评审修正】：`agent-status.ts` 不是干净的内核件——它一半是状态事实写 + LiveBus emit（内核），一半是生命周期副作用：模板化 lifecycle 通知（含 urgent 与 paused 门，`agent-status.ts:150-168`）、queue 释放与重排水（`:262-263`）、引擎三类 trigger 喂食（`:216/264/167`）、aborted 目录回收、靶机停止政策。后者归 L3 的**生命周期反应器**，经组合根注册的出站回调进入。回调次序是内核契约：现 `terminalizeAgent` 的次序（bus.forget → markDone → scheduleDrain → onAgentTerminal → notice）原样保留，A 批只搬家不改序。

`service.ts` 解散：生命周期动词归内核，调度者管理面（start/pause/resume/close/halt/resumeEvent、digest）归 L3 scheduler-admin，flag 钩子（notifyFlagAccepted/stopOthersOnSolved）归 L3（它们是控制平面政策对平台事实的反应），工作区文件面归 L4 小模块。路由不重写：L4 保留一个**薄组合面**（现 `AgentService` 公共形状，逐成员转发到内核/L3）——它是组装根，不是兼容层：只做接线与转发，不新增行为别名【已定】。

### 2.3 消失与保留

| 消失 | 保留 |
|---|---|
| `run/ports.ts` 与全部 late-binding 槽位 | `run/effects.ts` / `run/clock.ts`（时间层原样，各层共用） |
| `AgentFactoryDeps` 闭包回调面（9 个） | `run/host/*` 依赖方向 lint（扩展，见 §2.4） |
| fence 在 factory 内的检查点 | 测试的 `makeAgentService` 整机门面（瘦身为组合根的组装函数；内核/L3 另有各自 fake） |

### 2.4 强制手段

`.oxlintrc.json` 的 `no-restricted-imports` overrides 现已强制 host 内层边界；同机制扩展：L2（kernel）禁止 import 任何 L3/L4 模块；L3 禁止 import `run/kernel/*` 的内部（只许经 `run/kernel/index.ts` 公共出口）。控制面设计 §2.2 的诚实结论在此复用：lint 分不清读与写，这是「结构收敛 + lint 方向断言」，不是完备保证，review 层兜底。

## 3. B — submit_plan 原生工具化

### 3.1 机制【已定】

内核在组装 **orchestrator** 会话时注入宿主侧原生工具 `submit_plan`（与 solver 的文件工具同机制；按 role 注入，不依赖 spawn 快照的 tools 列）。工具的 JSON Schema 与 HTTP 端点共用同一份 TypeBox 计划 schema——该 schema 今天住在 `run/routes.ts:183`，B 批先上移 `@aegisx/shared`（加法演进），工具与端点共用单一来源。注入机制已实证可行：宿主侧自定义工具走 pi 的 `extraTools` 通路（`host.ts:114-121`），`agent.session_prepared` 的 toolDefinitions 快照自动收录新工具（`agent-factory.ts:908-918`）。失去容器 HTTP 通道无回归：计划端点的唯一 agent 调用方就是调度者（`agent-auth.ts:111-114`），用户无 token 直调，`submitPlan` 无其他消费方。handler 进程内直呼 plan applier（以该调度者的 agent principal），`SubmitPlanResult`（含 `queueAfter`）作为 tool result 同回合返回。控制通道不再经过容器 HTTP，「调度者行动能力与容器共享失效域」的代价随之消失。

计划校验、`plan.proposed`/`plan.result` 事实化、快慢两相应用、per-event 单飞链——**全部不变**。变化的只有提交载体与关联方式。

### 3.2 关联与幂等【已定】

- **关联精确化**：applier 落 `plan.proposed` 的同时（同事务后）同步登记 `notifyPlanSubmitted(schedulerAgentId, planId)`（组合根接线的一行闭包，不新增查询）。**登记不消费**【已定，评审修正】：消费只发生在该调度者回合**干净 settle** 且 `open.awaiting` 时（engine.ts:400-405 的现语义），且登记须绑定回合代际——代际由内核的工具 handler 附加（工具调用本就发生在内核回合内），代际不匹配的登记作废；时间窗今天承担的「上一点的登记不得满足下一点」防串扰职责由回合代际承接。回合 error 的路径逐字不变：即使计划已应用也走 handleError 重发，与今天一致。用户/系统经 HTTP 端点提交的计划不登记（schedulerKey ≠ 调度者 agentId，维持「不关闭调度者决策点」的现有语义）；`POST /api/events/:eventId/plan` 端点保留（用户面逃生舱）。
- **幂等投影化**：新增 `plan_refs` 投影表（`(eventId, schedulerAgentId, ref)` 唯一；canonical JSON、planId、outcome JSON 可空），由 projector 从 `plan.proposed` / `plan.result` 同事务维护。`proposedHistory` 的事件扫描换为查该表；幂等语义（同 ref 同内容幂等返回 / 同 ref 异内容 `duplicate_ref` 拒绝）不变。

### 3.3 违约阶梯的归宿【已定】

阶梯**保留为政策**（重申一次 → violation 留档 → 连续三次升级），但**检测归 harness**：回合结束时引擎问内核「本回合是否调用了 submit_plan 工具」（工具调用本就是内核可见的会话事件），不再依赖散文协议约定。`payloadMessage` 的「回合协议」段与 `repromptMessage` 随之简化（仍声明协议，但未收束是 harness 可判定事实，不是措辞约定的违反）。

### 3.4 SDK 与语料【已定】

- Python SDK 删除 `submit_plan` 及全部 plan 助手（契约测试 `contract.py` 的「已删动词」断言清单加入 submit_plan）；SDK 收敛为「读 + 通信」。GUIDE.md 管理章重写为工具用法。
- 调度者语料重写（control-plane §3.10 预判过的「最重工程量」）：mainSystem / 决策点 payload 协议段 / 模板从「bash 调 SDK 交计划」改为「以 submit_plan 工具调用收束回合」。工具校验错误以 tool result 形态出现（JSON 与 HTTP 面一致），模型学习面反而缩小。

## 4. C — 决策点状态事件化

### 4.1 状态 → 事实/投影映射【已定】

新增投影表 `decision_state`（eventId 主键），由 projector 在同事务内维护；引擎状态全部可从它水合：

| 引擎状态（今内存） | 归宿 |
|---|---|
| pending 触发 | 新事实 `decision_point.triggered`（载荷 = DecisionTrigger）→ `decision_state.pending` 累积；gated 丢弃不落事实（与今语义同） |
| open point | `decision_point.opened`（已有）→ `decision_state.open`；driveAwaited 的**两条**清空路径都落新事实 `decision_point.flushed`（reason: gated \| no_scheduler，`engine.ts:308-317`） |
| reprompt 相位 | 新事实 `decision_point.reprompted` |
| errorRetries | **可失**（不落库）：崩溃代价 = 退避计数归零、同一点至重重发 maxErrorRetries 内的一次，无正确性影响 |
| violations | `decision_state.violations`：`closed(outcome=violation)` 递增；`watchdog.escalated(reason=scheduler_violation)` 清零（事实已有） |
| stall episode | `decision_state`（sinceMs / fingerprint / escalated）：all-noOp close 携带标志 arm；escalated 事实置位；periodic 检测到指纹变化落 `decision_point.stall_cleared` 清除 |
| quietFingerprint | `decision_state.quietFingerprint`：随 all-noOp close 的载荷携带 |

`decision_point.closed` 载荷扩展（加法演进，registry 允许）：`outcome` 之外增加 `allNoOp`、`quietFingerprint`。decision log 读面自动获得更完整的因果。

### 4.2 引擎重启水合【已定】

引擎启动时从 `decision_state` 水合全部赛事（内存结构不变，只把「状态的写」换成「事实 + 投影」）。孤儿 open point（重启前在驱动中）落 `closed(outcome=error, reason=boot)`；pending 非空按原语义 scheduleFlush。**运行时语义不变**：合并、紧急冲刷、违约阶梯、stall 升级的逻辑一行不动，动的只是状态的存储介质。

### 4.3 boot.resync 收窄【行为变化，已定】

今天：每个有存活调度者的赛事无条件发 `boot.resync`（`engine.ts:677-692`）。收窄为只在两种情况发：**(a)** 水合发现未决业务（孤儿 open point / 非空 pending）；**(b)** 重启前该调度者处于 running（回合被打断，会话冷恢复后需要重新同步）——判定锚点是同批 `recoverOnBoot` 落下的 `agent.recovered` 事实（载荷 `from: "running"`；recoverOnBoot 先翻转再触发，`service.ts:1685-1688`，引擎可查同批事实）。安静 idle 赛事的重启成本 = 0 条 LLM token。unattended 模式语义不变（队列续排水不依赖调度者唤醒，drainer 独立，`agent-factory.ts:1018-1019`）。

### 4.4 写放大评估

每个触发一条事实（主要是每回合 settle 一条 `agent.settled` 触发）。触发频率的上限就是回合频率（秒级 LLM 流式之间的离散事件），SQLite 同事务 append + 投影的量级无压力（control-plane §6 已声明同类写入放大可接受）。

## 5. D — 读模型投影化、会话保留与流续传

### 5.1 usage_rollups 与 tool 维度【已定】

新增两张投影，均由会话条目写入路径同事务维护（唯一写者纪律同 projector、不同流——usage 量级是每条目一个增量，走领域事件流是错误载体）：

- `usage_rollups`：session 维度（usage 六列 + cost + turns + **toolCalls**）与 session × 日维度两档；
- `usage_tool_rollups`：session × toolName 维度（calls）。

EventStats 的 per-agent `toolCalls`（`stats.ts:62/348`）与逐工具分解 `toolUsage`（`stats.ts:548-561`）读 tool rollup 经 agents 关联——「wire 形状不变」的前提是 rollup 覆盖 tool 两个维度（评审修正：单一六列 rollup 服务不了 EventStats）。

写路径两条前置修正（评审发现）：(a) 今天 `persistEntry` 的条目 INSERT 与 activeLeaf UPDATE 是两条独立 autocommit 语句（`pi-session-adapter.ts:258-292`）——rollup 增量要成立，先给条目写入补显式 `db.transaction`（条目 + 叶指针 + rollup 三写合一，顺带修复崩溃一致性）；(b) **回溯尾删必须扣减**：flat backtrack 物理删除条目行（`agent-session-ops.ts:259-266`），只增不减的 rollup 会永久虚高——回溯在同一事务内删后整会话重算（回溯低频、会话行数有界，重算比读尾段扣减更不易错【建议】）。删除整个 agent 时 sessions 级联，rollup 行随 FK 级联，无需扣减。

读面归一的完整清单：`session-queries.sumUsageTotals`、`buildEventStats`、**调度者 digest 的逐题 token**（`scheduler-admin.ts:357-371`，归档后不回读原始行；引擎指纹本就排除 token，stall 检测不受影响）与 `listAgentSessions` 的 messageCount（rollup 记 entryCount 列）全部改读投影；event-pipeline 的进程内实时采样保留。三份 usage 聚合副本归一为「一套 rollup + 各处只读」。

### 5.2 stats 重写【已定】

`buildEventStats` 重写为读 `usage_rollups` + `agents`/`challenge_flags`/`challenge_events`（小表投影），消灭循环内 `find`/`filter`（换 Map）与对 `session_entries` 的全表扫描。**wire 形状（EventStats）不变**，web 统计页零改动。`catalog.getEvent` 增加单赛事直读路径，不再 `listEvents[0]`。

### 5.3 SSE 续传与 web 重建层退役【已定机制，游标编码【建议】】

现状的不变量缺口：快照与活跃事件无序竞态 → 客户端用 epoch/幽灵守卫补救。目标不变量：**持久面按序可重放，合并全序化**。

- **频道面**：SSE 事件带 `id:`（= `channel_messages.id`），EventSource 原生重连携带 Last-Event-ID，服务端从账本重放缺口（账本本来就是持久账）。
- **会话条目面**：committed 事件携带 `(sessionId, seq)`（wire 加法演进——今天 `message.committed` 只带 `item.seq`，`live-event.ts:112-116`）；客户端按 **sessionId**（非 agentId——seq 是会话内序，多会话 agent 必须分键，`UNIQUE(session_id, seq)`）维护 lastSeq，重连后先 `listMessages(agentId, {after: lastSeq})` 补洞再继续活跃流——`after` 参数已存在（`service.listMessages`），无需新端点。seq 全序使活跃流与快照的合并变成「丢弃 seq ≤ lastSeq」，`conversation-store` 的**幽灵守卫（首快照前的 commit）与 SSE 竞态半边的 epoch 机器删除**；**请求代际守卫保留**【已定，评审修正】：session 切换 / 回溯是服务端截断，在途 `listMessages` 响应晚于 reset 到达仍会把已删行合并回来——这个请求/响应竞态与 SSE 无关，epoch 的请求代际职能保留（per-agent 载入串行化是替代项【建议】不采，改动更大）。retain 内存上限保留——它管内存，不管正确性。
- **易失面**（工具增量 / context / activity）：维持 seed-before-subscribe 快照语义不变——这些状态只有「现在」有意义，重放无意义（control-plane §2.7 的判断维持）。

### 5.4 会话归档保留【已定机制，阈值【建议】】

- **归档，不删除**：终态 agent 的会话条目按策略移出 `session_entries`，压成 `data/archive/sessions/<sessionId>.jsonl.gz`（zlib 标准库，零新依赖）；`usage_rollups` 已材料化，统计不受归档影响。
- **透明解档读是正确性要求而非体验优化**：dm urgent 冷唤醒可以复活终态 agent（会话从 store 重载）——会话装载接口（`load(sessionId, afterSeq)`）在 DB 行缺失段自动并档，冷恢复与时间线回放对归档无感。删除 agent 时级联删归档文件。
- 策略：单一 settings 键 `data.sessionRetentionDays`（【建议】默认 30；避免第二个可配置项，无按赛事/按 role 的粒度——有实证需要再加）。

## 6. 明确暂缓

- **E · 执行隔离**（控制面进程 + 可抛弃 agent worker，L2 经本地 socket 说动词协议）：故障域隔离与 loop 独立部署的收益真实，但当前单机使命下非迫切；其前置（A 的内核边界）恰是本轮交付，届时 E 是在边界上换传输，不是重新设计。
- **外围收敛**（P5 全项）：adapter 公共件上提、配置归一 SQLite、apiKey 出 UI、relay 归一、bootstrap 契约数据化（适配 = profile 文件而非代码）、unattended 收敛为显式 profile 对象。
- **P6 单进程**：随 E 一并暂缓。

## 7. 实施顺序

依赖关系：A 的内核边界是 B 的注入点、C/D 的归属地；B 与 C 都重塑 engine（相邻落地）；D 独立但借用 B 建立的「控制面投影表」手法。串行四批，每批 `bun run check` + `bun run test`（动 SDK 面的批次加 `test:sdk`）全绿再进：

1. **A 分层装配**（行为不变重排，无 schema 变化）：抽内核（runtimes 注册表 + factory + settle + 状态核）→ fence 出 factory 入 L3 spawn-service → service.ts 解散为薄组合面 → ports.ts 删除 → lint 边界扩展。现有 service 级测试全程不动地跑绿（它们是行为锚）。
2. **B 计划原生工具化**（基线 v27：`plan_refs`）：TypeBox 计划 schema 上移 shared → 内核为 orchestrator 注入 submit_plan 工具（extraTools 通路）→ applier 登记接线（回合代际绑定）+ 幂等改读投影 → engine 关联切换 → SDK 砍面 + contract 更新 → 语料重写（本批最长杆，门禁含 `test:sdk`）。
3. **C 决策点状态事件化**（基线 v28：`decision_state` + decision_point 事件族扩展）：触发/打开/重申/flushed 事实化 → 投影维护 → 引擎水合 + boot.resync 收窄（fake clock 全族回归）。
4. **D 读模型与保留**（基线 v29：`usage_rollups` + `usage_tool_rollups`）：条目写入补显式事务 + rollup/回溯扣减重算 → stats/catalog 重写 → SSE id + Last-Event-ID + web 补洞重连（committed 事件加 sessionId；请求代际守卫保留）→ conversation-store 拆除无序竞态半边 → 归档 + 透明解档。

每批一个基线（v27–v29），遵守 docs/migrations.md：`rm -rf drizzle` 重生成、人工审查无 DROP/RENAME/ALTER、同步 bump `SCHEMA_VERSION`。

## 8. 代价声明

- **A**：纯机械重排里的最大批次；风险在接线语义漂移，缓解 = 行为锚测试不动 + lint 方向断言。`makeAgentService` 拆为内核 fake 与 L3 harness 是一次性成本，此后内核/控制面可各自单测（channels.test.ts 的 1,778 行有望按面拆薄）。
- **B**：调度者语料重写是最重工程量（control-plane §3.10 同判）；模型不调工具的风险由违约阶梯兜底（可观测、有界、可恢复，与今天的失败模式同类）；SDK 面收窄。
- **C**：触发级写放大（§4.4，量级无压力）；`decision_state` 是新的投影维护面；boot 语义变化需要专测（安静赛事零唤醒、running 打断恢复、unattended 续排水不回归）。
- **D**：条目写入路径多一个同事务增量写（rollup，前置是显式事务补齐）；stats 重写；web 拆的是全仓最精巧客户端逻辑的**无序竞态半边**（请求代际守卫保留，store 不是回到素朴形态），风险集中在重连续传路径（fake EventSource 序列测试兜底）；归档使会话装载多一层并档读。

## 9. 保留清单（重设计时不动的）

`domain_events` + 同事务投影；fence 在启动侧强制、队列吸收竞态（drainer 的 `planDrainStep` 纯函数不动）；`progressOf` 唯一定义；`effects.ts`/`clock.ts` 时间层与 fake clock；每 agent 一次性沙箱 + 短时铸造凭据；频道账本 + 派生键（delivery 引擎的 solver 面语义不动）；计划词表（无 DAG、noOp 一等、ref 幂等）；基线迁移制；决策点作为调度者唯一唤醒源；两层授权（Principal verdict + 数据层断言）；`run/host/*` 内层边界。以上是这套架构的资产；本轮全部痛点都在这些正确决策的缝隙里，不在决策本身。

## 10. 评审记录（2026-09-15，子代理批判性评审）

评审对本文全部 `文件:行号` 实证做了逐条核对（全部准确），并对照代码审查了 A–D 的可行性。结论：**无结构性缺陷，修订后可实施**。以下发现已合入正文（标注「评审修正/发现」处）：

| # | 严重度 | 发现与处置 |
|---|---|---|
| 1 | MAJOR | agent-status 不是干净内核件（通知/queue 释放/引擎喂食越层）→ §2.2 拆分：内核半留 L2，副作用面归 L3 生命周期反应器，回调次序契约固化 |
| 2 | MAJOR | fence 搬家留下 spawn 前奏与 `agent.spawned` 投影写的归属真空 → §2.1 改为 admission 临界区钩子（原子序列留内核，策略经组合根绑定），锁序不变式随契约重述 |
| 3 | MAJOR | B 的 notify 语义未钉死（propose 时消费会改变 error 回合行为、残留登记可能串扰）→ §3.2 钉死「登记不消费」：干净 settle + awaiting + 回合代际一致才消费 |
| 4 | MAJOR | rollup 无删除路径：backtrack 物理尾删会永久虚高 → §5.1 补删后同事务重算 |
| 5 | MAJOR | 单一六列 rollup 服务不了 EventStats（缺 toolCalls/toolUsage）→ §5.1 扩为两张投影 |
| 6 | MAJOR | epoch 整体删除是过度声称（请求/响应竞态与 SSE 无关）→ §5.3 收窄为只拆无序竞态半边，请求代际守卫保留 |
| 7 | MINOR | lastSeq 须按 sessionId 键控（多会话 agent）；(sessionId,seq) 是 wire 加法变更 → §5.3 修正并明示 |
| 8 | MINOR | 归档波及未列读者（listAgentSessions messageCount、调度者 digest 逐题 token）→ §5.1 补全读面清单 |
| 9 | MINOR | persistEntry 今天无显式事务（两条 autocommit）→ §5.1 前置修正：先补 `db.transaction` |
| 10 | MINOR | 内核动词清单遗漏（send.assertLive、workspaceKeyOf、ensureWorkspaceRuntimeFresh、forgetWorkspace）→ §2.2 补全 |
| 11 | MINOR | 「queue.launch = 内核 prepare」不成立（launch 含 fence + prime send + deliver）→ §2.1 改为 L3 spawn-service 入口 |
| 12 | MINOR | C 漏了第二条 pending 丢弃路径（无调度者行）；running 判定需命名锚点 → §4.1 flushed 覆盖两路径；§4.3 以 `agent.recovered(from:"running")` 为锚 |
| 13 | NIT | 计划 TypeBox schema 实际住在 routes.ts 而非 shared → §3.1 加「先上移」前置；注入通路（extraTools）与 HTTP 退役无回归已实证 |
| 14 | NIT | 薄组合面须承诺纯接线转发 → §2.2 明示 |
| 15 | NIT | 写放大与重入安全性核实通过（触发频率 = 回合量级；trigger 调用点均在事务外）；批序成立，B 语料是最长杆 |

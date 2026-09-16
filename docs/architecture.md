# AegisX 架构概览

活文档：描述当前（schema v29）的实际架构，供定位代码时使用。历史设计与演进过程见 [archive/](archive/)，数据库迁移工作流见 [migrations.md](migrations.md)，控制平面重设计（领域事件 / 计划 / 决策点）的取舍记录见 [control-plane-design-2026-09-13.md](control-plane-design-2026-09-13.md)；沙箱生命周期对齐与自有会话模型的设计见 [sandbox-session-design-2026-09-13.md](sandbox-session-design-2026-09-13.md)；分层装配 / 计划工具化 / 决策状态事件化 / 读模型投影化的本轮重设计见 [architecture-redesign-2026-09-15.md](architecture-redesign-2026-09-15.md)（已实施）。

## 总览

Bun monorepo，单一 lockfile，workspace 包互相以 `@aegisx/*` 引用：

| 包 | 职责 |
|---|---|
| `apps/server` | Hono HTTP API + agent 宿主进程（全部业务逻辑所在） |
| `apps/web` | React + Vite 前端，dev 时 `/api` 代理到 `127.0.0.1:3000` |
| `apps/shared` | 前后端 wire 类型的 canonical 来源（无 runtime 代码路径） |
| `apps/sdk/python` | 容器内 Python SDK，构建时 COPY 进镜像 `/opt/aegisx-sdk` |
| `containers/solver` | Kali 解题镜像，minimal / essential / full 三档共用一个 Dockerfile |
| `containers/app-build` | server + web 编译为单可执行文件的共享构建段镜像（`bun run compile`） |
| `containers/allinone` | 单镜像整机（server + web + 解题工具链，local 执行后端） |
| `containers/appliance` | 竞赛 all-in-one 镜像家族（tsecbench / xihulunjian），一个 Dockerfile 多 `--target` 阶梯 |

进程模型：**agent loop 在宿主 server 进程内**运行，基于 `@earendil-works/pi-coding-agent`（版本由根 `package.json` 的 `catalog` 统一声明、各 workspace 以 `catalog:` 引用，`overrides` 另行钉住传递依赖）。bash 与 CTF 工具链不在进程内执行：每个 agent 一个一次性 Kali 容器（主进程 `sleep infinity`，纯工具箱；命名 `aegisx-agent-<id8>`，prepare 时创建、settle 时销毁；调度者为 `aegisx-orch-<eventId8>`，机制相同），命令经 dockerode `exec` 送入；文件工具（read/edit/write/grep/find/ls）同样落到该容器，工作区双向 bind mount。同题 N 个 agent 共享的只有卷：workspace bind（题级）+ 命名缓存卷 `aegisx-ch-cache-<challengeId>`（挂 `/var/cache/apt/archives` 与 `/opt/aegisx-cache`，apt/pip/go 缓存跨容器复用，随题删除）。网络边界：solver 容器在默认 bridge 上持有 `NET_RAW`，出站不受限，宿主局域网亦可达（也可经 `container.networkMode` 共享 VPN 容器的网络命名空间）；系统强制的隔离是 solver↔宿主数据与 solver↔其他题目，不含 solver↔局域网，有需要时通过 `container.networkMode` 收紧。

数据全部落在 `data/`（可用 `AEGISX_DATA_DIR` 改址）：`aegisx.sqlite`（库）、`attachments/`（附件，按赛事/题目分目录）、`archive/sessions/`（过期会话的归档文件）、`events/<eventId>/challenges/<challengeId>/workspace`（求解者工作区，内含 `agents/<id8>` 与 `shared/`）、`events/<eventId>/orchestrator`（调度者工作区）。

**单镜像整机**（`containers/allinone`，详见其 README）：`AEGISX_EXEC_BACKEND=local` 时执行后端换成 `run/container/local-manager.ts` —— solver bash 直接以本进程命名空间内的 `bash -c` 子进程运行，bind 语义用「路径映射（cwd）+ 容器路径符号链接」复刻，不再有独立工具箱容器，题间隔离随之消失（单机自用取舍）。`AEGISX_BOOTSTRAP=1` 时 `src/bootstrap.ts` 在启动后按环境变量幂等地完成 provider / 赛事 / 平台绑定 / 拉题 / 调度者启动；镜像内的编译单二进制自带内嵌 SPA（`AEGISX_WEB_DIR` 仅在指向外部 dist 时使用）。

## 数据模型（`apps/server/src/db/schema.ts`）

Event → Challenge → Workspace → Agent 四层。Workspace 是派生路径，无表行；沙箱容器是 per-agent 的一次性资源（prepare 创建、settle 销毁），题级共享的只有 workspace bind 与缓存卷。schema 演进是基线制（`drizzle/` 只有一份从空库建出当前 schema 的基线迁移），开机按 `user_version` 三态协商：fresh 建库、current 直开、其余版本一律拒绝——旧库无升级路径，详见 [migrations.md](migrations.md)。

- **`domain_events`** — 控制平面唯一事实源（append-only，全局单调 id，`causation_id` 串因果链）：agent 生命周期、队列秩序、flag 判定、fence 拒绝、计划与决策点。写路径单一：`run/domain-events/store.ts` 的 `emitDomainEvent` 在**同一个 SQLite 事务**里 append 事件 + 应用投影；`run/domain-events/projector.ts` 是投影表（agents / spawn_queue / queue_state / challenge_flags / challenge_remote / challenges 控制字段 / `plan_refs` / `decision_state`）的**唯一写者**。事件类型在 `run/domain-events/registry.ts` 单点声明（载荷校验 + decision-log 类型集）。`GET /api/events/:eventId/decisions` 是决策日志读面（web 的「决策日志」页签渲染它）。token 等凭据永不入事件载荷。
- **`agents`** — 执行单元，一次解题尝试一行；`domain_events` 的投影。`challengeId` 为 null 即该赛事的调度者（orchestrator；每赛事至多一个，唯一索引强制）。model / systemPrompt / tools 在 spawn 时快照（`agent.spawned` 事件），冷恢复原样复用。**无凭据列**：agent 的 bearer 是每次 bash exec 时用 per-boot HMAC secret 短时铸造的（`infrastructure/agent-credentials.ts`，1h TTL），中间件验签 + 查行还原主体；事件流与投影都不涉及凭据。
- **`sessions` + `session_entries`** — 自有会话存储，唯一的会话存储后端（`run/host/pi-session-adapter.ts` 把 pi 的内存会话树写入这两张表）：可查询字段（seq / type / role / tool_name / usage 六列 / parent / 时间戳）是一等列，pi 特有形状以 canonical envelope 存于 `body`（`run/host/session-entry-codec.ts` 声明的 kind 注册表），resume 经批量装载反解、不重演 append；`sessions.active_leaf_id` 持久化分支位置。`seq` 为会话内单调序。`session_entries` 曾是全库最大的表（每条消息一行）——现在没有读者直接扫它：用量统计走 **`usage_rollups` / `usage_tool_rollups` 投影**（entry 写入同事务增量维护，stats / 调度者 digest / 用量面 / 会话列表 messageCount 全部读投影），原始行按保留策略归档：保留清扫（`run/host/session-archive.ts`，日频）把**终态** agent 会话中最新条目早于 `data.sessionRetentionDays`（默认 30 天）的移出库、压成 `data/archive/sessions/<sessionId>.jsonl.gz`（gzip jsonl，按 seq 逐行；重归档按 seq 并集合并，冷唤醒续写的前缀不丢）。归档对读面透明：`loadMergedEntryRows` 把「归档前缀 + 库内存活行」按 seq 并档，时间线分页 / adapter resume / 回溯目标查找 / rollup 重算都读并档结果——条目离开了库，历史并没有消失；只有显式删除 agent / session（级联 + 归档文件清扫）才真正清除。回溯仍是物理尾删（仅库行；归档文件由下次归档按并集吸收）。
- **`usage_rollups` / `usage_tool_rollups`** — 会话维度与会话×工具维度的用量投影（D 批）：由 adapter 的条目写事务增量推进（唯一写者；回溯同事务删后从并档读整体重算），行随 session 级联。全库唯一 usage 聚合副本，stats / digest / 用量 / 会话列表只读。
- **`spawn_queue`** — 调度计划表（`queue.*` 事件的投影）。一项 = 「在题 X 上派一个 agent」，enqueue 恒为 append（同题多项是合法的并行计划）。生命周期 pending → running（回填 agentId）→ done / failed；`queue_state` 按赛事暂停排水。
- **`channel_messages` + `channel_reads`** — 全部 agent 间通信的唯一账本。频道是派生键（见下），无频道表；`channel_reads` 记 (channelKey, readerKey) → lastReadMsgId，是投递去重锚点。
- **`challenge_flags`** — 一题多解；`agentId` 无 FK（解题史须活得比 agent 行久），`source` 区分 agent 提交 / 手工录入。
- **进度状态机** — `@aegisx/shared/progress.ts` 的 `progressOf` 是"这题解到什么程度"的**唯一定义**：输入是事实（已接受 flag 数、`challenges.required_flags`、平台终态判定、`manual_solve_state`、分值），输出 `{ state: unsolved|partial|solved, source, confirmed, required, earned, perFlag }`。**单 flag 题是退化子集**：`required === 1` 时 `partial` 不可达。服务端所有消费方（`run/fence.ts` 封禁与槽位、`run/flag-hooks.ts` 解出清理、`run/scheduler-admin.ts` digest、`events/stats.ts`、`events/catalog.ts` 的 wire 投影、`platforms/challenge-state.ts` 的 SQL 镜像）都读它，web 与 SDK 读下发结果——不存在第二份"已解出"推导。`challenges.solved_at` 记首次进入 `solved` 的时刻，解出清理以它为幂等锚点（重同步揭示出更多 flag 导致 solved → partial → solved 回环时不会二次清理）。
- **`scheduler_config`** — 每赛事调度策略（模型、自然语言指令、target 槽位、flag 处置开关等）。
- 其余：`events` / `event_platforms`（平台绑定）、`challenges` / `challenge_remote`（远程镜像状态）、`attachments`、`prompt_templates`、`platform_request_log`（失败的平台请求审计：请求头脱敏、保留 7 天）。

## Agent 生命周期

状态机（`shared/domain.ts` 词表）：`running` / `idle` 为存活（`LIVE_AGENT_STATUSES`），终态 `completed` / `aborted` / `failed`。idle = 回合间保温（容器、槽位、会话都在），直到终态才释放。

出生两条路：`spawn_queue` 排水（默认；调度者的计划与用户入队都走它）或用户面直接派发（`POST /challenges/:id/agents` 逃生舱，绕过队列，fence 照拦——SDK 侧已无此动词，调度者启动 = 计划里的 close + enqueue）。launch 入口是 `run/spawn-service.ts`（L3 spawn 面：admission 语义 + prime send 与投递），组装在 `run/kernel/agent-factory.ts`：创建该 agent 的一次性沙箱容器（`ensureContainerFor`，per-agent in-flight 单飞；仍在运行则复用），再建 host session。

运行期守护：

- 硬截止是 agent runtime（`run/kernel/agent-runtime.ts`）上的定时器——deadline 到点中止回合、宽限后强制处置。per-agent 停滞看门狗已收缩进决策点引擎（`run/decision-points/engine.ts`，控制面 §3.7 r1）：只有决策点产出 noOp/无决策、且局面（状态指纹）持续 ≥ stallMs 无变化时，才升级一次告警——空闲 agent 本身不再触发。
- 赛事级生命体征看门狗 `run/fleet-watchdog.ts`（每 2 分钟）：某赛事未暂停、`spawn_queue` 有 pending 项、无任何存活 solver、且排水窗口内无进展（无 launch / 队列变化）时，升级告警（`watchdog.escalated` 事实 + urgent orch 通知）并开一个 `fleet.stalled` 决策点；每 episode 至多一次，有存活 solver 或 pending 清零后重置。触发条件刻意收窄，已完工的空闲赛事不会误报。
- 冷启动恢复 `recoverOnBoot`（`app.ts`）— 存活 agent 标记为 idle（`agent.recovered` 事实），不自动续跑；**开机孤儿清扫**按 `aegisx-agent-` / `aegisx-orch-` 前缀枚举守护进程下的全部遗留沙箱并确定性清除（卷保留——缓存与工作区皆可重建；会话在 DB）；随后决策点引擎**按需**发 `boot.resync`（C 批收窄）：只覆盖水合发现未决业务的赛事（孤儿 open point 以 `closed(outcome=error, reason=boot)` 收尾 / 非空 pending），以及重启前调度者正处于 running 的赛事（回合被打断，内核翻转时把这些赛事 id 回报给引擎）——安静 idle 赛事的重启成本为零条 LLM token。调度者不存在或已终态时跳过（由 bootstrap / 用户启动）。决策引擎的每赛事状态（pending 触发 / open point / violations / stall episode / quietFingerprint）由 `decision_state` 投影表持久化（projector 同事务维护，引擎构造时水合回内存；errorRetries 仍只在内存——可失的退避预算）。**无人值守模式**（`AEGISX_UNATTENDED=1`，tsecbench 镜像内置）下另有两条差异：开机**不**把有可见队列项的赛事置为 `paused`（没有人工 resume 的入口，被迫暂停等于让队列停摆整场），改为续排水，且已存在的 `paused` 意图原样保留；`fleet-watchdog` 同步收紧为"只有 running 的 solver 才算进展"，这样重启后被 parking 成 idle 的 agent 不会被"有存活 solver"的旧条件掩盖（冷恢复 agent 没有 runtime）。

运行期的全部延迟动作（投递 flush tick、drainer 去抖与容量重试、决策点合并、计划应用链、per-agent deadline/grace、赛事级看门狗）统一经时间层 `run/clock.ts`（`Clock` + `TimerHub`）与语义层 `run/effects.ts`（`createEffects`：debounce 后沿合并 / per-key 串行单飞 chain / 有界自唤醒 retry / 一次性 after / 周期 every——五个手写调度语义的收敛点）创建；子系统 close 即 dispose；测试注入 fake clock 确定性推进时间。

**所有权根**：一个存活 agent 的全部进程内资源（挂载的 host session、turn generation、finish_run 簿记、deadline/grace 定时器）都挂在 `run/kernel/agent-runtime.ts` 的 `AgentRuntime` 上；**内核**持有唯一的按 agentId 索引的注册表 `Map<agentId, AgentRuntime>`，首次触达（session 挂载 / 布防 deadline / finish 簿记 / send）时创建。冷恢复语义不变：idle/terminal agent 无 runtime（DB 行即状态），dm 冷唤醒 → send → resume → prepareAgent 重建 runtime。

**终态单一路径**：所有终态（timeout force-abort、finish_run 自终止、close、finish、delete、superseded launch，以及 spawn 过程中失败）收敛到 `runtime.settle`：有界 abort（仅用户驱动的 close）→ dispose session → 清定时器与簿记 → 出注册表 → terminalize（含 LiveBus forget）→ 销毁沙箱（一次 `remove(force)`，fire-and-forget；无宽限定时器——pid1 是 `sleep infinity`，工作区是 bind mount，无物可冲刷）→ delete-only 收尾；无 runtime 的 agent（从未 prepare，含 build 失败的 spawn）直接落终态并同样销毁沙箱。关停时内核对每个 runtime `dispose()`（仅释放进程内资源，不动 DB 状态、不杀容器——遗留沙箱由下次开机的孤儿清扫接管）即为全部善后——不存在第二份需要记得清的注册表。

LiveBus 的 per-agent 快照（context/queue/activity/running tools）由 bus 自持有；`run/host/live.ts` 属 host 内层，不认识 runtime 与终态。淘汰只由上述唯一终态路径经 status core 的 terminalize 通知（`bus.forget`）触发——settle 先同步 detach session pipeline（此后不再有新事件），再 forget，故不存在终态后写入；除 `close()` 的整体清空外无第二条淘汰路径。

## run/ 核心模块

`apps/server/src/run/` 是运行时心脏，`service.ts`（`createAgentService`）为组装根：

| 模块 | 职责 |
|---|---|
| `service.ts` | 薄组合面（A 批）：保留 `AgentService` 公共形状，逐成员转发到内核 / L3 模块并完成 principal 作用域断言——只做接线与转发，不持有 agent 状态；per-agent 注册表 `Map<agentId, AgentRuntime>` 在 `kernel/` |
| `kernel/` | L2 agent 内核（A 批）：`index.ts`（runtimes 注册表 + 动词面 + 锁）、`agent-factory.ts`（spawn 组装，fence 经 admission 临界区钩子进入）、`agent-runtime.ts`（单 agent 所有权根与唯一终态路径）、`agent-status.ts`（状态事实 + LiveBus 半区）、`agent-session-ops.ts`（多会话 / 回溯）、`prompt.ts` / `tools.ts`；L3 的反应面（通知 / queue 释放 / 引擎喂食）在 `lifecycle-reactor.ts`，经 `registerLifecycle` 注册的出站回调进入内核；spawn 面入口是 `spawn-service.ts`（admission 语义 + launch 序列） |
| `agent-runtime.ts` | 单个存活 agent 的所有权根：挂载的 host session、turn generation（send → drive → 代际校验的 settle）、finish_run 簿记、deadline/grace 定时器、`settle()`（唯一终态路径）与 `dispose()` |
| `locks.ts` | `chainLock`：按 key 串接的 promise 锁原语（withLock / fence / start 锁共用） |
| `clock.ts` | 统一时间层：`Clock`（时间源 + 定时器工厂，默认 `systemClock`，测试注入 fake clock）+ `TimerHub`（定时器注册表，`clear` / `disposeAll`）；运行期定时器一律经它 |
| `effects.ts` | 延迟动作语义层：`debounce`（后沿合并）/ `chain`（per-key 串行单飞）/ `retry`（有界自唤醒）/ `after` / `every`——drainer、投递链、flush tick、看门狗、容器 sweep、决策点合并与计划应用链共用 |
| `domain-events/` | 领域事件层（registry / store / projector / routes）：控制平面事实的 append-only 流 + 同事务投影 + 决策日志 API（见数据模型一节） |
| `plan/` | 调度者计划：`applier.ts` 的 `submitPlan`——整包同步校验（错误同回合喂回）→ `plan.proposed` → 快动作 inline、慢动作（stop/close/finish/冷唤醒 message）进 per-event 单飞链并逐条重校验 → `plan.result`；(schedulerAgentId, ref) 幂等去重 |
| `decision-points/engine.ts` | 决策点引擎：调度者唤醒的唯一来源——触发（settled / flag / queue.changed / launch.failed / timedOut / user.directive / solver.asked / periodic 心跳 / boot.resync）合并成决策点，驱动调度者回合并以 submit_plan 登记关联；违约阶梯（一次重申 → violation 留档 → 连续三次升级）；scheduler paused / queue paused / unattended 闸门收在这里；noOp 后局面（指纹）持续 ≥ stallMs 不变 → `watchdog.escalated` 升级。每赛事状态事实化（C 批）：triggered / flushed / reprompted / stall_cleared 事实 + `decision_state` 投影，构造时水合、重启不丢；运行时语义（合并 / 紧急冲刷 / 阶梯 / stall）不变 |
| `kernel/agent-factory.ts` | 一次 spawn 的完整组装（容器 → host session → 工具注入）；prepare 成功即把 session 挂到该 agent 的 runtime 上 |
| `queue.ts` | spawn 队列存储与状态：条目 CRUD、pending→running→终态流转、每赛事暂停（`queue_state`）——全部写经领域事件投影；队列低水位等边沿已归决策点引擎触发器 |
| `drainer.ts` | 排水循环（200ms 去抖单飞，经 effects 原语）：`planDrainStep` 把启动围栏判定翻译为 launch/skip/cancel/stop；`global_capacity` 停轮后按有界间隔自唤醒重试；launch 失败 → item `failed` + 紧急触发决策点；围栏拒绝逐条落 `fence.blocked` 事实 |
| `fleet-watchdog.ts` | 赛事级生命体征看门狗：pending 无 solver 且排水停滞 → `watchdog.escalated` + urgent orch 告警 + `fleet.stalled` 决策点（去重、状态恢复重置；引擎落地后不再承担唤醒） |
| `fence.ts` | 启动围栏：全局存活 solver 上限（settings `scheduler.maxConcurrentAgents`）、每赛事 target 槽位（`maxConcurrentTargets`）、已解题封禁（`blockSpawnOnSolved`） |
| `channels-*.ts` 五模块 | 协作层（见下），`channels.ts` 为组装壳 |
| `orch-notices.ts` | 系统→调度者/团队通知的类型化事件协议：事件（`flagAccepted` first/extra/partial、`flagPartialProgress`、`solveCleanup`、`challengeHalt`、`launchFailed`、`queueStateChanged`、`schedulerViolation`、`schedulerStalled`）→ 投递契约（频道 / meta / 紧急度）→ 模板渲染；文本默认值在 `orchestration/prompt-defaults.ts`（builtin 行，可编辑） |
| `container/container-manager.ts` | dockerode 封装：生命周期 + hijacked exec + putArchive 写入 |
| `workspace/` | 文件工具实现与 docker exec 后端 |
| `bash-tool.ts` | 容器内 bash 工具 |
| `model-resolver.ts` / `model-runtime.ts` | canonical 模型引用 `aegisx-<providerId>/<modelId>:<effort>` 的解析与运行时模型表（新 provider 惰性刷新） |
| `sse.ts` | 唯一的实时流出口：`GET /api/stream` 一条 SSE 连接承载全部 agent 事件与频道消息（LiveBus → SSE，走 bus 全局订阅；载荷自带 `agentId` / `message.channelKey`，由客户端分发）。保留慢客户端背压合并（每 streaming 身份只留最高 revision）与 seed-before-subscribe；频道帧携带账本行 `id:`，重连的 EventSource 以 Last-Event-ID 换账本重放（D 批）——非频道帧刻意无 `id:`，不污染重放游标 |
| `principal-scope.ts` | 数据层作用域断言：`assertMayTouchEvent` / `assertMayTouchChallenge` / `assertMayTouchAgent`（授权的数据层，见下） |
| `routes.ts` / `scheduler-admin.ts` / `queries.ts` / `public.ts` | 用户面路由、调度管理面、查询与对外形状 |

**授权分两层**（对 P0-1/2/8「每处手写 scope 条件，漏写即越权」的结构性收敛）：中间件 `infrastructure/agent-auth.ts` 把每个请求**解析一次**为 `Principal`——`{kind:"user"}`（无 token 的本机用户面）、`{kind:"agent", agentId, eventId, challengeId, role}`（token 还原）、`{kind:"system"}`（仅进程内调用方，HTTP 永远产生不了）——它的 `verdict` 决定「这类主体能否打这个端点」（agent API 面，403 by omission）；`run/principal-scope.ts` 的断言助手决定「这个主体能否碰这条数据」。凡跨主体可达的写操作/查询（channels 发帖、queue 操作、agents 管理面、spawn、fleet 等），service 方法签名收 principal 并在内部过同一断言，路由层只做参数解析与转发、不拼任何 scope 条件；channels 发帖另有作者↔principal 一致性断言（`resolveAuthor`），token 冒充 user/system/他人发帖从任何分支进入都会被拒。纯用户面（settings/providers/平台绑定等）verdict 已挡住 agent token，无需 principal。

宿主侧支撑在 `apps/server/src/run/host/`（host 子层，原 `src/agents/`）：`host-session.ts`（pi loop 封装）、`event-pipeline.ts`（事件 → 会话树 + LiveBus + 计时元数据）、`pi-session-adapter.ts`（自有会话存储 ↔ pi SessionManager 适配，内部含 `session-entry-codec.ts`；条目写事务内同事务推进用量投影）、`session-archive.ts`（保留清扫 + 归档文件 + 透明并档读）、`usage-rollups.ts`（用量投影的唯一写者）、`session-queries.ts` / `entry-usage.ts`（消息读面与用量折算）、`live.ts`（LiveBus）、`model-switch.ts`（存活中换模型）。依赖方向由 lint 强制（`apps/server/.oxlintrc.json` 的 `no-restricted-imports` overrides）：host 是最内层，只能依赖叶子与更内层（`run/errors` / `run/bash-tool` / `run/model-runtime` / `run/container` / `run/workspace` / `db` / `lib`），不得反向 import 编排与路由模块；路由层与组合根——组合根（`app` / `bootstrap` / `index`）、用户面（`run/routes` / `run/scheduler-admin` / `run/sse` / `run/public`）、事件与平台面（`events` / `scheduler` / `platforms` / `settings` / `activity`）——不得深入 `run/host/*` 内部，只能经 service 或 `run/host/index.ts` 公共出口（例外：`run/service` / `run/kernel`（agent-factory / agent-session-ops）等构造 host 层的运行时内部消费者）。

## 协作层（channels）

频道键全部派生，无频道表：

- `team:<challengeId>` — 每题一个 `#team`，同题求解者 + 用户共享的题目公共历史。
- `dm:<agentId>` — 指向单个 agent 的私信（用户介入与调度者指派共用）。
- `orch:<eventId>` — 汇聚面：solver 的 `ask`、系统事件（flag 被接受、超时、停滞）。

写路径（`channels-post.ts`）：消息入账本，附件拷入该题工作区 `shared/` 树（路径存 `meta` JSON，容器内直读，无取回步骤）；每次入账落一条瘦事实 `channel.posted`（body 留在账本）。投递引擎（`channels-delivery.ts`）是 **solver 面推送**的唯一出口：按读游标取增量、按 agent 的投递面（本题 #team + 自身 dm）渲染成投递提示，全局 flush tick 批量冲刷。dm 支持 urgent 冷唤醒（终态 solver 也可被重新叫起）；team 只向存活 agent 投递，终态后仅存档。**调度者不经投递引擎唤醒**——决策点引擎是它唯一的唤醒来源（见「调度」），orch 频道退化为账本 + 系统通知面（SDK 读，不再推送给调度者）。

投递引擎的两条不变式：**每个 agent 一条串行链**（并发投递会各自读到同一段未读区间并重复投递；串行同时保证写入顺序）；**每条投递的首行是 `[当前时间]`**（唤醒自带时间锚点，读者不靠最新消息推断「现在」）。多个 steer 的合并发生在运行时而非此处：`agent-runtime.send` 检测到已有 pending steer 时把新文本折进同一条——pi 的每次 `steer()` 各算一条独立注入，不合并就会让一次批量指令变成 N 条消息。

实时扇出（`channels-context.ts` → LiveBus）：每条消息**只 emit 一次**，bus 键取频道自身 id（#team = challengeId，dm = agentId，orch = eventId）；LiveBus 只有全局订阅（`subscribeAll`）一个出口，web 端按载荷里的 `message.channelKey` 分发，因此不存在 per-channel 订阅方，也不需要有第二把事件级键。

**系统通知 = 类型化事件 + 模板**（`run/orch-notices.ts`）：系统侧的调用点（service 的 flag 处置/解出清理/手动停止、queue 的暂停恢复、决策点引擎的违约/停滞升级、看门狗）不再拼中文散文，只构造类型化事件并 `publish`；事件决定投递面（`team:<challengeId>` 或 `orch:<eventId>`）、`meta`（`eventType` / `noticeType` / 提交者 `agentId`）与紧急度，文本由模板渲染——默认值即 `NOTICE_TEMPLATE_DEFAULTS`，随 builtin 行落 `prompt_templates`（用户可编辑，下次通知生效）。事件载荷只带结构字段（如 `launchFailed` 携带 challengeName 与截断后的 error），措辞一律归模板。投递面、urgent 语义与 `meta.agentId`（跳过提交者自身通知）等契约留在 channels 层不变（调度者唤醒不走投递，见「调度」）。设置面：settings meta 暴露全部内置模板的默认 body（含通知模板，支持「恢复默认 / 修改标记」）与各类型的变量清单（含 `noticePromptVariables`），`POST /api/settings/prompts/preview` 对全部 `notice*` 键统一收 `kind: "notice"`，用一个与变量清单严格一致的示例上下文渲染（前端不镜像变量、不按事件分派）。

## 调度

**代码拥有控制平面，LLM 拥有判断。** 调度者是一个有记忆、有会话的 LLM agent，但它的管理产出只有一个写动词：**原生 `submit_plan` 工具调用**（B 批）——一份带 rationale 的类型化计划（enqueue / message / stop / close / finish / setDeadline / cancelItem / reorder / setQueuePaused / noOp，无 DAG 依赖语法），TypeBox schema 单点定义在 `run/plan/schema.ts`，HTTP 计划端点与工具共用同一份。工具按**角色**注入 orchestrator 会话（组装根把 L3 的 `run/plan/tool.ts` 绑进内核的 `orchestratorTools` 通道，spawn 与重开一致，不读 tools 快照）；handler 进程内直呼 `run/plan/applier.ts`：整包同步校验后落 `plan.proposed`，快动作当场应用（返回值带 `queueAfter` 队列视图，同回合可修正重交），慢动作（stop/close/finish/冷唤醒 message）进 per-event 单飞链、逐条在落地时刻重校验，结果经 `plan.result` 与下一决策点回报。确定性约束不依赖调度者自觉：`fence.ts`（全局 agent 上限、每赛事 target 槽位、已解题封禁）在 drainer launch 时逐项强制；每次拒绝落 `fence.blocked` 事实。槽位类顺序（腾位 → 补位）由队列保证而非计划：enqueue 不 fence，agent 终态触发排水，竞态被队列吸收。

**关联靠回合代际，幂等靠投影。** 工具 handler 在计划被接受时向引擎**登记** `(schedulerAgentId, planId, turnGeneration)`——登记不是消费：消费只发生在该调度者回合干净 settle、点仍 `awaiting`、且登记代际与 settle 回合代际一致时（error 回合逐字走重发路径，即使计划已应用）。经 HTTP 端点提交的计划不登记（用户/系统逃生舱语义不变）。幂等去重的 `(scheduler, ref)` 键材料化为 `plan_refs` 投影表（projector 从 `plan.proposed` / `plan.result` 同事务维护，`canonical` 存排序键 JSON），applier 的查重读投影而非扫事件流。

**唤醒 = 决策点，不是消息投递**（`run/decision-points/engine.ts`）：agent settled、flag 接受/部分、队列变化（含低水位）、launch 失败、超时、用户指令、solver 求援、周期心跳（带状态指纹跳过）、boot 重同步——非紧急触发合并成一个决策点（`decision_point.opened/closed` 事实化），紧急触发立即冲刷；引擎主动注入载荷（触发事实 + 快照 + `schedulerDigest` 舰队快照——「调度快照在决策时」）驱动调度者回合，回合以 `submit_plan` 工具调用收束（noOp 是显式决策）。违约是确定性阶梯：回合无计划 → 重申一次 → violation 留档 → 连续三次升级 `watchdog.escalated` + urgent 告警；provider 失败的回合不计违约、退避重发。闸门收在一处：queue paused / scheduler paused（W3）/ unattended。历史上为「尽力而为唤醒」而生的机制已随之退役：调度者 heartbeat、boot-reentry 模块、queue starved 边沿、inbox hold、per-agent 停滞定时器（noOp 后持续沉默的升级收进引擎）。

系统→调度者/团队的方向仍是类型化事件 + 可编辑模板（`run/orch-notices.ts`：flag 接受、部分解出、解出清理、手动停止、启动失败、队列暂停恢复、调度者违约/停滞），事件的结构字段决定 meta 与紧急度，散文只在模板里；调度者→系统的方向由计划类型化，两侧协议都不依赖隐式约定。

**调度快照必须同时给出成本与产出**（`run/scheduler-admin.ts` 的 `getDigestContext` → `schedulerDigest` 模板）。产出侧：每题 `earned`（已得分）、`flagProgress`（n/N）、`perFlag`、`sinceLastFlag`，事件级 `elapsed` 与 `sinceLastScore`，以及 `board`（未启动题数与未触达分值——没有 live agent 也没有排队项的题不会出现在逐题行里，不汇总就等于对调度者不可见）。多旗进度由本地已接受 flag 数与 `challenges.required_flags` 经 `progressOf` 推导（`earned = points × confirmed / required`）：平台按旗均分分值，逐旗分数组不在 agent 面 API 上。`required_flags` 的写者是平台同步（仅在平台**确实报告**了数值时写，缺字段不覆写）与操作员覆写；数值未知时进度封顶在 `partial`，绝不从计数自行判「已解」。`solvedLabel` 只在 `progressOf` 判为 `solved` 时才给「已解」——把「有 1 个 accepted flag」当已解会让 2/6 的链看起来完工。缺了分子，调度者的性价比判断无从执行，故这两侧字段是同一份契约。

**通用模板 vs 部署特调**：`prompt-defaults.ts` 里的内置模板只写与具体赛事无关的策略原则（含预算语义：`timeout_ms` 是兜底，分配靠 agent 上限与计划里的 close）；具体数值（各难度首轮预算、平台并发上限、flag 格式、离线约束）属于某个评测环境的经验参数，落在部署侧的 appliance 清单（`containers/*/preset.json`，`bootstrap.ts` 读取）。清单是结构化的：`brief` 按**读者分区**（`common` 两类 agent 都读、`solver` 只进解题 agent、`orchestrator` 只进调度者——上下文构造器按角色合并后经 `{{event.brief}}` 渲染），`flagFormats` 渲染进 mainSystem 的提交章节，`offline` 在**构建期**被 `gen-environment.py --manifest` 消费（离线声明替代联网安装 SOP），`settings`/`scheduler` 维持首启落库语义。模板语料在 `orchestration/prompt-templates.ts` 的 `PROMPT_TEMPLATES` 注册表单点声明（key / 上下文种类 / 默认值 / 变量面板 / 预览），seed 表、设置页变量面板与预览派发均由它派生；漂移测试对全部内置模板断言「默认值可渲染 + 引用的变量已声明」。

## 平台适配（`apps/server/src/platforms/`）

`core.ts` 定义统一接口，`adapters/` 内置五类：CTFd、A1CTF、DASCTF、Ret2Shell、TSecBench。能力面：题目同步（`sync.ts`）、远程 flag 判定（`flags.ts`）、靶机实例启动/续期（`targets.ts`）；远程状态镜像进 `challenge_remote` 表，失败请求落 `platform_request_log`（请求头脱敏，保留 7 天）。异步判定轮询（`flags.ts`）与靶机就绪轮询（`targets.ts`）的等待也走统一时间层 `run/clock.ts`——`createPlatformService` 接受可选 `clock`（默认 `systemClock`，组装点 `app.ts` 不传）并下传给两个模块，间隔/超时/重试次数语义不变，测试注入 `createFakeClock` 消除真实等待。flag 被平台接受的回调（`app.ts` 的 agentHooks）会刷新提交 agent 的视图、通知调度者，并按策略停掉同题其余存活 agent。

## LLM 接入

`apps/server/src/providers/`：provider 配置（openai-compatible / anthropic / 等）、模型发现与内置模型表。求解镜像是三档通用工具箱，与模型无关；模型按 agent 逐个指定。固定端点网关（追加路径即 404 的 LLM proxy）经 `bun run relay`（`apps/server/scripts/relay.ts`）脱路径代理后当作 openai-compatible 接入。

## Web 前端（`apps/web/src/`）

- `api/` — REST 客户端，类型直接取自 `@aegisx/shared`。
- `stream/` — SSE 消费：`live-connection.ts` 是**进程级唯一** EventSource（应用根部接线；按 `agentId` / `message.channelKey` 自行分发，断线由 EventSource 原生重连并把频道帧的 Last-Event-ID 换成账本重放，`onReconnect` / `onStatus` 供上层刷新与提示），`conversation-store.ts` 是按 agentId 键控的会话状态 + selector（stable/tail 记忆化 + rAF 批量通知；`(sessionId, seq)` 双键游标 + 全量快照整体替换使活跃流与快照的合并全序化；`retain()` 决定哪些 agent 的持久历史留在内存，其余只保留有界的实时状态；重连后经 `GET .../messages?after=<lastSeq>` 补洞，响应的 `sessionHeadSeq`（会话真头）低于游标即判定服务端截断、整页重拉），`parse-event.ts` 解析 LiveEvent。频道视图与对话视图共用这一条连接。
- `features/` — 页面域：events（赛事/题目/平台）、runs（agent 会话时间线与频道视图）、tasks（题中心任务视图 / 队列）、stats（统计）、activity（全局活动日志）、settings。
- `domain/` / `components/` — 前端本地领域与 coss UI 组件库（只读）。

## Python SDK（`apps/sdk/python/`）

构建时随镜像分发到 `/opt/aegisx-sdk`，提示词引导 agent 先 `cat /opt/aegisx-sdk/GUIDE.md`。接口面（B 批收敛后：**管理写是调度者的原生 `submit_plan` 工具调用，通信走自由文本，SDK 全是读**）：读（`snapshot` / `status` / `challenges.list/get` / `agents.list/get/read` / `queue.list/state`）+ 通信（`channels.post/read/list` / `ask` / `announce`）；`submit_plan` 与全部 plan 助手已从 SDK 删除，契约测试把「已删动词」列入负断言。鉴权链：agent token → `infrastructure/agent-auth.ts` 中间件解析出 `Principal` 并做端点级 verdict（solver 只有频道与自面；scheduler 有本赛事管理面 + 计划端点——后者保留为用户面逃生舱）→ service 层作用域断言二次限定数据边界（见「run/ 核心模块」的授权两层）。接口一致性由契约测试保障（`apps/server/scripts/sdk-contract.ts`，根脚本 `bun run test:sdk`）。

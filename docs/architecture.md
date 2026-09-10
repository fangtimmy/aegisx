# AegisX 架构概览

活文档：描述当前（schema v20）的实际架构，供定位代码时使用。历史设计与演进过程见 [archive/](archive/)，数据库迁移工作流见 [migrations.md](migrations.md)。

## 总览

Bun monorepo，单一 lockfile，workspace 包互相以 `@aegisx/*` 引用：

| 包 | 职责 |
|---|---|
| `apps/server` | Hono HTTP API + agent 宿主进程（全部业务逻辑所在） |
| `apps/web` | React + Vite 前端，dev 时 `/api` 代理到 `127.0.0.1:3000` |
| `apps/shared` | 前后端 wire 类型的 canonical 来源（无 runtime 代码路径） |
| `apps/sdk/python` | 容器内 Python SDK，构建时 COPY 进镜像 `/opt/aegisx-sdk` |
| `containers/solver` | Kali 解题镜像，minimal / essential / full 三档共用一个 Dockerfile |
| `containers/allinone` | 单镜像整机（server + web + 解题工具链，local 执行后端） |

进程模型：**agent loop 在宿主 server 进程内**运行，基于 `@earendil-works/pi-coding-agent`（版本由根 `package.json` 的 `catalog` 统一声明、各 workspace 以 `catalog:` 引用，`overrides` 另行钉住传递依赖）。bash 与 CTF 工具链不在进程内执行：每道题一个长寿 Kali 容器（主进程 `sleep infinity`，纯工具箱）承载执行，命令经 dockerode `exec` 送入；文件工具（read/edit/write/grep/find/ls）同样落到该容器，工作区双向 bind mount。网络边界：solver 容器在默认 bridge 上持有 `NET_RAW`，出站不受限，宿主局域网亦可达（也可经 `container.networkMode` 共享 VPN 容器的网络命名空间）；系统强制的隔离是 solver↔宿主数据与 solver↔其他题目，不含 solver↔局域网，有需要时通过 `container.networkMode` 收紧。

数据全部落在 `data/`（可用 `AEGISX_DATA_DIR` 改址）：`aegisx.sqlite`（库）、`attachments/`（附件，按赛事/题目分目录）、`events/<eventId>/challenges/<challengeId>/workspace`（求解者工作区，内含 `agents/<id8>` 与 `shared/`）、`events/<eventId>/orchestrator`（调度者工作区）。

**单镜像整机**（`containers/allinone`，详见其 README）：`AEGISX_EXEC_BACKEND=local` 时执行后端换成 `run/container/local-manager.ts` —— solver bash 直接以本进程命名空间内的 `bash -c` 子进程运行，bind 语义用「路径映射（cwd）+ 容器路径符号链接」复刻，不再有独立工具箱容器，题间隔离随之消失（单机自用取舍）。`AEGISX_BOOTSTRAP=1` 时 `src/bootstrap.ts` 在启动后按环境变量幂等地完成 provider / 赛事 / 平台绑定 / 拉题 / 调度者启动；`AEGISX_WEB_DIR` 让 server 直接伺服构建好的 SPA。

## 数据模型（`apps/server/src/db/schema.ts`）

Event → Challenge → Workspace → Agent 四层。Workspace 是派生路径，无表行；容器是按题惰性管理的资源，跟随该题的存活 agent。schema 演进是基线制（`drizzle/` 只有一份从空库建出当前 schema 的基线迁移），开机按 `user_version` 三态协商：fresh 建库、current 直开、其余版本一律拒绝——旧库无升级路径，详见 [migrations.md](migrations.md)。

- **`agents`** — 执行单元，一次解题尝试一行。`challengeId` 为 null 即该赛事的调度者（orchestrator；每赛事至多一个，唯一索引强制）。model / systemPrompt / tools 在 spawn 时快照，冷恢复原样复用。`token` 为注入凭据（运行时以 `AEGISX_TOKEN` 注入，中间件据此还原 agent 主体）。
- **`sessions` + `session_entries`** — DB 会话树，唯一的会话存储后端：一条 entry 逐字节对应 pi 的一个 jsonl 行，`seq` 为会话内单调序。`session_entries` 是全库最大的表（每条消息一行），**没有自动保留/清理**：会话数据只在显式删除时消失（删 agent / session 走级联，回溯裁剪该会话尾部），因此长赛事下会持续增长。
- **`spawn_queue`** — 调度计划表。一项 = 「在题 X 上派一个 agent」，enqueue 恒为 append（同题多项是合法的并行计划）。生命周期 pending → running（回填 agentId）→ done / failed；`queue_state` 按赛事暂停排水。
- **`channel_messages` + `channel_reads`** — 全部 agent 间通信的唯一账本。频道是派生键（见下），无频道表；`channel_reads` 记 (channelKey, readerKey) → lastReadMsgId，是投递去重锚点。
- **`challenge_flags`** — 一题多解；`agentId` 无 FK（解题史须活得比 agent 行久），`source` 区分 agent 提交 / 手工录入。
- **进度状态机** — `@aegisx/shared/progress.ts` 的 `progressOf` 是"这题解到什么程度"的**唯一定义**：输入是事实（已接受 flag 数、`challenges.required_flags`、平台终态判定、`manual_solve_state`、分值），输出 `{ state: unsolved|partial|solved, source, confirmed, required, earned, perFlag }`。**单 flag 题是退化子集**：`required === 1` 时 `partial` 不可达。服务端所有消费方（`run/fence.ts` 封禁与槽位、`run/service.ts` 解出清理、`run/scheduler-admin.ts` digest、`events/stats.ts`、`events/catalog.ts` 的 wire 投影、`platforms/challenge-state.ts` 的 SQL 镜像）都读它，web 与 SDK 读下发结果——不存在第二份"已解出"推导。`challenges.solved_at` 记首次进入 `solved` 的时刻，解出清理以它为幂等锚点（重同步揭示出更多 flag 导致 solved → partial → solved 回环时不会二次清理）。
- **`scheduler_config`** — 每赛事调度策略（模型、自然语言指令、target 槽位、flag 处置开关等）。
- 其余：`events` / `event_platforms`（平台绑定）、`challenges` / `challenge_remote`（远程镜像状态）、`attachments`、`prompt_templates`、`platform_request_log`（失败的平台请求审计：请求头脱敏、保留 7 天）。

## Agent 生命周期

状态机（`shared/domain.ts` 词表）：`running` / `idle` 为存活（`LIVE_AGENT_STATUSES`），终态 `completed` / `aborted` / `failed`。idle = 回合间保温（容器、槽位、会话都在），直到终态才释放。

出生两条路：`spawn_queue` 排水（默认，调度者的计划落地）或 `agents.start` 直接派发（逃生舱，绕过队列）。组装在 `run/agent-factory.ts`：先经 `run/container-lifecycle.ts` 保证该题容器就绪（引用计数），再建 host session。

运行期守护：

- 硬截止与停滞看门狗都是 agent runtime（`run/agent-runtime.ts`）上的定时器——deadline 到点中止回合、宽限后强制处置；turn settle 后布防停滞检查（solver 专属、paused 跳过、触发前现查 DB）。
- 赛事级生命体征看门狗 `run/fleet-watchdog.ts`（每 2 分钟）：某赛事未暂停、`spawn_queue` 有 pending 项、无任何存活 solver、且排水窗口内无进展（无 launch / 队列变化）时，发一条 urgent `eventStalled` orch 通知——既告警又唤醒调度者；每 episode 至多一次，有存活 solver 或 pending 清零后重置。触发条件刻意收窄，已完工的空闲赛事不会误报。
- 冷启动恢复 `recoverOnBoot`（`app.ts`）— 存活 agent 标记为 idle，不自动续跑；随后 `run/boot-reentry.ts` 对每个仍有非终态调度者的赛事发一条重启重入提示（复用调度者 resume 的直发唤醒语义），由调度者重新同步并决定是否续派——不给 solver 单独发唤醒，避免多 agent 赛事的 token 冲量。调度者不存在或已终态时跳过（由 bootstrap / 用户启动）。**无人值守模式**（`AEGISX_UNATTENDED=1`，tsecbench 镜像内置）下另有两条差异：开机**不**把有可见队列项的赛事置为 `paused`（没有人工 resume 的入口，被迫暂停等于让队列停摆整场），改为续排水，且已存在的 `paused` 意图原样保留；`fleet-watchdog` 同步收紧为"只有 running 的 solver 才算进展"，这样重启后被 parking 成 idle 的 agent 不会被"有存活 solver"的旧条件掩盖（冷恢复 agent 没有 runtime，per-agent 停滞定时器也不会布防）。

运行期的全部定时器（投递 flush tick、容器 sweep 与 SIGKILL 宽限、drainer 去抖与容量重试、per-agent deadline/grace、停滞 watchdog、赛事级看门狗、exec 超时与 `pollExitCode` 退避）统一经时间层 `run/clock.ts` 创建与登记（`Clock` + `TimerHub`），子系统 close 即注册表 `disposeAll()`；测试可注入 fake clock 确定性推进时间。

**所有权根**：一个存活 agent 的全部进程内资源（挂载的 host session、turn generation、finish_run 簿记、deadline/grace 定时器、停滞 watchdog 定时器）都挂在 `run/agent-runtime.ts` 的 `AgentRuntime` 上；service 持有唯一的按 agentId 索引的注册表 `Map<agentId, AgentRuntime>`，首次触达（session 挂载 / 布防 deadline / finish 簿记 / send）时创建。冷恢复语义不变：idle/terminal agent 无 runtime（DB 行即状态），dm 冷唤醒 → send → resume → prepareAgent 重建 runtime。

**终态单一路径**：所有终态（timeout force-abort、finish_run 自终止、close、finish、delete、superseded launch，以及 spawn 过程中失败）收敛到 `runtime.settle`：有界 abort（仅用户驱动的 close）→ dispose session → 清定时器与簿记 → 出注册表 → terminalize（含 LiveBus forget）→ delete-only 收尾；无 runtime 的 agent（从未 prepare）直接落终态。service.close() 对每个 runtime `dispose()`（仅释放进程内资源，不动 DB 状态）即为全部善后——不存在第二份需要记得清的注册表。

LiveBus 的 per-agent 快照（context/queue/activity/running tools）由 bus 自持有；`run/host/live.ts` 属 host 内层，不认识 runtime 与终态。淘汰只由上述唯一终态路径经 status core 的 terminalize 通知（`bus.forget`）触发——settle 先同步 detach session pipeline（此后不再有新事件），再 forget，故不存在终态后写入；除 `close()` 的整体清空外无第二条淘汰路径。

## run/ 核心模块

`apps/server/src/run/` 是运行时心脏，`service.ts`（`createAgentService`）为组装根：

| 模块 | 职责 |
|---|---|
| `service.ts` | agent 生命周期管理：spawn / 终态 / 刷新 / 删除 / 用量统计；持有唯一的 per-agent 注册表 `Map<agentId, AgentRuntime>` |
| `ports.ts` | 组装根的后绑定端口：`createRunPort` 提供写一次、读取前必须 bind 的类型化槽位，表达 service 内部循环装配的初始化契约（替代 `let x!` 与隐式声明顺序陷阱） |
| `agent-runtime.ts` | 单个存活 agent 的所有权根：挂载的 host session、turn generation（send → drive → 代际校验的 settle）、finish_run 簿记、deadline/grace 定时器、停滞 watchdog 定时器、`settle()`（唯一终态路径）与 `dispose()` |
| `locks.ts` | `chainLock`：按 key 串接的 promise 锁原语（withLock / fence / start 锁共用） |
| `clock.ts` | 统一时间层：`Clock`（时间源 + 定时器工厂，默认 `systemClock`，测试注入 fake clock）+ `TimerHub`（定时器注册表，`clear` / `disposeAll`）；运行期定时器一律经它 |
| `agent-factory.ts` | 一次 spawn 的完整组装（容器 → host session → 工具注入）；prepare 成功即把 session 挂到该 agent 的 runtime 上 |
| `queue.ts` | spawn 队列存储与状态：条目 CRUD、pending→running→终态流转、每赛事暂停（`queue_state`）、队列不足边沿 |
| `drainer.ts` | 排水循环（200ms 去抖单飞）：`planDrainStep` 把启动围栏判定翻译为 launch/skip/cancel/stop；`global_capacity` 停轮后按有界间隔自唤醒重试；launch 失败 → item `failed` + 调度者 DM 紧急通知 |
| `fleet-watchdog.ts` | 赛事级生命体征看门狗：pending 无 solver 且排水停滞 → urgent `eventStalled` orch 通知（去重、状态恢复重置） |
| `boot-reentry.ts` | 重启重入提示：对仍有非终态调度者的赛事直发一条 resume 风格唤醒，由调度者决定续派 |
| `fence.ts` | 启动围栏：全局存活 solver 上限（settings `scheduler.maxConcurrentAgents`）、每赛事 target 槽位（`maxConcurrentTargets`）、已解题封禁（`blockSpawnOnSolved`） |
| `channels-*.ts` 五模块 | 协作层（见下），`channels.ts` 为组装壳 |
| `orch-notices.ts` | 系统→调度者/团队通知的类型化事件协议：事件（`flagAccepted` first/extra/partial、`flagPartialProgress`、`solveCleanup`、`challengeHalt`、`queueStarved`、`launchFailed`、`queueStateChanged`、`eventStalled`）→ 投递契约（频道 / meta / 紧急度）→ 模板渲染；文本默认值在 `orchestration/prompt-defaults.ts`（builtin 行，可编辑） |
| `container/container-manager.ts` | dockerode 封装：生命周期 + hijacked exec + putArchive 写入 |
| `workspace/` | 文件工具实现与 docker exec 后端 |
| `bash-tool.ts` | 容器内 bash 工具 |
| `model-resolver.ts` / `model-runtime.ts` | canonical 模型引用 `aegisx-<providerId>/<modelId>:<effort>` 的解析与运行时模型表（新 provider 惰性刷新） |
| `sse.ts` | 唯一的实时流出口：`GET /api/stream` 一条 SSE 连接承载全部 agent 事件与频道消息（LiveBus → SSE，走 bus 全局订阅；载荷自带 `agentId` / `message.channelKey`，由客户端分发）。保留慢客户端背压合并（每 streaming 身份只留最高 revision）与 seed-before-subscribe |
| `principal-scope.ts` | 数据层作用域断言：`assertMayTouchEvent` / `assertMayTouchChallenge` / `assertMayTouchAgent`（授权的数据层，见下） |
| `routes.ts` / `scheduler-admin.ts` / `queries.ts` / `public.ts` | 用户面路由、调度管理面、查询与对外形状 |

**授权分两层**（对 P0-1/2/8「每处手写 scope 条件，漏写即越权」的结构性收敛）：中间件 `infrastructure/agent-auth.ts` 把每个请求**解析一次**为 `Principal`——`{kind:"user"}`（无 token 的本机用户面）、`{kind:"agent", agentId, eventId, challengeId, role}`（token 还原）、`{kind:"system"}`（仅进程内调用方，HTTP 永远产生不了）——它的 `verdict` 决定「这类主体能否打这个端点」（agent API 面，403 by omission）；`run/principal-scope.ts` 的断言助手决定「这个主体能否碰这条数据」。凡跨主体可达的写操作/查询（channels 发帖、queue 操作、agents 管理面、spawn、fleet 等），service 方法签名收 principal 并在内部过同一断言，路由层只做参数解析与转发、不拼任何 scope 条件；channels 发帖另有作者↔principal 一致性断言（`resolveAuthor`），token 冒充 user/system/他人发帖从任何分支进入都会被拒。纯用户面（settings/providers/平台绑定等）verdict 已挡住 agent token，无需 principal。

宿主侧支撑在 `apps/server/src/run/host/`（host 子层，原 `src/agents/`）：`host-session.ts`（pi loop 封装）、`event-pipeline.ts`（事件 → 会话树 + LiveBus + 计时元数据）、`db-session-manager.ts`、`live.ts`（LiveBus）、`model-switch.ts`（存活中换模型）。依赖方向由 lint 强制（`apps/server/.oxlintrc.json` 的 `no-restricted-imports` overrides）：host 是最内层，只能依赖叶子与更内层（`run/errors` / `run/bash-tool` / `run/model-runtime` / `run/container` / `run/workspace` / `db` / `lib`），不得反向 import 编排与路由模块；路由层与组合根——组合根（`app` / `bootstrap` / `index`）、用户面（`run/routes` / `run/scheduler-admin` / `run/sse` / `run/public`）、事件与平台面（`events` / `scheduler` / `platforms` / `settings` / `activity`）——不得深入 `run/host/*` 内部，只能经 service 或 `run/host/index.ts` 公共出口（例外：`run/service` / `run/agent-factory` / `run/agent-session-ops` 等构造 host 层的运行时内部消费者）。

## 协作层（channels）

频道键全部派生，无频道表：

- `team:<challengeId>` — 每题一个 `#team`，同题求解者 + 用户共享的题目公共历史。
- `dm:<agentId>` — 指向单个 agent 的私信（用户介入与调度者指派共用）。
- `orch:<eventId>` — 汇聚面：solver 的 `ask`、系统事件（flag 被接受、超时、停滞）。

写路径（`channels-post.ts`）：消息入账本，附件拷入该题工作区 `shared/` 树（路径存 `meta` JSON，容器内直读，无取回步骤）。投递引擎（`channels-delivery.ts`）是唯一的推送出口：按读游标取增量、按 agent 的投递面（solver = 本题 #team + 自身 dm；调度者 = orch）渲染成投递提示，全局 flush tick 批量冲刷；事件先落账、再聚合唤醒，调度者不会被逐条事件牵引。dm 支持 urgent 冷唤醒（终态 agent 也可被重新叫起）；team/orch 只向存活 agent 投递，终态后仅存档。

投递引擎的三条不变式：**每个 agent 一条串行链**（并发投递会各自读到同一段未读区间并重复投递；串行同时保证写入顺序）；**每条投递的首行是 `[当前时间]`**（唤醒自带时间锚点，读者不靠最新消息推断「现在」）；**idle 调度者有心跳**——连续一个 tick 无事件、无未读、且距上次成功投递超过一个 tick 时，仍投递一次「心跳 + 调度快照」，且不写频道账本。心跳是唤醒可靠性的下限：纯事件驱动会让「安静的赛事」与「死掉的赛事」不可区分，而静默恰是调度者最该复核组合（产出速率、难度/方向多样性、队列水位）的时刻。多个 steer 的合并发生在运行时而非此处：`agent-runtime.send` 检测到已有 pending steer 时把新文本折进同一条——pi 的每次 `steer()` 各算一条独立注入，不合并就会让一次批量指令变成 N 条消息。

实时扇出（`channels-context.ts` → LiveBus）：每条消息**只 emit 一次**，bus 键取频道自身 id（#team = challengeId，dm = agentId，orch = eventId）；LiveBus 只有全局订阅（`subscribeAll`）一个出口，web 端按载荷里的 `message.channelKey` 分发，因此不存在 per-channel 订阅方，也不需要有第二把事件级键。

**系统通知 = 类型化事件 + 模板**（`run/orch-notices.ts`）：系统侧的调用点（service 的 flag 处置/解出清理/手动停止、queue 的队列边沿与暂停恢复、赛事级看门狗）不再拼中文散文，只构造类型化事件并 `publish`；事件决定投递面（`team:<challengeId>` 或 `orch:<eventId>`）、`meta`（`eventType` / `noticeType` / 提交者 `agentId`）与紧急度，文本由模板渲染——默认值即 `NOTICE_TEMPLATE_DEFAULTS`（10 个键），随 builtin 行落 `prompt_templates`（用户可编辑，下次通知生效）。事件载荷只带结构字段（如 `launchFailed` 携带 challengeName 与截断后的 error），措辞一律归模板。投递面、urgent 语义、paused 门与 `meta.agentId`（跳过提交者自身通知）等契约全部留在 channels 层不变。设置面：settings meta 暴露全部内置模板的默认 body（含通知模板，支持「恢复默认 / 修改标记」）与各类型的变量清单（含 `noticePromptVariables`），`POST /api/settings/prompts/preview` 对全部 `notice*` 键统一收 `kind: "notice"`，用一个与变量清单严格一致的示例上下文渲染（前端不镜像变量、不按事件分派）。

## 调度

调度者不是代码里的循环，而是**一个 agent**：消费 `orch` 频道的事件投递，用 Python SDK（`queue.enqueue` / `agents.*`）产出计划，由 `queue.ts` 排水落地。系统侧的约束都在 `fence.ts` 与 `run/scheduler-policy.ts`（读侧合并 `scheduler_config`：flag 通知、解出后停兄弟、槽位释放时机 eager/drained 等）。并发与槽位在启动侧强制校验，不依赖调度者自觉；事件批处理与阈值触发由投递引擎的 flush tick 承担。

系统→调度者的方向是类型化事件 + 可编辑模板：`orch` 频道里的系统消息全部由 `run/orch-notices.ts` 的事件渲染（flag 接受、部分解出、解出清理、手动停止、队列不足/启动失败、队列暂停恢复、赛事停滞），事件的结构字段决定 meta 与紧急度，散文只在模板里；调度者→系统的方向由容器内 Python SDK 类型化，两侧协议都不再依赖隐式约定。

**调度快照必须同时给出成本与产出**（`run/scheduler-admin.ts` 的 `getDigestContext` → `schedulerDigest` 模板）。产出侧：每题 `earned`（已得分）、`flagProgress`（n/N）、`perFlag`、`sinceLastFlag`，事件级 `elapsed` 与 `sinceLastScore`，以及 `board`（未启动题数与未触达分值——没有 live agent 也没有排队项的题不会出现在逐题行里，不汇总就等于对调度者不可见）。多旗进度由本地已接受 flag 数与 `challenges.required_flags` 经 `progressOf` 推导（`earned = points × confirmed / required`）：平台按旗均分分值，逐旗分数组不在 agent 面 API 上。`required_flags` 的写者是平台同步（仅在平台**确实报告**了数值时写，缺字段不覆写）与操作员覆写；数值未知时进度封顶在 `partial`，绝不从计数自行判「已解」。`solvedLabel` 只在 `progressOf` 判为 `solved` 时才给「已解」——把「有 1 个 accepted flag」当已解会让 2/6 的链看起来完工。缺了分子，调度者的性价比判断无从执行，故这两侧字段是同一份契约。

**通用模板 vs 部署特调**：`prompt-defaults.ts` 里的内置模板只写与具体赛事无关的策略原则（含预算语义：`timeout_ms` 是兜底，分配靠 agent 上限与 `agents.close`）；具体数值（各难度首轮预算、平台并发上限、flag 格式、离线约束）属于某个评测环境的经验参数，落在部署侧的 event preset（`containers/*/preset.json` 的 `promptHint` 与 `settings`，`bootstrap.ts` 读取），不写进通用模板。

## 平台适配（`apps/server/src/platforms/`）

`core.ts` 定义统一接口，`adapters/` 内置五类：CTFd、A1CTF、DASCTF、Ret2Shell、TSecBench。能力面：题目同步（`sync.ts`）、远程 flag 判定（`flags.ts`）、靶机实例启动/续期（`targets.ts`）；远程状态镜像进 `challenge_remote` 表，失败请求落 `platform_request_log`（请求头脱敏，保留 7 天）。异步判定轮询（`flags.ts`）与靶机就绪轮询（`targets.ts`）的等待也走统一时间层 `run/clock.ts`——`createPlatformService` 接受可选 `clock`（默认 `systemClock`，组装点 `app.ts` 不传）并下传给两个模块，间隔/超时/重试次数语义不变，测试注入 `createFakeClock` 消除真实等待。flag 被平台接受的回调（`app.ts` 的 agentHooks）会刷新提交 agent 的视图、通知调度者，并按策略停掉同题其余存活 agent。

## LLM 接入

`apps/server/src/providers/`：provider 配置（openai-compatible / anthropic / 等）、模型发现与内置模型表。求解镜像是三档通用工具箱，与模型无关；模型按 agent 逐个指定。固定端点网关（追加路径即 404 的 LLM proxy）经 `bun run relay`（`apps/server/scripts/relay.ts`）脱路径代理后当作 openai-compatible 接入。

## Web 前端（`apps/web/src/`）

- `api/` — REST 客户端，类型直接取自 `@aegisx/shared`。
- `stream/` — SSE 消费：`live-connection.ts` 是**进程级唯一** EventSource（应用根部接线；按 `agentId` / `message.channelKey` 自行分发，断线由 EventSource 原生重连，`onReconnect` / `onStatus` 供上层刷新与提示），`conversation-store.ts` 是按 agentId 键控的会话状态 + selector（stable/tail 记忆化 + rAF 批量通知；`retain()` 决定哪些 agent 的持久历史留在内存，其余只保留有界的实时状态），`parse-event.ts` 解析 LiveEvent。频道视图与对话视图共用这一条连接。
- `features/` — 页面域：events（赛事/题目/平台）、runs（agent 会话时间线与频道视图）、tasks（题中心任务视图 / 队列）、stats（统计）、activity（全局活动日志）、settings。
- `domain/` / `components/` — 前端本地领域与 coss UI 组件库（只读）。

## Python SDK（`apps/sdk/python/`）

构建时随镜像分发到 `/opt/aegisx-sdk`，提示词引导 agent 先 `cat /opt/aegisx-sdk/GUIDE.md`。鉴权链：agent token → `infrastructure/agent-auth.ts` 中间件解析出 `Principal` 并做端点级 verdict（solver 只有频道与自面；scheduler 有本赛事管理面）→ service 层作用域断言二次限定数据边界（见「run/ 核心模块」的授权两层）。接口一致性由契约测试保障（`apps/server/scripts/sdk-contract.ts`，根脚本 `bun run test:sdk`）。

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

进程模型：**agent loop 在宿主 server 进程内**运行，基于 `@earendil-works/pi-coding-agent`（版本由根 `package.json` 的 `overrides` 统一钉住）。bash 与 CTF 工具链不在进程内执行：每道题一个长寿 Kali 容器（主进程 `sleep infinity`，纯工具箱）承载执行，命令经 dockerode `exec` 送入；文件工具（read/edit/write/grep/find/ls）同样落到该容器，工作区双向 bind mount。网络边界：solver 容器在默认 bridge 上持有 `NET_RAW`，出站不受限，宿主局域网亦可达（也可经 `container.networkMode` 共享 VPN 容器的网络命名空间）；系统强制的隔离是 solver↔宿主数据与 solver↔其他题目，不含 solver↔局域网，有需要时通过 `container.networkMode` 收紧。

数据全部落在 `data/`（可用 `AEGISX_DATA_DIR` 改址）：`aegisx.sqlite`（库）、`files/`（附件）、`events/<eventId>/challenges/<challengeId>/workspace`（求解者工作区，内含 `agents/<id8>` 与 `shared/`）、`events/<eventId>/orchestrator`（调度者工作区）。

**单镜像整机**（`containers/allinone`，详见其 README）：`AEGISX_EXEC_BACKEND=local` 时执行后端换成 `run/container/local-manager.ts` —— solver bash 直接以本进程命名空间内的 `bash -c` 子进程运行，bind 语义用「路径映射（cwd）+ 容器路径符号链接」复刻，不再有独立工具箱容器，题间隔离随之消失（单机自用取舍）。`AEGISX_BOOTSTRAP=1` 时 `src/bootstrap.ts` 在启动后按环境变量幂等地完成 provider / 赛事 / 平台绑定 / 拉题 / 调度者启动；`AEGISX_WEB_DIR` 让 server 直接伺服构建好的 SPA。

## 数据模型（`apps/server/src/db/schema.ts`）

Event → Challenge → Workspace → Agent 四层。Workspace 是派生路径，无表行；容器是按题惰性管理的资源，跟随该题的存活 agent。schema 演进是基线制（`drizzle/` 只有一份从空库建出当前 schema 的基线迁移），开机按 `user_version` 三态协商：fresh 建库、current 直开、其余版本一律拒绝——旧库无升级路径，详见 [migrations.md](migrations.md)。

- **`agents`** — 执行单元，一次解题尝试一行。`challengeId` 为 null 即该赛事的调度者（orchestrator；每赛事至多一个，唯一索引强制）。model / systemPrompt / tools 在 spawn 时快照，冷恢复原样复用。`token` 为注入凭据（运行时以 `AEGISX_TOKEN` 注入，中间件据此还原 agent 主体）。
- **`sessions` + `session_entries`** — DB 会话树，唯一的会话存储后端：一条 entry 逐字节对应 pi 的一个 jsonl 行，`seq` 为会话内单调序。
- **`spawn_queue`** — 调度计划表。一项 = 「在题 X 上派一个 agent」，enqueue 恒为 append（同题多项是合法的并行计划）。生命周期 pending → running（回填 agentId）→ done / failed；`queue_state` 按赛事暂停排水。
- **`channel_messages` + `channel_reads`** — 全部 agent 间通信的唯一账本。频道是派生键（见下），无频道表；`channel_reads` 记 (channelKey, readerKey) → lastReadMsgId，是投递去重锚点。
- **`challenge_flags`** — 一题多解；`agentId` 无 FK（解题史须活得比 agent 行久），`source` 区分 agent 提交 / 手工录入。
- **`scheduler_config`** — 每赛事调度策略（模型、自然语言指令、target 槽位、flag 处置开关等）。
- 其余：`events` / `event_platforms`（平台绑定）、`challenges` / `challenge_remote`（远程镜像状态）、`attachments`、`prompt_templates`、`platform_request_log`（失败的平台请求审计：请求头脱敏、保留 7 天）。

## Agent 生命周期

状态机（`shared/domain.ts` 词表）：`running` / `idle` 为存活（`LIVE_AGENT_STATUSES`），终态 `completed` / `aborted` / `failed`。idle = 回合间保温（容器、槽位、会话都在），直到终态才释放。

出生两条路：`spawn_queue` 排水（默认，调度者的计划落地）或 `agents.start` 直接派发（逃生舱，绕过队列）。组装在 `run/agent-factory.ts`：先经 `run/container-lifecycle.ts` 保证该题容器就绪（引用计数），再建 host session。

运行期守护：

- `run/deadlines.ts` — `deadlineAt` / `timeoutMs` 到点触发超时终态。
- `run/stall-watchdog.ts` — 停滞看门狗（长时间无进展的存活 agent）。
- 冷启动恢复 `recoverOnBoot`（`app.ts`）— 存活 agent 标记为 idle，不自动续跑。

运行期的全部定时器（投递 flush tick、容器 sweep 与 SIGKILL 宽限、drainer 去抖与容量重试、per-agent deadline/grace、停滞 watchdog、exec 超时与 `pollExitCode` 退避）统一经时间层 `run/clock.ts` 创建与登记（`Clock` + `TimerHub`），子系统 close 即注册表 `disposeAll()`；测试可注入 fake clock 确定性推进时间。

终态善后收敛在 `run/service.ts`：abort → dispose → lifecycle 删除 → 清定时器 → terminalize → LiveBus forget。

## run/ 核心模块

`apps/server/src/run/` 是运行时心脏，`service.ts`（`createAgentService`）为组装根：

| 模块 | 职责 |
|---|---|
| `service.ts` | agent 生命周期管理：spawn / 终态 / 刷新 / 删除 / 用量统计 |
| `clock.ts` | 统一时间层：`Clock`（时间源 + 定时器工厂，默认 `systemClock`，测试注入 fake clock）+ `TimerHub`（定时器注册表，`clear` / `disposeAll`）；运行期定时器一律经它 |
| `agent-factory.ts` | 一次 spawn 的完整组装（容器 → host session → 工具注入） |
| `queue.ts` | spawn 队列存储与状态：条目 CRUD、pending→running→终态流转、每赛事暂停（`queue_state`）、队列不足边沿 |
| `drainer.ts` | 排水循环（200ms 去抖单飞）：`planDrainStep` 把启动围栏判定翻译为 launch/skip/cancel/stop；`global_capacity` 停轮后按有界间隔自唤醒重试；launch 失败 → item `failed` + 调度者 DM 紧急通知 |
| `fence.ts` | 启动围栏：全局存活 solver 上限（settings `scheduler.maxConcurrentAgents`）、每赛事 target 槽位（`maxConcurrentTargets`）、已解题封禁（`blockSpawnOnSolved`） |
| `channels-*.ts` 五模块 | 协作层（见下），`channels.ts` 为组装壳 |
| `container/container-manager.ts` | dockerode 封装：生命周期 + hijacked exec + putArchive 写入 |
| `workspace/` | 文件工具实现与 docker exec 后端 |
| `bash-tool.ts` | 容器内 bash 工具 |
| `model-resolver.ts` / `model-runtime.ts` | canonical 模型引用 `aegisx-<providerId>/<modelId>:<effort>` 的解析与运行时模型表（新 provider 惰性刷新） |
| `sse.ts` | 每 agent 的实时流出口（LiveBus → SSE） |
| `routes.ts` / `scheduler-admin.ts` / `queries.ts` / `public.ts` | 用户面路由、调度管理面、查询与对外形状 |

宿主侧支撑在 `apps/server/src/run/host/`（host 子层，原 `src/agents/`）：`host-session.ts`（pi loop 封装）、`event-pipeline.ts`（事件 → 会话树 + LiveBus + 计时元数据）、`db-session-manager.ts`、`live.ts`（LiveBus）、`model-switch.ts`（存活中换模型）。依赖方向由 lint 强制（`apps/server/.oxlintrc.json` 的 `no-restricted-imports` overrides）：host 是最内层，只能依赖叶子与更内层（`run/errors` / `run/bash-tool` / `run/model-runtime` / `run/container` / `run/workspace` / `db` / `lib`），不得反向 import 编排与路由模块；路由层（`run/routes` / `run/scheduler-admin` / `events` / `scheduler` / `platforms` / `settings` / `activity`）不得深入 `run/host/*` 内部，只能经 service 或 `run/host/index.ts` 公共出口。

## 协作层（channels）

频道键全部派生，无频道表：

- `team:<challengeId>` — 每题一个 `#team`，同题求解者 + 用户共享的题目公共历史。
- `dm:<agentId>` — 指向单个 agent 的私信（用户介入与调度者指派共用）。
- `orch:<eventId>` — 汇聚面：solver 的 `ask`、系统事件（flag 被接受、超时、停滞）。

写路径（`channels-post.ts`）：消息入账本，附件拷入该题工作区 `shared/` 树（路径存 `meta` JSON，容器内直读，无取回步骤）。投递引擎（`channels-delivery.ts`）是唯一的推送出口：按读游标取增量、按 agent 的投递面（solver = 本题 #team + 自身 dm；调度者 = orch）渲染成投递提示，全局 flush tick 批量冲刷；事件先落账、再聚合唤醒，调度者不会被逐条事件牵引。dm 支持 urgent 冷唤醒（终态 agent 也可被重新叫起）；team/orch 只向存活 agent 投递，终态后仅存档。

## 调度

调度者不是代码里的循环，而是**一个 agent**：消费 `orch` 频道的事件投递，用 Python SDK（`queue.enqueue` / `agents.*`）产出计划，由 `queue.ts` 排水落地。系统侧的约束都在 `fence.ts` 与 `run/scheduler-policy.ts`（读侧合并 `scheduler_config`：flag 通知、解出后停兄弟、槽位释放时机 eager/drained 等）。并发与槽位在启动侧强制校验，不依赖调度者自觉；事件批处理与阈值触发由投递引擎的 flush tick 承担。

## 平台适配（`apps/server/src/platforms/`）

`core.ts` 定义统一接口，`adapters/` 内置五类：CTFd、A1CTF、DASCTF、Ret2Shell、TSecBench。能力面：题目同步（`sync.ts`）、远程 flag 判定（`flags.ts`）、靶机实例启动/续期（`targets.ts`）；远程状态镜像进 `challenge_remote` 表，失败请求落 `platform_request_log`（请求头脱敏，保留 7 天）。flag 被平台接受的回调（`app.ts` 的 agentHooks）会刷新提交 agent 的视图、通知调度者，并按策略停掉同题其余存活 agent。

## LLM 接入

`apps/server/src/providers/`：provider 配置（openai-compatible / anthropic / 等）、模型发现与内置模型表。求解镜像是三档通用工具箱，与模型无关；模型按 agent 逐个指定。固定端点网关（追加路径即 404 的 LLM proxy）经 `bun run relay`（`apps/server/scripts/relay.ts`）脱路径代理后当作 openai-compatible 接入。

## Web 前端（`apps/web/src/`）

- `api/` — REST 客户端，类型直接取自 `@aegisx/shared`。
- `stream/` — SSE 消费：`conversation-store.ts` 持有单个 agent 的会话状态（stable/tail 记忆化 + rAF 批量通知 + 断线重连；**单流约束**——同时只订阅一个 agent），`parse-event.ts` 解析 LiveEvent。
- `features/` — 页面域：events（赛事/题目/平台）、runs（agent 会话时间线与频道视图）、tasks（题中心任务视图 / 队列）、stats（统计）、activity（全局活动日志）、settings。
- `domain/` / `components/` — 前端本地领域与 coss UI 组件库（只读）。

## Python SDK（`apps/sdk/python/`）

构建时随镜像分发到 `/opt/aegisx-sdk`，提示词引导 agent 先 `cat /opt/aegisx-sdk/GUIDE.md`。鉴权链：agent token → `infrastructure/agent-auth.ts` 中间件 → 角色面（solver 只有频道与 `ask`；scheduler 有全部管理面）。接口一致性由契约测试保障（`apps/server/scripts/sdk-contract.ts`，根脚本 `bun run test:sdk`）。

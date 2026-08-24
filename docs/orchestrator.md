# Orchestrator：基于 LLM 的解题调度

Status: **Phase 0–3 已落地**（Phase 3 剩「closed 冷恢复」一项未做）。本文档为设计定稿，决策已冻结。
Related: [architecture.md](./architecture.md)（v5 现状）、[refactor-v4.md](./refactor-v4.md)（v4 SDK 重构）

> 本设计 crystallize 自 2026-07-31 与 2026-08-02 两次会话讨论，并基于已落地的
> v4/v5（host SDK agent + DB-backed session + 三态生命周期）重新对齐。此前所有
> orchestrator 讨论仅停留在规划，**从未落地**——`docs/` 无文档、schema 无任何
> scheduler 痕迹、git 无相关提交。

## 一、一句话目标

给 AegisX 加一个**平台级调度大脑**：per-event 一个常驻 pi SDK `AgentSession`，
用自然语言 instruction 驱动，在硬围栏之内自主决定"开哪题、停哪个、给多久、要不要
重来”，并对每个 solver run 的事件做监督与 review。它自带一个 per-event 工作台
（Kali 容器 + 文件系统），用文件记录战略、状态与历史决策，必要时用 bash 跑脚本
分析多 run 数据。决策全程是对话，前端像看一个 Run 一样看它的思考过程。

## 二、核心架构：双层 Agent

```
┌──────────────── Browser ─────────────────────────────────┐
│  Event 页面：Run tab · Settings tab · Orchestrator tab     │
│  Orchestrator tab = Conversation + Timeline（复用 Run 形态）│
│  + 顶部状态条（并发槽 / 靶机槽 / 进行中 run）+ instruction   │
└──────────────────┬────────────────────────────────────────┘
                   │ 结构化事件 + REST + SSE
┌──────────────────▼────────────────────────────────────────┐
│         AegisX server (Hono / Bun)                         │
│                                                           │
│  ┌─ Orchestrator AgentSession (per-event) ───────────────┐ │
│  │  per-event 容器 + workspace（战略工作台）               │ │
│  │  工具: 文件工具（同 solver）+ 管理工具                   │ │
│  │        list_challenges / get_challenge / list_runs /     │ │
│  │        start_run / stop_run / message_run / close_run /  │ │
│  │        read_run / get_status                             │ │
│  │  subscribe → session_entries(orchestrator) + SSE       │ │
│  └────────────────────┬───────────────────────────────────┘ │
│                       │ 调 runService.create / stop          │
│                       │ 读 session_entries(solver)           │
│  ┌─ Run AgentSession (per solver run, 现有) ──────────────┐ │
│  │  tools: read/bash/.../submit_flag/target/finish        │ │
│  │  per-run 超时: 30min 半程通知 / 60min 硬限              │ │
│  └────────────────────┬───────────────────────────────────┘ │
└──────────────────────┼─────────────────────────────────────┘
                       │ docker exec（bash + 文件工具）
                       ▼
┌────────────── Docker containers (solver image) ──────────┐
│  per-run 工具箱   aegisx-run-<runId>                       │
│  per-event 工作台 aegisx-orchestrator-<eventId>            │
│  main: sleep infinity；/workspace ← bind（host workspace） │
└───────────────────────────────────────────────────────────┘
```

**关键分工：**

| 东西 | 在哪 | 谁管 |
|------|------|------|
| orchestrator 的 LLM 调用 / loop / compact | host 进程（pi SDK） | SDK |
| orchestrator 的决策可见性 | `session_entries`(owner=orchestrator) + SSE | AegisX |
| solver run 的创建/停止 | `runService`（orchestrator 通过工具调） | AegisX |
| solver 进展可读 | `session_entries`(owner=run)，按 role 过滤 | AegisX |
| 围栏校验 | 服务端硬代码（工具 execute 前置检查） | AegisX |

orchestrator **和 solver run 同构**：一个 per-event 的 host SDK session + 一个
per-event Kali 容器（工具箱）+ 一个 per-event workspace（战略工作台，记录
STRATEGY/STATE/DECISIONS 等）。区别只在工具集（管理工具 vs CTF 工具）和粒度
（per-event vs per-challenge）。这让 `createRunAgentSession` 的容器/文件工具创建
逻辑几乎原样复用——是相对 7-31 原设想更统一的方向。

## 三、围栏（服务端铁律）

设计原则：**只保留"撞了就出事"的硬约束，偏好类判断全部交给 instruction。**

| # | 围栏 | 为什么是硬的 |
|---|------|-------------|
| 1 | 全局 running run 数 ≤ `scheduler.maxConcurrentRuns` | 本地资源，爆了 OOM |
| 2 | **不同的**靶机题（target-capable 且未解）同时被攻 ≤ `orchestrators.maxConcurrentTargets`（默认 1） | 平台物理上限是"同时起几个 target 实例"，撞了 `start_target` 报错。target 是 per-challenge 实例，多 run 打同一题共享一个实例 → 共享一个槽 |

> **没有"每题至多一个 run"的围栏。** 靶机槽数按**题数**计、不按 run 数计，所以 orchestrator 可以同时开多个 run 打同一道题（仅受全局 run 上限约束）。

**显式放弃的围栏**（7-31 原清单里的第 4、5 条）：

- ~~"跳过已解题目"~~：**不做任何限制**。历史赛事常被用作测试数据（平台 `solved=true`），
  硬跳过会挡住测试。是否重做已解题完全由用户在 instruction 里告知 orchestrator
  （"重做所有题"／"已解的别碰"）。
- ~~"excluded 列表硬围栏"~~：排除偏好同样交给 instruction。`excludedChallenges`
  不作为围栏字段；若日后想要 UI 便捷勾选，再以"注入 instruction"的形式实现，不进硬校验。

围栏实现：`canLaunchRun(eventId, challengeId)` 函数，`start_run` 工具 execute 前置
调用。违反时**不抛异常**，而是把拒绝原因作为 tool result 返回给 orchestrator
（"靶机槽已满，当前 1/1"），让 AI 据此调整计划——这比硬失败更符合"计划制"语义。

> `message_run` 冷恢复一个 closed run（→ running）会占用一个全局并发槽，同样走围栏 #1；idle/running 的 message 不查（该 run 本就合法持有槽位）。

## 四、触发模型：事件驱动 + 定时唤醒

orchestrator 的 LLM 不是每 tick 实时跑，而是**被唤醒时才思考**。两类唤醒源：

| 触发源 | 时机 | 解决的问题 |
|--------|------|-----------|
| **事件驱动** | solver run 的 turn 结束（→ idle）、`finish_run`、`submit_flag` accepted、连续失败 | 紧、省——solver 每完成一轮就给 orchestrator 一个自然检查点 |
| **定时唤醒** | 某 run 的 turn 一直 running，到 30min 半程 / 60min 硬限 | 防 solver 卡在一轮里烧 token、长时无进展 |

两者都走同一条路径：`notifyOrchestrator(eventId, message)` → 给 orchestrator
session 注入一条系统消息（streaming 时 `steer`，否则 `prompt` 开新轮）。orchestrator
被唤醒后调 `read_run` 看进展 → 决策（继续观察 / `stop_run` 换策略 / 标记放弃 /
`start_run` 开下一题）。

> **为什么没有 orchestrator 自己的周期 tick**：用户要的"避免解题者长时间卡题"已经
> 被 per-run 的 30/60min 阈值覆盖——run 长时间不 idle 必然撞上这两个阈值，触发唤醒。
> 额外加 orchestrator 级 tick 是重复机制。

## 五、per-run 超时

每个 solver run（无论手动还是 orchestrator 启动）都有超时机制：

- **默认 60min 硬限**：到点 `session.abort()` → turn settle 到 `idle`（**保留容器，
  可续**，不销毁 run），并通知 orchestrator review。
- **30min 半程通知**：到点不干预 solver，只通知 orchestrator（"run X 已跑 30min"），
  让它决定要不要提前介入。
- **orchestrator 可定制**：`start_run` 工具带可选 `timeoutMs`，orchestrator 按情况
  给单个 run 设更长/更短的超时。不传则用默认 60min。
- **不做难度自动覆盖**（不按 points 分档）——由 orchestrator 自己在 `start_run` 时
  按 instruction 判断。

实现：runService 在 `create`/`ensureWarm` 后设两个 timer，`stop`/`finish`/`closeRun`/
`freeRun`/`deleteRun` 清 timer。`recoverOnBoot` 后不恢复内存 timer，`ensureWarm`
冷恢复时按 `deadlineAt - now` 的剩余值重设。runs 表新增 `timeoutMs` / `deadlineAt` /
`halfwayNotifiedAt`。

> v5 已把 `timed_out` status 废除。超时 = abort → idle，不引入新 status。

## 六、orchestrator 工具

orchestrator 启用 solver 同款文件工具（read/bash/edit/write），用于
在战略工作台写文件、跑分析脚本——这部分和 solver 完全一致，不在此表列出。下面的
管理工具全部 `defineTool`，execute 前置围栏校验，结果回 tool result。

| 工具 | 参数 | 作用 |
|------|------|------|
| `list_challenges` | — | 该 event 所有题的摘要：id/name/category/points/靶机能力/已解/尝试次数/上次结果。扫描选题用 |
| `get_challenge` | `challengeId` | 单题完整详情：description/附件清单/靶机连接信息（name+services）/可用与已解状态/run 活动计数/上次 summary。开题前或判断难度时深读 |
| `list_runs` | `challengeId?`, `status?` | 枚举 run（最近优先，上限 50），含 summary/flag/error/时间戳。复盘历史、找 runId 用 |
| `start_run` | `challengeId`, `initialPromptOverride?`, `timeoutMs?`, `modelId?` | 围栏内启动 solver run；内部调 `runService.create`。允许多 run 打同一题 |
| `stop_run` | `runId` | `session.abort()` → idle（保留容器），等同用户按 Esc |
| `message_run` | `runId`, `text`, `deliverAs?` | 给 run 发消息：running→steer/followUp；idle→开新轮；closed→冷恢复容器+续 session 开新轮。**优先于 stop+start**：保留 solver 上下文与工作区 |
| `close_run` | `runId` | 释放容器（→ closed；session 与历史保留，之后可用 `message_run` 续跑）。释放资源用 |
| `read_run` | `runId`, `roles?`(默认 assistant+toolResult), `since?` | 读该 run 的 `session_entries`，默认给 assistant 文本 + toolResult（thinking 省略）；每条/总体双截断，超出提示用 `since` 续读 |
| `get_status` | — | 当前并发槽 X/Y、靶机槽 X/Y（按题数计）、各 run 状态摘要 + deadline |

**显式不做**：`set_exclude`（排除靠 instruction）。review 闭环里"换策略"靠
`message_run`（保留上下文纠偏）或 `stop_run` + `start_run`(带新 initialPromptOverride)
实现。

## 七、orchestrator 的 session 可见性

这是 7-31 当天最大的纠结点，现已自动解决：所有 solver run 都在 host SDK 进程内，
事件落 `session_entries` 表。orchestrator 的 `read_run` 工具直接 SQL 查该表，按
`agentId`/`role`/`since` 过滤——零文件解析、零 pi 定制。

## 八、数据模型变更（schema v6）

### 新表 `orchestrators`（per-event 1:1）

```
orchestrators
  eventId          PK, FK→events cascade
  enabled          boolean
  modelId          text        -- 启动时从现有模型列表选；null = 用全局默认
  thinkingLevel    text        -- 默认 off
  instruction      text        -- 自然语言指挥（"先冲 crypto，pwn 留最后"）
  maxConcurrentTargets  integer  -- 默认 1
  status           text        -- running | idle | closed（同 run 三态）
  -- 容器 + workspace 快照（冷恢复用，字段对齐 runs）
  containerName    text
  image / cpus / memoryMb / pidsLimit
  workspacePath    text        -- data/orchestrators/<eventId>/workspace
  sessionDir       text        -- data/orchestrators/<eventId>/sessions
  createdAt / updatedAt
```

### `runs` 表新增字段

```
+ source            text  -- 'manual' | 'orchestrator'（默认 manual）
+ timeoutMs         integer
+ deadlineAt        text  -- ISO；启动时 = now + timeoutMs
+ halfwayNotifiedAt text  -- 30min 通知后打戳，防重复
```

### session 存储泛化（已落地：方案 A）

`sessions`/`session_entries` 加 `ownerType` (`'run'`|`'orchestrator'`) +
`ownerId`，`runId` 放宽为可空。`DbSessionManager` 参数化 owner：run 的
`ownerType='run'/ownerId=runId`，orchestrator 的
`ownerType='orchestrator'/ownerId=eventId`。前端 `ConversationStore` 按 owner 拉
entries，timeline 原样复用。未走 jsonl 快通道（方案 B）。

### 全局 settings 新增（`FlatSettings`）

```
+ scheduler.maxConcurrentRuns   integer  -- 全局并发，默认 4
+ scheduler.defaultRunTimeoutMs integer  -- 默认 60 * 60 * 1000
```

per-event 的 `maxConcurrentTargets` / `modelId` / `instruction` 走 `orchestrators`
表，不进全局 FlatSettings。

## 九、API

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/events/:eventId/orchestrator` | 配置 + 状态（并发/靶机占用、run 概览） |
| PATCH | `/api/events/:eventId/orchestrator` | 改 enabled/modelId/instruction/maxConcurrentTargets |
| GET | `/api/events/:eventId/orchestrator/messages` | orchestrator session 的消息（复用 run messages 形态） |
| GET | `/api/events/:eventId/orchestrator/stream` | orchestrator live SSE |
| POST | `/api/events/:eventId/orchestrator/message` | 给 orchestrator 发消息（steer/followUp，等同用户在对话框输入） |
| POST | `/api/events/:eventId/orchestrator/start` | enabled 且无活 session → 建-session + 首轮 prompt |
| POST | `/api/events/:eventId/orchestrator/stop` | abort 当前轮 → idle |
| POST | `/api/events/:eventId/orchestrator/close` | 释放 session → closed |

solver run 侧的 `POST /api/challenges/:id/runs` 加可选 `source`/`timeoutMs`
（orchestrator 调 start_run 时内部传 source='orchestrator'；手动创建仍是 manual）。

## 十、前端

event 页面现有 tabs：`run` / `settings`。**新增 `orchestrator` tab**
（路由 `/events/:eventId/orchestrator`），与 run/settings 并列。

Orchestrator tab 内容：

- **顶部状态条**：并发槽 X/Y、靶机槽 X/Y、进行中 run 列表（点击跳对应 run）。
- **instruction 文本框**：自然语言指挥（多行 textarea）。
- **模型选择**：启动时选（下拉，复用现有 model 选择）。
- **Conversation + Timeline**：**复用 Run 的对话组件**（`ConversationStore` 按
  orchestrator owner 拉 entries，消息气泡 / 工具调用折叠 / 流式 全复用）。用户可
  在对话框给 orchestrator 发消息 steer，像跟一个"赛事经理"对话。

orchestrator 的工具调用（`start_run`/`stop_run`/`read_run`）在 timeline 里像
solver 的 `bash`/`submit_flag` 一样展示——用户能看见 orchestrator 为什么开这题、
为什么停那个。

## 十一、模块落点（server）

```
apps/server/src/
  agents/                 共享：host-side pi agent 核心（solver main/child + orchestrator 同构）
    host-session.ts      createHostAgentSession：统一 session 工厂（owner 泛化 +
                          DbSessionManager + event pipeline + 资源加载器）
    lifecycle.ts         createSessionLifecycle：drive/settle/send/abort + 代次守卫 +
                          per-id 锁；run 与 orchestrator 共用，差异走钩子
    event-pipeline.ts    SDK 事件 → SSE 总线（原 run/session/events.ts）
    live.ts              LiveBus 扇出（原 run/session/live.ts）
    db-session-manager.ts DB-backed SessionManager（原 run/session/）
    entry-usage.ts       token/cost 累计（原 run/session/）
  orchestrator/
    service.ts           per-event 生命周期（接 lifecycle）+ 围栏 + 触发路由
    session.ts           createOrchestratorSession：host-session 的薄壳
                          （owner=orchestrator + 按 owner 冷恢复）
    tools.ts             list_challenges/start_run/stop_run/read_run/get_status
    guard.ts             canLaunchRun（3 条硬围栏）
    routes.ts            /api/events/:eventId/orchestrator/**
    queries.ts           按 ownerType=orchestrator 读 entries
  run/
    service.ts           per-run 生命周期（接 lifecycle）+ child agents + pending
                          finish/close + per-run 超时 timer + notifyOrchestratorForRun
    provision.ts         main agent 装配（工具 + host-session）
    child-agents.ts      spawn_agent 的后台子 agent
  db/
    schema.ts            orchestrators 表；sessions/session_entries 泛化 owner；
                          SCHEMA_VERSION → 6
  settings               scheduler.maxConcurrentRuns / scheduler.defaultRunTimeoutMs
                          进 SETTINGS_DEFS
```

**为什么没有 `trigger.ts`**：触发逻辑（`notifyOrchestratorForRun` + per-run 的
30/60min 定时器）寄生在 `run/service.ts` 里——它在 run 的 idle/finish/超时路径上
就地回调 orchestrator，单独抽文件反而要额外接线。turn 调度核心已在
`agents/lifecycle.ts`，run 与 orchestrator 的 drive/settle 同源。

## 十二、实施顺序

**Phase 0 — 存储泛化 + 围栏骨架** ✅ 已完成
1. schema v6：`orchestrators` 表；`sessions`/`session_entries` 加 ownerType/ownerId
   （方案 A）；`runs` 加 source/timeoutMs/deadlineAt/halfwayNotifiedAt。
2. `DbSessionManager` 参数化 owner。
3. `guard.ts`：`canLaunchRun`（3 条围栏）。
4. spike：建一个 orchestrator session（含 per-event 容器 + 文件工具），subscribe 事件落库。

**Phase 1 — orchestrator session + 工具 + 触发** ✅ 已完成
1. `session.ts`：createOrchestratorSession（per-event 容器 + 文件工具 + 管理工具，复用 events pipeline）。
2. `tools.ts`：5 个工具（start_run 接 runService.create + 围栏）。
3. `trigger.ts`：notifyOrchestrator（run idle/finish/解出 → 注入消息）。
4. per-run 超时 timer（30/60min）接入 runService。
5. 冒烟：instruction 写一句，orchestrator 自己开 run、读 run、停 run。

**Phase 2 — 前端 Orchestrator tab** ✅ 已完成
1. 路由 + tab；状态条；instruction 框；模型选择。
2. Conversation + Timeline 复用（ConversationStore 按 orchestrator owner）。
3. start/stop/close 按钮。

**Phase 3 — 打磨**
1. ✅ read_run：`since` 游标增量读 + 默认 role(assistant/toolResult) +
   toolResult 文本抽取 + 每条/总体双截断。
2. ✅ recoverOnBoot：running/idle → closed 并删容器（同 run 语义）。
3. ✅ usage/cost 回填 orchestrator Detail（复用 run 的 usage 累计机制）。
4. ⏳ 冷恢复：给 closed 的 orchestrator 发消息 → 重建 session 续同一 owner（现需
     close+start 重启；start 不重接旧 session 的 onResume 钩子）。
5. ✅ notify 摘要：run 生命周期事件携带题名/分值/flag/src 摘要，减少 orchestrator
     的 read_run 往返。

## 十三、明确放弃 / 保留

| 放弃 | 理由 |
|------|------|
| 固定策略算法（preset/排序维度） | 用户明确要纯 AI + instruction |
| "跳过已解"/excluded 硬围栏 | 历史赛事测试需要；偏好交 instruction |
| orchestrator 自带周期 tick | per-run 30/60min 阈值已覆盖"卡题唤醒" |
| `set_exclude` 工具 | 偏好交 instruction |

| 保留 / 复用 | 理由 |
|-------------|------|
| pi SDK `createAgentSession` + events pipeline | orchestrator 也是 SDK session |
| `session_entries` + `ConversationStore` | 单一真相源，timeline 复用 |
| runService.create / stop | orchestrator 通过工具复用，不自写 run 生命周期 |
| running/idle/closed 三态 | orchestrator 套用同一生命周期 |
| run 侧容器 + 文件工具创建（createRunAgentSession） | orchestrator 同构，只换工具集与粒度 |

## 十四、Future（明确不做，记录待日后）

- **动态难度估算**：本地多 run 数据自动估题难度，反哺 orchestrator 决策。
- **长驻 shell 复用**：降 solver 的 docker exec 开销（与 orchestrator 无关，run 侧债）。

> `steer_run` / 中途纠偏 / 冷恢复续跑已落地为 `message_run`（见 §六工具表）。
> 运行时切模型/思考强度已落地（run 主 agent + orchestrator 的 composer footer 选择器，
> 下一轮生效，见 §六与 `agents/model-switch.ts`）。
>
> orchestrator 的系统提示词与 solver 一样走"模板 + 设置项"：
> `prompts.orchestratorSystem`（默认见 `prompt-defaults.ts`），变量 `event.id` /
> `event.name` / `instruction`，在设置页可编辑与预览。

## 十五、风险与缓解

| 风险 | 缓解 |
|------|------|
| 方案 A 改核心表波及 run queries | Phase 0 先做 + 完整测试；run 侧 ownerType 恒为 'run'，现有 query 加 `where ownerType='run'` 兜底 |
| orchestrator 决策跑偏（乱开 run 烧钱） | 3 条硬围栏兜底物理上限；instruction 可随时 steer 纠偏；timeline 全可见 |
| read_run 上下文爆炸 | since 游标增量读；默认只 assistant+toolResult（省 user prompt）；每条 1500 / 总体 16000 字符双截断，超出提示续读 |
| per-run 超时 timer 跨崩溃丢失 | recoverOnBoot 标 closed；ensureWarm 按 deadlineAt 剩余值重设 |
| orchestrator 和手动 run 抢资源 | 手动 run 一样占并发槽、一样受围栏；不豁免，超额时 orchestrator 自然退让 |
| schema wipe | 单用户本地，沿用 v4/v5 惯例；`SCHEMA_VERSION=6`，旧库拒开，迁移配置 |


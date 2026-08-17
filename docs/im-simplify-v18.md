# IM 简化 v18：派生键频道 + urgent 统一投递

状态：**设计定稿，待实施**（用户拍板 2025-12；实施信号后按 §十二 阶段执行）
前置：[im-channels.md](im-channels.md)（v16/v17 频道化 IM）、[orchestration-v9-simplify.md](orchestration-v9-simplify.md)（v9 编排模型）
取代：[im-channels.md](im-channels.md) 全文（本文与其冲突处以本文为准；实施完成后前者标注 superseded）

---

## 一、动机

v16/v17 两轮叠加后，消息层的概念密度与「本地单兵平台」不再匹配：

1. **`channels` 表是纯目录**——三种频道的身份全部可由已有实体（challenge / agent / event）派生，却各自占表行、需要 get-or-create、需要 v17 式「频道合并」迁移。
2. **投递策略分裂**——solver 频道「投递即 steer」、调度者 DM 是一套 digest 状态机（静默计时 / 紧急分级 / recap 回存 / 现查状态快照 / 停滞 watchdog / hold / catch-up），两套机制并存。
3. **用户→agent 双重记账**——同一条消息存 `channel_messages` + `session_entries` 两份。
4. **频道种类过剩**——`#announce` 与 `#team` 观众相同；`kind`/`scopeType` 组合出 3×3 权限矩阵。

v18 断言：**频道 = 派生键，事件 = 消息，投递 = urgent 二值分级 + 固定周期合并，用户对话直连 session**。四张表减为三张，两个状态机（digest、event-scope 接线）删除。

## 二、频道宇宙（派生键，无目录表）

| 频道 | 键 | 生命周期 | 用途 |
|---|---|---|---|
| `#team` | `team:<challengeId>` | 跟随 challenge | 同题跨 run 的 solver 协作 + 调度者公告 + 系统通知（partial-flag 等） |
| `DM:run-x/solver-y` | `dm:<agentId>` | 跟随 agent | 调度者/系统 → 指定 solver 的定向消息 |
| `DM:orchestrator` | `orch:<eventId>` | 跟随 event | solver ask + 系统 run 生命周期/队列事件 → 调度者 |

- 键是**唯一身份**：没有 channels 表、没有 ensure* get-or-create、没有 scopeType/kind 列；第一条消息自动「存在」。
- v17 语义整体保留：#team 题目级跨 run 共享、署名带 run 短 id、onboarding sweep、closed run 只存不投。
- `#announce` 取消：调度者公告发 `#team`（authorType=agent 署名即「公告」身份）；系统广播同键。
- 调度者无 `dm:` 频道——用户/系统找调度者走 `orch:` 或直连对话。

### 2.1 写入权限（3 条规则）

| 频道 | 可写 |
|---|---|
| `team:<cid>` | 该题任意 run 的 solver、本 event 调度者、用户、系统 |
| `dm:<agentId>` | 本 event 调度者、用户、系统（目标 agent 本身不写） |
| `orch:<eid>` | 本 event 的 solver（ask）、用户、系统（调度者 agent 不写） |

### 2.2 可见面（SDK list / read / UI）

- solver：自己题的 `#team` + 自己的 `dm:` + `orch:`（读 + ask 写）。
- 调度者：event 内全部 `#team` + 全部 `dm:` + `orch:`。

## 三、消息与投递

### 3.1 消息

```
body + meta { urgent?: true, runId?, eventType?, noticeType? } + 附件（📎 元数据行，内容不进 steer）
```

`kind` 列删除（recap 机制随 digest 一起删除——时间线就是事件流本身，投递历史由游标可知）。

### 3.2 urgent 二值分级（唯一投递策略，三频道统一）

```
post(msg):
  落库（先持久化再投递，crash 不丢）
  if msg.meta.urgent === true → 立即 deliverChannel(key)
  else → 等待 flush tick（每 N=5min，代码常量 + 测试 seam）
```

**urgent 默认值**（SDK/UI 参数可显式改）：

| 写入方 | 默认 | 理由 |
|---|---|---|
| solver `post("#team", ...)` | false | findings 多数不紧急，合并投递 |
| solver `ask(text, urgent=False)` | 参数 | 决策上移场景自判 |
| 调度者 `channels.announce(run_id, ...)`（→ #team） | false | FYI 公告 |
| 调度者 `agents.message(agent_id, ...)`（→ dm） | **true** | 指令可执行，需时效 |
| 用户 IM 输入框（任意频道） | **true** | 罕见且有意图（沿用现状「用户发帖立即 flush」语义） |
| 系统 run 事件 / 队列事件 / 停滞 | 查表（§五） | |

### 3.3 投递引擎（deliverAgent，唯一 push 出口）

```
deliverAgent(agentId):                     # 一个 reader 一次 steer，吃掉全部积压
  channels = reader 的可见投递面           # solver: team + own dm；调度者: orch
  unread = 各频道 id > 游标 且 author != reader 的消息（跨频道收拢）
  if 空 → skip
  renderMerged（分组 + 8K 上限 + 溢出折叠，urgent 行加 ⚠ 前缀）
  → 游标推进到快照最大 id → lifecycle.send(agentId, text, deliverAs ?? "steer")
```

`lifecycle.send` 三态语义不变（streaming → 注入轮末；idle → 新轮；closed → onResume 冷恢复）。

**冷唤醒红线**（唯一例外规则）：

| 频道 | urgent 立即投递到 closed run | tick 投递 |
|---|---|---|
| `team` | 否（只存——恢复只碰被触发的 agent） | 仅 live run |
| `dm` | **是**（lifecycle.send → onResume 冷恢复该 agent，保留现 message_agent 语义） | 仅 live session |
| `orch` | 否（调度者 run 关闭时只存；下次启动 catch-up） | 仅 live session |

### 3.4 flush tick（全局单一 interval）

- service 创建时 `setInterval(N)`，close 时清除；无 per-event 对象、无生命周期管理、无 catch-up 代码——消息已持久化，tick 天然处理积压。
- tick 内容：`runs WHERE status IN (running, idle)` → 各 solver `deliverAgent`；各 event 的 live 调度者 agent → `deliverAgent`（扫 orch）。
- 暴露 `nextFlushAt`（UI 状态头）。
- **hold（deliveryPaused，per-event）**：暂停时 tick 与 urgent 立即投递对该 event 全部跳过（只存储）；恢复后下一次 tick/urgent 补投。沿用现有 UI 开关语义。

### 3.5 已读 = 投递状态

`channel_reads(channelKey, readerKey) → lastReadMsgId`，readerKey = agentId（agent readers）/ 常量 `"scheduler"`（orch reader，跨调度者重启稳定——键派生后天然无 churn 问题）。

推进点收敛为 3 类，全部走同一个 `markRead(channelKey, readerKey, msgId)`（取 max）：

1. **deliverAgent 注入后**（投递完成 = 已读）；
2. **SDK `read()`**（pull = 主动消费）；
3. **自发帖**（author=agent 时推进自己在该频道的游标——你发过的位置就是已读；`deliverAgent` 查询另有 `author != reader` 过滤兜底）。

删除：`advanceCursor` / `advanceSchedulerCursor` / `advanceCursorKey` 三函数与 `SCHEDULER_READ_KEY` hack。

## 四、用户直连 vs IM 写入面

- **会话时间线输入框 → 直连**：`POST /api/runs/:id/message`、`/api/agents/:agentId/message` 回归 `lifecycle.send(text, deliverAs)` 直写 session（不产生 channel 行，双重记账消失）；冷恢复语义由 onResume 原样承载；返回 RunPublic 不变。
- **IM 输入框（channels 视图 / 调度者 DM 视图）→ 正常走 IM**：post 到对应频道（urgent 默认 true，可切换），进入统一投递策略。
- SDK `runs.message` / `agents.message`（调度者用）→ IM 发帖（dm 键 / entry agent 的 dm 键），带 urgent 参数——调度者消息保留账本。

## 五、事件 → 消息（urgent 查表）

`emitRunEvent` **直接 post 到 `orch:<eventId>`**，EventScopeEmitter / attachSchedulerWakeup / digest 对象整体删除。W3 paused 门控保留为 post 前一行判断（paused → run 事件与队列紧急静默丢弃）。

| 事件 | urgent |
|---|---|
| `run.timedOut` | **true** |
| `run.started` / `run.idle` / `run.flagAccepted` / `run.finished` / `run.resumed` | false |
| 队列紧急（starved 边沿 / 启动失败） | **true** |
| 队列通知（pause/resume 等） | false |
| 停滞 watchdog（agent idle ≥ 2min） | **true** |
| flagPartial（#team 系统帖） | false（现状 notice 级） |

digest 渲染瘦身：flush 文本 = 未读消息列表（⚠ 前缀标 urgent），**不再**做 run 行合并 / 挑战名 / padEnd 对齐 / ⚠ deadline 列 / `active X/cap` 统计行——调度者醒来自己用 SDK 查全貌（`runs.list()` / `read_run` 已覆盖）。渲染复用 `renderMerged`。

**停滞 watchdog 拆出独立小文件**（`run/stall-watchdog.ts`，~60 行）：`noteAgentIdle(runId)` arm 2min 计时器 → 现查 → post urgent 到 orch。行为变化（记录）：不再依赖 live digest 实例——调度者不在线时消息存储，下次启动 catch-up；arm 条件维持（challenge run、非 paused）。

## 六、附件（语义不变，存储拍平）

- 全部保留：快照拷贝、单文件 64MB / 单消息 8 个 128MB、workspace 路径逃逸校验、multipart 用户上传、SDK fetch 物化到 `/workspace/inbox/`、📎 元数据行、回滚。
- 存储目录拍平：`data/channel-files/<messageId>/<filename>`（去掉 channelId 层——键是派生的，目录永不因迁移改名）。

## 七、数据模型（schema v18）

```sql
channel_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- 全局单调（游标基准，不变）
  channelKey TEXT NOT NULL,               -- 'team:<cid>' | 'dm:<aid>' | 'orch:<eid>'
  authorType TEXT, authorAgentId TEXT NULL, authorName TEXT,
  body TEXT, meta TEXT, createdAt TEXT
)  -- 索引 (channelKey, id)

channel_reads(
  channelKey TEXT, readerKey TEXT, lastReadMsgId INTEGER, updatedAt TEXT,
  PRIMARY KEY (channelKey, readerKey)
)

channel_files(
  id TEXT PK, messageId INTEGER, filename TEXT, size INTEGER, createdAt TEXT
)
```

- `channels` 表 **DROP**；`kind` 列（recap）删除。
- 无 FK 级联（键派生的代价）→ 删除路径显式清理（§八）。

### 7.1 迁移 `0012_derived_channel_keys`（v17→v18，不 wipe）

1. 键映射：challenge 级 team + announce → `team:<challengeId>`（**announce 消息并入 team**，全局单调 id 保证合并不乱序——v17 迁移同手法）；run 级 dm → `dm:<targetAgentId>`；event 级 dm → `orch:<eventId>`。
2. `DELETE FROM channel_messages WHERE kind = 'recap'`。
3. `channel_reads` 重键（channelId → channelKey；scheduler reader 行 readerKey='scheduler' 保持）。
4. `channel_files` 目录搬移：`channel-files/<channelId>/<messageId>/` → `channel-files/<messageId>/`；表删 channelId 列。
5. `DROP TABLE channels`。SCHEMA_VERSION 17→18。
6. 历史（#team 知识库 = v17 的全部价值）保留；沿用 0011 迁移测试手法写 `migration-0012.test.ts`。

## 八、生命周期与显式清理

| 删除 | 清理动作 |
|---|---|
| run 删除（deleteRun） | 各 agent 的 `dm:<aid>` 消息/游标行 + 附件目录；`lifecycle` 会话（现状已有） |
| challenge 删除 | `team:<cid>` 消息/游标 + 附件目录（app.ts 现有 cleanupChallengeFiles 处扩展） |
| event 删除 | `orch:<eid>` + 该 event 全部 team/dm 键的消息/游标/附件（event 级联删除路径补一次按键前缀清理） |

集中为一个 `deleteChannelData(keyPrefix | keys[])` 辅助函数。

## 九、HTTP / SSE / SDK / UI / prompt

### 9.1 HTTP

| 端点 | 变化 |
|---|---|
| `GET /api/runs/:runId/channels` | 返回派生键树（#team + 各 dm），无 announce |
| `GET /api/challenges/:challengeId/channels` | 只剩 #team 一个 |
| `GET/POST /api/channels/:channelKey/messages` | 路径参数 = 派生键（`:` 为合法 path 字符；POST body 增 `urgent`） |
| `GET /api/agents/:agentId/channels` | SDK list，形状同 §2.2 |
| `GET /api/events/:eventId/inbox` | 简化：`{ channelKey, unreadCount, nextFlushAt, deliveryPaused }` |
| `GET /api/channel-files/:fileId` | 不变 |
| `POST /api/runs/:id/message` / `/api/agents/:agentId/message` | **直连 steer**（§四），不再产生 channel 行 |

### 9.2 SSE

`channel.message` 事件 payload 的 `channelId` → `channelKey`；分流规则：`team`/`orch` → event 频道，`dm` → run 频道。

### 9.3 SDK（python）

```python
aegisx.channels.list()                                  # 不变（返回派生键）
aegisx.channels.read("#team" | "orch" | key, after, limit, mark_read)
aegisx.channels.post("#team", text, tags=None, files=None, urgent=False)
aegisx.ask(text, urgent=False, files=None)              # → orch:<eid>
aegisx.channels.announce(run_id, text)                  # → run 所在题的 team:<cid>（resolve 封装，LLM 不拼键）
aegisx.channels.fetch(file_id, dest=None)               # 不变
aegisx.agents.message(agent_id, text, urgent=True, deliver_as=None)   # → dm:<aid> IM 发帖
aegisx.runs.message(run_id, text)                       # → entry agent 的 dm:<aid>
```

### 9.4 Web

- `channels-view.tsx`：树 = `#team`（共享徽章）+ `DM:run-x/solver-y`；输入框带 urgent 开关（默认开）。
- `scheduler-dm-tab.tsx`：orch 时间线（无 recap 渲染）+ 状态头（未读数 / nextFlushAt / paused 开关）。
- conversation 输入框：行为不变（服务端语义已改直连）。
- `challenge-im-dialog` / event 页频道入口：单 #team。
- `api/channels.ts` + `conversation-store`：channelKey 形状适配。

### 9.5 prompt 模板（builtin 沿 LEGACY 刷新机制）

- `mainSystem` Channels 段：post 增 urgent 参数说明（时效性强的 finding 标 urgent）；announce 概念删除。
- `orchestratorSystem`：announce → `channels.post`/`channels.announce` 落 #team；`agents.message` 默认 urgent 语义；digest/recap 描述删除（收到的就是未读列表 + ⚠ 标注）。

## 十、删除清单 / 不变清单

**删除**：

- `orchestration/event-scope.ts` 全文件；run-factory 的 `attachSchedulerWakeup` + eventScopes 依赖；service 的 `digests` map / `digestFor` / `onSchedulerDmMessage` 回调链；teardown 的 digest/emitter 清理。
- `run/scheduler-digest.ts` 全文件（flush 函数并入 channels 服务 ~80 行；watchdog 独立）。
- channels 服务内：`ensureChallengeChannels` / `ensureAgentDm` / `ensureSchedulerDm` / `challengeChannel` get-or-create 族、scope×kind 权限特判、`skipAgentIds`（partial-flag 提交者会多收一条自己触发的通知，无害）、`deferDelivery` / `deliverAwaited`（用户路径已直连）、recap 读写、三个游标函数。
- schema：`channels` 表、`channel_messages.kind`、`channel_files.channelId`。
- web：announce 相关 UI、recap 渲染、inbox 三级分类视图。

**不变**（红线全保留）：per-agent 锁+代次、run 状态 SQL 派生、`finishing` 原子置位、fence 三处强制、队列 FIFO + 边沿触发、冷恢复围栏/单飞/只碰被触发 agent、两阶段超时、session 多 session/backtrack/compact、容器模型与 SDK 挂载（per-exec env 身份）、`/runs:ro`、附件全套语义与上限、v17 题目级共享 / onboarding sweep / 署名 run 溯源 / closed 只存不投、W3 paused、hold（deliveryPaused）、`deliverAs`（steer/followUp）、partial-flag 单帖扇出、stopSiblingsOnSolved、`MAX_SOLVERS_PER_RUN`、SSE 快照重放。

## 十一、规模预估

| 组件 | 现状 | 目标 |
|---|---|---|
| `run/channels.ts` | 1342 | ~550 |
| `run/scheduler-digest.ts` | ~370 | 0（flush ~80 并入 channels；watchdog ~60 独立文件） |
| `orchestration/event-scope.ts` | 50 | 0 |
| `service.ts` / `run-factory.ts` / `teardown.ts` 接线 | — | 显著缩短（digests/eventScopes/attach 全链） |
| schema | 4 表 | 3 表 |
| 相关测试（digest 835 + scheduler-events 746 + channels 695 …） | ~3000 | flush/watchdog/迁移/投递策略重写，总量约减半 |
| **净变化** | | **约 -2500 行** |

事件→调度者路径从 5 跳（emitRunEvent → emitter → digest.push → post → 回调 onMessage → 计时器）变 2 跳（emitRunEvent → post；tick/urgent → deliverAgent → steer）。

## 十二、实施阶段

| Phase | 内容 | 验证 |
|---|---|---|
| **P1 schema + 核心** | v18 迁移 0012（announce 并入、键派生、recap 删除、目录拍平、drop channels）；`run/channels.ts` 重写：键派生 / post（含 urgent 参数与默认值矩阵）/ 权限 3 规则 / markRead 三推进点 / 附件（拍平目录）/ 列表查询 / `deleteChannelData` | `migration-0012.test.ts`（合并保序、目录搬移、reads 重键、recap 清除）；post/权限/附件/上限单测 |
| **P2 投递引擎** | `deliverAgent`（跨频道收拢 + renderMerged 复用 + ⚠ 前缀）；urgent 立即投递（dm 冷唤醒 / team 只存 / orch 只存）；flush tick（N 常量 + seam + nextFlushAt + hold）；onboarding deliver 沿用 deliverAgent | urgent 三频道即时投递矩阵；tick 合并（一 reader 一 steer）；closed store-only；dm urgent 冷恢复；hold 暂停/补投；自发帖过滤 |
| **P3 事件接线 + 清理** | `emitRunEvent` → 直 post（urgent 查表 + W3 门控）；队列紧急/通知 → post；`scheduler-digest.ts` / `event-scope.ts` 删除；`stall-watchdog.ts` 独立；service/run-factory/teardown 全链清理（digests/eventScopes/attachSchedulerWakeup/回调）；sendMessage/sendAgentMessage 直连化；routes（键路径 + inbox 简化 + message 端点直连）；deleteRun/challenge/event 显式清理 | scheduler-events 测试改写（事件→orch 消息断言 + urgent 表）；watchdog 测试；teardown/boot 无残留引用；`bun run check` 绿 |
| **P4 SDK + prompt** | SDK read/post/ask/announce/agents.message（urgent 参数）；mainSystem/orchestratorSystem LEGACY 刷新 | SDK 单测；手测容器内全链路（post/ask/urgent/fetch） |
| **P5 Web** | channels-view / scheduler-dm-tab / api/channels / store 适配；urgent 开关 | `bun run build` + 手动链路（#team 发帖带 urgent → solver 收 steer；调度者 DM 状态头） |
| **P6 收尾** | im-channels.md 标注 superseded + README 设计索引更新；`bun run check` / `test` / `build` 全绿 | 全绿 |

每 Phase 结束跑该 Phase 验证；P3 起服务可整体运行。

## 十三、已定决策记录

1. `#announce` 并入 `#team`；频道宇宙 = `team:<cid>` / `dm:<aid>` / `orch:<eid>` 三种派生键（用户）。
2. 所有事件简化为消息，urgent 二值分级：true 立即投递，false 每 N 分钟合并；**urgent 统一作用于全部三种频道**（用户拍板，#team findings 传播延迟上限 = N，solver 用 urgent 参数保时效）。
3. 用户在会话时间线发消息 = 直连 steer/followUp（不经 IM、不产生 channel 行）；用户在 IM 内发消息 = 正常走 IM 且通过 urgent 区分（默认 urgent）（用户）。
4. 已读 = 投递状态：游标三推进点（投递后 / SDK read / 自发帖）收敛为单一 markRead 函数（用户）。
5. 附件功能保留；存储目录拍平到 messageId 层（用户「简化数据库」+ 设计推论）。
6. digest / recap / EventScopeEmitter / 状态快照渲染整体删除；停滞 watchdog 独立保留（输出 = urgent orch 消息）；hold 与 W3 paused 保留。
7. N = 5min 代码常量（沿用现状静默窗口值）；迁移保留历史（#team 知识库价值所在），不 wipe。
8. 不做用户未提到的事：不引入拉取式调度者、轮首注入、solver 间 DM、/shared 层、event 级聚合视图等。

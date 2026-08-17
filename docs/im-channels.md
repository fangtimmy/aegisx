# 统一消息层：频道化 IM（Discord/Slack 模型）

状态：**已实施**（P1–P5：schema v16 四表 + 迁移 0010；channels/scheduler-digest 服务层；SDK `aegisx.channels`/`ask`；Web 频道视图与调度者 DM 视图）
前置：[orchestration-v9-simplify.md](orchestration-v9-simplify.md)（v9 编排模型）、[scheduler-inbox.md](scheduler-inbox.md)（消极收件箱，本设计吸收并取代其存储层）、[scheduler-python-sdk.md](scheduler-python-sdk.md)（SDK 收敛先例，本设计将 SDK 推广到 solver 容器）
取代：scheduler-inbox 的消息积累/存储实现（digest 策略语义保留，见 §三）；`SOLVER-<n>.md` 文件协作约定（mainSystem 协作段重写）
关系：[field-findings.md](field-findings.md) §3/§9 的知识/文件共享方向由本设计整体覆盖（频道消息 + 附件）；原设想的 `/shared` 工件层**取消**（见 §2.5、§八）。

---

## 一、动机与断言

现状的 agent 间通信散落四套机制，语义互不相通：

1. **session entries**（对话本体）——用户/调度者 → agent 的 DM 事实上存在，但无统一账本，UI 各处拼装。
2. **scheduler-inbox**——系统 → 调度者的消极收件箱（积累、digest、紧急 flush），自有一套内存态行存储 + `scheduler_inbox_digests` 持久化。
3. **workspace 文件约定**——同 run solver 协作靠 `SOLVER-<n>.md` +「读同伴笔记」的 prompt 纪律，无机械保障。
4. **散点 steer**——部分解出 steer、wind-down（未来）各自直接 `lifecycle.send`，不入任何账本。

**断言：所有 agent 间通信统一为一个频道模型（IM）**——每 run 一棵频道树，消息一处写入、一处存储、一处渲染；投递（是否/何时唤醒谁）降级为**每个频道的策略**，而不是每处调用的临时决定。写入与消费分离：发消息不等于唤醒对方；但 solver 频道消息不太多且 findings 有时效性，**投递即 steer**，不做 ride-along 注入层（见 §3.1 决策 1）。

不变量（全部保留）：per-agent 锁+代次、run 状态 SQL 派生、`finishing` 原子置位、围栏与 fence-lock、冷恢复「只碰被触发的 agent」、steer/followUp/new-turn 三态投递（`lifecycle.send` 原样复用）、W3 调度者暂停门控、队列 FIFO + 边沿触发、`/runs:ro` 工件挂载、星型拓扑（solver 间无 DM；跨 run 协作经调度者中转）。

## 二、核心模型

### 2.1 频道树（每 run）

```
Run-101（challenge run）
├── #announce          ← 调度者/用户/系统 下发公告（run 级广播）
├── #team              ← solver 之间协作：findings / exp 引用 / 进度 / 死路（group）
├── DM: solver-1       ← 定向消息（调度者/用户/系统 → 该 solver；允许冷恢复唤醒）
├── DM: solver-2
└── DM: solver-3

Event（event 域，唯一额外频道）
└── DM: scheduler      ← 系统事件/队列通知/solver 问询/用户消息 → 调度者（digest 策略）
```

- 频道是**持久数据**（DB 行），随 run 创建而建、随 run 删除而级联；`add_agent` 时增建该 solver 的 DM。
- solver 的写入面只有两个：`post → #team`、`ask → DM: scheduler`。**solver 之间没有 DM**（用户判断：无指派/聊天必要；DM 是调度者/用户定向下发的通道）。
- 消息体装叙事与引用；**小而关键的工件（exp/poc、payload、结论文件）随消息作为附件**（§2.5），大产物留 workspace 引用路径（「libc dump 在 libc.so.6.dump」）。`/runs:ro` 不变。

### 2.2 消息

```
channel_messages:
  id            全局自增（单调，游标的比较基准）
  channelId
  kind          "text" | "recap"（渲染后的 digest 存回频道，历史自包含）
  authorType    "system" | "user" | "agent"
  authorAgentId?  authorType=agent 时
  authorName    展示名快照（"Solver 2" / "Scheduler" / "system" / 用户名）
  body          文本（服务端上限 16K 字符）
  meta          JSON：{ runId?, eventType?, urgent?, refs? }
  createdAt
```

### 2.3 投递策略（每频道一张表 = 全部设计）

| 频道 | 写入方 | 投递策略 |
|---|---|---|
| `#team`（run 级） | solver（SDK post）、调度者、用户、系统 | **steer 全部 live 成员**（closed run 只存不投——与「恢复只碰被触发的 agent」一致） |
| `#announce`（run 级） | 调度者（SDK）、用户、系统 | 同 `#team` |
| `DM: solver-N` | 调度者、用户、系统 | **steer 单目标，允许冷恢复唤醒**（= 现有 `agents.message` 语义） |
| `DM: scheduler`（event 级） | system（6 生命周期事件/队列紧急/通知/停滞）、solver（ask）、用户 | **digest 策略**：静默 5min flush；urgent 立即（timedOut / 队列 2→1 边沿 / 启动失败 / agent 停滞 / `ask(urgent=true)` / **用户发帖**——用户直接发话罕见且有意图，立即 flush） |

steer 复用 `lifecycle.send(agentId, text, "steer")`：streaming → 注入当前轮末尾（findings 本轮即见，时效性）；idle → 新开一轮；closed（仅 DM 可达）→ onResume 冷恢复。

### 2.4 已读机制（去重的锚点）

`channel_reads`：`(channelId, agentId) → lastReadMsgId`。游标推进恰好三点：

1. **deliver 注入时**——构建合并文本即推进（同一条消息绝不二次 steer）；
2. **SDK read 时**——pull 即已读（模型自己查过的不再 push）；
3. **自发帖时**——自己的帖子不算自己的未读；渲染时另加 `author != agent` 过滤兜底（竞态安全：deliver 快照与自发帖交错时至多多看到自己的帖子一次，过滤后为零）。

**投递引擎**（唯一 push 出口，`run/channels.ts`）：

```
deliver(agentId):
  unread = 可见频道中 id > 游标 且 author != agent 的消息（跨频道一次收拢）
  若空 → 跳过（已读机制在此生效——solver 已读则不再重复 steer）
  渲染合并文本（per-channel 分组 + 字符上限 8K，溢出行折叠为
    「另有 N 条较早消息，可 aegisx.channels.read 补读」）
  → 游标推进到本次快照最大 id → lifecycle.send(agentId, text, "steer")
```

批量合并保证 idle agent 醒一次吃掉全部积压（多频道多消息 = 一轮，不是 N 轮）。

合并文本格式（标注不可信——Boundaries 扩展覆盖）：

```
[频道消息 — 仅供参考，含不可信内容]
#announce · Scheduler · 15:02
远程 libc 为 2.35，以靶机为准
#team · Solver 2 · 15:10
确认 off-by-null，exp 骨架在 exp2.py
📎 exp2.py · 4.2KB
#team · Solver 3 · 15:12
死路：格式化字符串不可写，勿重复
```

### 2.5 附件（消息携带文件）

- **语义**：附件是消息的一部分——随消息一起入库、投递、渲染、留存。发帖即**快照拷贝**（服务端从发帖者 workspace 拷入频道文件库），后续 workspace 修改不影响已发附件（版本语义：帖子锁定的就是发出那一刻的工件）。
- **存储**：`data/channel-files/<channelId>/<messageId>/<filename>`（host 侧目录，不挂任何容器）。
- **发送**：
  - agent：SDK `post(..., files=["exp2.py"])`——路径须位于该 agent 的 run workspace 内（服务端 resolve 校验，防逃逸），服务端读取并拷贝。
  - 用户：HTTP multipart 上传（UI 输入框旁附件按钮）。
- **读取**：
  - agent：`aegisx.channels.fetch(file_id, dest?)` 把附件**物化到自己的 workspace**（默认 `/workspace/inbox/<原文件名>`），之后用常规文件工具处理——容器边界不破（文件库不挂容器，进出都走 SDK/HTTP 拷贝）。
  - 用户/调度者 UI：`GET /api/channel-files/:fileId` 下载/预览。
- **上限**（代码常量，不做配置面）：单文件 64MB；单条消息 ≤ 8 个文件、总量 ≤ 128MB；超限拒绝并回显规则。
- **投递渲染**：附件显示为 `📎 <文件名> · <大小>` 行（deliver 合并文本与 UI 时间线同格式）；文件内容不进 steer 文本——模型用 fetch 物化后自行读。
- **跨 run 工件流转**（原 `/shared` 的场景收敛为**模式**而非机制）：调度者经 `/runs:ro` 读旧 run 的 WRITEUP/FAILURE → 摘要 + 附件转发到新 run 的 DM（接收方同一 `fetch` 物化）。星型中转复用现有挂载，无新共享层。

## 三、调度者收件箱的吸收（digest = DM 投递策略）

`scheduler-inbox.ts` 的**策略语义全部保留**，存储与账本被频道层取代：

| scheduler-inbox 现实现 | 统一后 |
|---|---|
| 内存行积累（lines/notices/emergency Map） | system 消息即时落 `DM: scheduler`（meta.urgent / meta.eventType 标注）；**事件先持久化再聚合**（比现状更强：crash 不丢积压） |
| 静默 5min 计时器 / 紧急立即 flush | 保留（`run/scheduler-digest.ts`，吸收原文件）：计时器作用于「调度者 DM 的未读消息」 |
| digest 渲染（现查状态列 + ⚠ 标注 + 20 行上限 + 统计行） | 保留原文格式：flush = 渲染未读消息 + 现查状态快照 → steer → **渲染结果作为 kind=recap 消息存回频道** → 游标推进 |
| `scheduler_inbox_digests` 表 | **删除**（schema v16 drop）——recap 消息即投递历史，事件流与 recap 并排呈现（Slack bot 摘要式） |
| W3 isPaused 门控 / hold（deliveryPaused）/ close 清理 / 恢复 catch-up | 保留，gate 对象改为 digest 策略的 flush |
| 收件箱实时快照 `GET /api/events/:id/inbox` | 改为频道视图：未读消息 + 计时器状态（语义不变，数据源换） |
| 停滞 watchdog（noteAgentIdle → 2min 计时 → 紧急行） | 检测机械保留，输出改为 urgent 消息入调度者 DM |
| 部分解出 steer（partial-flag） | system 消息 → 各 live run 的 `#team`（team 投递 = steer 全部 live 成员，**行为严格等价**）+ 调度者 DM 通知 |
| 完全解出清场通知 / 队列 pause-resume / starved 边沿 / 启动失败 | 对应 notice / urgent 消息，分级不变 |

`EventScopeEmitter` 保留为事件源；内建唤醒接线（`attachSchedulerWakeup`）改为向调度者 DM 发 system 消息（经 digest 策略），不再直连 inbox 行存储。

## 四、SDK 推广到 solver 容器

沿 scheduler-python-sdk 的收敛先例（能力 = 程序化 API，不新增原生工具）：

- **挂载**：challenge 容器同享 SDK 只读挂载（`/opt/aegisx-sdk` + `PYTHONPATH` + `AEGISX_API_URL` + `AEGISX_EVENT_ID` + `AEGISX_ROLE=solver`），**不挂 `/runs:ro`**（solver 不看其他 run 工作区，缩小注入面）。
- **身份**：一个 run 的 N 个 solver 共享容器，容器级 env 放不了 per-agent 身份——**bash 工具 per-agent session 创建**，`manager.exec` 扩展 per-call env，注入 `AEGISX_AGENT_ID` / `AEGISX_RUN_ID`。同一容器内不同 solver 的 exec 天然区分；SDK 用它定位「我的频道」。
- **API 面**（solver 角色）：

```python
aegisx.channels.list()                       # 我的频道（#team/#announce/我的 DM/DM scheduler）+ 未读数
aegisx.channels.read(channel, after=None, limit=50, mark_read=True)  # pull 即已读
aegisx.channels.post("#team", text, tags=None, files=None)
                                             # files: workspace 相对路径列表 → 服务端快照拷贝为附件（§2.5）
aegisx.ask(text, urgent=False, files=None)   # → DM: scheduler（urgent=True 立即 flush）
aegisx.channels.fetch(file_id, dest=None)    # 附件物化到本 agent workspace（默认 /workspace/inbox/）
```

- **角色门禁**（客户端）：`AEGISX_ROLE=solver` 时管理命名空间（queue/runs 写操作/agents.add…）直接 raise `AegisxError("forbidden")`——挡「意外误用」；「故意绕过」（bash+curl 直打 API）维持已接受边界（scheduler-python-sdk.md §四）。
- 调度者 SDK 增 `channels.announce(run_id, text)` / `channels.read(...)`（其可见面 = 全 event 频道）。

**边界记录**：共享容器内进程理论上可读彼此 `/proc/*/environ`（per-exec env 非私密）——同 run solver 本就共享 workspace，无密可泄，接受。

## 五、HTTP / SSE / UI

### 5.1 端点

| 端点 | 用途 |
|---|---|
| `GET /api/runs/:runId/channels` | 该 run 的频道树 + 各频道元信息（UI 渲染用） |
| `GET /api/channels/:channelId/messages?after=&limit=` | 时间线（分页，`after` = 全局消息 id 游标） |
| `POST /api/channels/:channelId/messages` | 用户发帖（multipart：`text` + `files[]`）——走同一投递策略（发 #team = 广播 steer；发 DM: scheduler = 立即 flush） |
| `GET /api/channel-files/:fileId` | 附件下载/预览 |
| `GET /api/events/:eventId/inbox` | 改造：频道视图（调度者 DM 未读 + digest 计时器/hold 状态） |

`POST /api/runs/:id/message` / `POST /api/agents/:agentId/message` / SDK `runs.message`/`agents.message` **保留为薄封装**（发 DM + 记账），UI/SDK 不破坏。SSE 增 `channel.message` 事件（LiveBus 广播，时间线实时更新）。

### 5.2 每 Run IM 界面（第一需求）

run 详情页新增频道栏 + 时间线（§2.1 的树即产品需求）：

```
┌──────────────┬──────────────────────────────────────────┐
│ Run-101      │ #team                                     │
│ ● #announce  │ [Solver 2 · 15:10] 确认 off-by-null，      │
│ ● #team (3)  │   exp 骨架在 exp2.py                        │
│   DM solver-1│ [Solver 3 · 15:12] 死路：格式化字符串不可写  │
│   DM solver-2│ [system · 15:14] ⚠ deadline 剩 9m          │
│   DM solver-3│ ── recap 15:20 ──                          │
│              │ [调度事件摘要 now=15:20:01] …               │
│              │ ├────────────────────────────────────┤    │
│              │ │ 发送到 #team…                     [发送] │    │
└──────────────┴──────────────────────────────────────────┘
```

- 消息样式区分 authorType（system/user/agent 徽章）+ kind=recap（摘要块样式）；系统 steer 注入的合并文本不出现在时间线（时间线只有账本本体——合并渲染是投递态，不是存储态）。
- 输入框 = 用户发帖（所选频道），与 SDK/系统同账本。
- **UI 未读为客户端会话态**（页面加载后的增量），不落库——agent 游标才是功能态，两者不混。
- 调度者 run 详情页：DM: scheduler 时间线 + 收件箱状态头（静默倒计时 / hold 开关，替换原收件箱 tab）；recap 历史即原「投递历史」。
- event 级「全部频道聚合视图」→ 推迟（§八）。

## 六、数据模型（schema v16，additive）

```sql
channels(
  id TEXT PK, scopeType TEXT,        -- "run" | "event"
  runId TEXT NULL, eventId TEXT NULL,
  kind TEXT,                          -- "team" | "announce" | "dm"
  targetAgentId TEXT NULL,            -- DM 目标（kind=dm 必填）
  createdAt TEXT
)  -- 级联：run/event 删除 → channels → messages → reads

channel_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- 全局单调
  channelId TEXT, kind TEXT, authorType TEXT, authorAgentId TEXT NULL,
  authorName TEXT, body TEXT, meta TEXT, createdAt TEXT
)  -- 索引 (channelId, id)

channel_reads(
  channelId TEXT, agentId TEXT, lastReadMsgId INTEGER, updatedAt TEXT,
  PRIMARY KEY (channelId, agentId)
)

channel_files(
  id TEXT PK, messageId INTEGER, channelId TEXT,
  filename TEXT, size INTEGER, createdAt TEXT
)  -- 存储路径派生 data/channel-files/<channelId>/<messageId>/<filename>；随消息级联删除

DROP TABLE scheduler_inbox_digests       -- recap 消息取代（历史数据不迁，本地可弃）
```

SCHEMA_VERSION 15→16；**不 wipe**（纯 additive + drop 一张投递历史表）。run 创建时建 `#team` + `#announce` + 每 solver DM；event 域建调度者 DM；`add_agent` 增建 DM。

## 七、全量映射清单（「把现在所有的都统一」）

| 现有机制 | 统一后 |
|---|---|
| `agents.message` / `runs.message`（HTTP/SDK） | DM 发帖（端点保留薄封装） |
| scheduler-inbox 全部（§三表） | 调度者 DM + digest 策略 |
| 部分解出 steer / 完全解出通知 / 队列通知 | system 消息（#team / DM: scheduler，分级不变） |
| `SOLVER-<n>.md` 协作约定 | `#team` 开局发角度声明——从「模型自觉读文件」变「机械保证必见」 |
| ask_scheduler（field-findings P1 项） | `aegisx.ask` → DM: scheduler（顺手吸收 P1 这项） |
| `/shared` + `post_note` + `read_run_file`（field-findings P1 共享方向） | **取消/覆盖**：#team post + 附件（§2.5）取代 post_note 与 `/shared`；read_run_file 已由 `/runs:ro` 覆盖；跨 run handoff = 调度者中转模式 |
| wind-down steer（field-findings P1，未来） | system 消息 → `#team`，零新增机械 |
| 收件箱 UI tab / digests 历史 | 频道时间线 + recap 消息 |
| session entries（对话本体） | **不变**——频道是通信账本，不是对话存储 |

## 八、明确不做 / 推迟

| 项 | 理由 |
|---|---|
| ride-along 注入层（fresh turn 捎带未读） | 用户拍板直接 steer——消息不多、findings 有时效性；该层是逃生舱（若实赛证明 #team 吵，降级为注入式，机械在投递引擎内，非新通道） |
| solver 间 DM / 跨 run solver 直连 | 星型拓扑维持：跨 run 经调度者中转（ask → 决策 → DM） |
| `/shared` 工件层 | **取消**（用户：消息可携带附件后不再需要）——跨 run 工件经调度者中转（`/runs:ro` 读 → 摘要+附件转发新 run DM）；超大产物（libc dump/wordlist）留 workspace 引用路径 |
| event 级全频道聚合视图 | 每 run IM + 调度者 DM 已覆盖主场景 |
| solver post 限流 | prompt 纪律（「发 findings 不是流水账」）先行；实证吵再加 |
| API token 鉴权 | 维持已接受边界（scheduler-python-sdk.md §六） |

## 九、实施阶段

| Phase | 内容 | 验证 |
|---|---|---|
| **P1 schema + 频道核心** | v16 迁移；`run/channels.ts`（建频道/发帖/附件拷贝/游标/deliver 引擎：批量合并、8K 上限、已读跳过、自发帖过滤）；run 创建/add_agent 建频道 | deliver 三态（streaming steer / idle 新轮 / closed 跳过）；已读三点推进；合并文本渲染（含 📎 行）；DM 冷恢复唤醒；附件快照拷贝 + 路径校验 + fetch 物化 |
| **P2 调度者统一** | 事件/队列/停滞/清场 → system 消息；`scheduler-digest.ts`（吸收 inbox：静默/紧急/hold/paused/catch-up）；recap 存回；drop `scheduler_inbox_digests`；移植现有收件箱全部测试语义 | 紧急立即 flush 捎带积压；静默 5min；2→1 边沿一次；paused 静默；hold 补投；crash 后未读不丢（消息已持久化） |
| **P3 solver SDK + prompt** | challenge 容器挂 SDK（ROLE/无 /runs）；exec per-call env（AGENT_ID/RUN_ID）；`channels.{list,read,post,fetch}` + `ask`（含 files 参数）+ 角色门禁；mainSystem 协作段→Channels 段（教附件惯例：发 finding/flag 附 exp/poc）+ Boundaries 扩展（LEGACY 链刷新）；orchestratorSystem 教 announce/DM 分工（FYI→#announce，行动→DM） | solver 容器 `import aegisx` + post/ask（含附件）全链路；管理命名空间 forbidden；partial-flag 走 #team 的行为 parity |
| **P4 HTTP + UI** | 频道端点（multipart 发帖）+ 附件下载 + SSE `channel.message`；run 详情频道树 + 时间线 + 输入框 + 附件上传/展示/下载；调度者 DM 视图 + 状态头 | 手动全链路：用户发 #team（带附件）→ live solver 收 steer + fetch 物化；UI 时间线与账本一致 |
| **P5 收尾** | `bun run check` / `test` / `build` 全绿；文档转正 + superseded 标注 | 全绿 |

## 十、已定决策记录

1. **投递即 steer**（用户：run 内 solver 消息不太多、findings 有时效性）——不做 ride-along 注入层。
2. **调度者收件箱并入 IM**（用户）：digest = 调度者 DM 的投递策略；`scheduler_inbox_digests` 删除，**recap 作为消息存回频道**（历史自包含，用户接受推荐）。
3. **solver 容器挂 SDK**（用户）：消息能力走 SDK（post/read/ask），投递由系统 steer；**已读机制去重**——已读则不再重复 steer。
4. 每 run **IM 界面为第一需求**（本轮新增拍板）：频道树 + 时间线 + 用户输入。
5. `runs.message` 保持 DM entry 语义（薄封装）；UI 频道输入框另给。
6. SDK 角色门禁做（客户端 raise forbidden）；故意绕过维持已接受 curl 边界。
7. solver 间无 DM（用户：无指派/聊天必要）；DM 由调度者/用户/系统使用。
8. `/shared` 工件层**取消**（用户补充拍板：消息可携带附件后，其余文件共享不需要）——跨 run 工件经调度者中转，大产物留 workspace 引用。
9. per-exec env 注入身份（`AEGISX_AGENT_ID`）解共享容器问题；env 可见性边界接受并记录。
10. UI 未读为客户端会话态，不落库；agent 游标才是功能态。
11. **消息可携带附件**（用户：发 finding/拿 flag 时附 exp/poc）：快照拷贝语义（发帖即定格）；agent 发送 = workspace 路径经服务端校验拷贝，agent 读取 = fetch 物化回 workspace（容器边界不破）；上限 = 单文件 64MB / 单消息 8 个 128MB（代码常量）；steer 文本只渲染 📎 元数据行，内容靠 fetch。

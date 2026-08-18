# v19 模型：题中心（Challenge-centric）— 去 Run 层

状态：**设计已拍板，待实施**（2026-08-18 讨论定稿）
前置：[im-simplify-v18.md](im-simplify-v18.md)（派生键频道）、[ux-review-2026-08-18.md](ux-review-2026-08-18.md)（交互层走查，本模型是其第二刀的前提）
取代：Run 作为一等实体的一切语义（v1–v18 的 `Event → Challenge → Run → Agent → Session`）

---

## 一、动机

Run 层在 v17/v18 两轮演进后已退化为无意义的中间层：

1. **频道已经投过票**：v17 把 #team 从 run 级提升到题目级，同题跨 run 共享；消息署名还要专门发明「run 短 id」来补上下文——身份锚本来就在题目上。
2. **run id 对所有消费者都是噪音**：人不记 `run-a3f1`，调度者 SDK 也在为 run id 缩写打补丁。心智模型是「题 X 的第 N 次尝试」，不是「run」。
3. **run 的隐形职责全是可下放的**：容器生命周期→题级；工作区→题级目录树；超时→agent 级；并发围栏→数 agent；队列项→「给题派一个 agent」；重试→「再 spawn 一个 agent」。run-factory 的 challenge/event 双分叉、scopeType 分支、finishing 原子标志（为「多 solver 谁负责 teardown」而生）全部消失。

与 v18 的对称断言：**v18 说「频道 = 派生键，事件 = 消息」；v19 说「工作区 = 派生路径，容器 = 惰性资源，执行 = agent」**。

## 二、模型定义

```
Event
 ├─ Challenge（作战单元：身份、频道、flag、队列、进度）
 │   └─ Workspace（派生路径 + 惰性容器，无表）
 │       └─ Agent ×N（执行单元：自己的目录、deadline、session、对话流）
 │           └─ Session ×N
 └─ Scheduler（虚拟题：无 challenges 表行，固定派生路径）
     └─ Workspace
         └─ Agent ×1（role=orchestrator）
```

### 2.1 Workspace = 派生路径（不落库）

| 项 | 规则 |
| --- | --- |
| 题工作区 | `data/events/<eventId>/challenges/<challengeId>/workspace/` |
| 调度者工作区 | `data/events/<eventId>/orchestrator/workspace/` |
| sessions / runtime | 同级的 `sessions/`、`runtime/` 目录 |
| 容器配置 | 全局设置（container.*），起容器时读取；不快照到任何行 |
| 容器运行态 | container-manager 内存 |
| lastActiveAt | 派生：`max(agents.updatedAt)` |

工作区内部布局（题）：

```
workspace/                 # 容器 bind → /workspace
├── agents/<agentId8>/     # 每次尝试一个目录；该 agent 的 host 文件工具 root；bash cwd
├── shared/                # 服务端写入；agent 只读（约定）：频道附件转发物、用户上传
└── attachments/           # 题目附件一次性物化（重试不再重复拷贝）
```

调度者工作区无子目录结构，agent 直接在根目录工作（STRATEGY.md / STATE.md / scheduler_lib.py）。

目录隔离是**协作约定不是安全边界**：bash 在容器内对整个 /workspace 可见（单用户本地工具）；host 文件工具（read/write/edit）的 root 锁定在 `agents/<自己>`，shared/attachments/同事目录经由 bash 访问。

### 2.2 Agent = 执行单元

agents 表重构（`runId` → `challengeId` 可空 + 冗余 `eventId`）：

- 一次尝试 = 一个 agent；重试/并行 = 再 spawn；「尝试历史」= 按 createdAt 排序的题内 agent 列表。**「代」的概念由平铺 agent + 目录持久免费给出，无专门机制。**
- 删除列：`slot`、`isEntry`、`parentAgentId`、`task`（spawn child 遗产）、runs 表全部继承列。
- 新增列：`eventId`（NOT NULL，加速 fleet/usage/flush 查询）、`prompt`（spawn 提示词，重跑复用）、`source`、`timeoutMs`、`deadlineAt`、`lastTimeoutAt`、`summary`（finish_run 结果）。
- 约束：每 event 至多一个 orchestrator agent（partial unique index on eventId where role='orchestrator'）。

### 2.3 状态与生命周期

Agent 状态机不变（running | idle | completed | aborted | failed），语义重锚：

| 动作 | 语义 |
| --- | --- |
| spawn | 建 agent 行 + 惰性起题容器（不存在时）+ prime initial prompt |
| finish_run(summary) | **agent 自我终结**：turn settle 时 → completed + summary。无 run 级原子标志——各 agent 独立收尾 |
| timeout | agent 级 deadline：abort 该 agent 的 turn → 30s grace → 温和 settle（idle）或强 abort（aborted）。**永不杀共享容器** |
| close（用户/调度者） | → aborted（terminal）；文件与 session 保留 |
| 发消息给 terminal agent | 重开：status → idle，容器按需重建（host 目录原样），session 保留 |
| 完全解出清场 | 停同题全部 live agent（abort→aborted）+ 取消该题 pending 队列项 + 靶机 orphan 停止 |

**容器生命周期（题）**：惰性起（首个 agent spawn）＋ 兜底回收（该题无 live agent 持续 10min → remove；任何新 live agent 取消计时）。terminal agent 的文件在 host 持久，容器删除不删 workspace。

**容器生命周期（调度者）**：随调度者 agent 的启停管理（用户拍板）——start → 建；pause → abort turn、容器保温；close/reset → remove。

**冷重启**：boot recovery 移除全部已知容器，running agent → idle；terminal 状态保留。与现状语义一致（重开按需重建容器）。

### 2.4 并发围栏

- 全局：live solver agent（running|idle 且 challengeId 非空）数 ≤ `scheduler.maxConcurrentAgents`（新 setting key，替代 maxConcurrentRuns；调度者 agent 永不计数）。
- 每事件 target 槽位上限：逻辑不变，锚点从「有 live run 的题」改为「有 live agent 的题」。
- **不设每题 agent 上限**（用户拍板）；并行多攻 = 多个 spawn / 多个队列项。

### 2.5 队列

`run_queue` → `spawn_queue`。队列项 = 「在题 X 上 spawn 一个 agent」：

- `params` = `{model?, prompt?, promptMode?, timeoutMs?}`；`agentId` 回填（launch 后）。
- **upsert-by-challenge 取消**：恒 append（一题可多个 pending 项——并行尝试是合法计划）。完全解出时取消该题全部 pending。
- starved 边沿（pending 2→1 紧急通知）、pause/resume、reorder/clear、drainer 失败→failed+紧急通知：全部保留。
- 「直接启动旁路」= spawn（fence 满即报错）；「排队」= enqueue。

## 三、频道与附件（shared/ 机制）

频道宇宙与派生键**不变**：`team:<challengeId>` / `dm:<agentId>` / `orch:<eventId>`，urgent/tick 投递、digest、停滞 watchdog 语义不变。变化：

1. **署名**：run 短 id → agent 代名（`agent-a3f1`）；`ChannelMessageMeta.runId` → `agentId`。
2. **deliveryKeys 简化**：solver = `team:<自己的 challengeId>` + `dm:<自己>`（直查 agent 行，无 run 间接层）；调度者 = `orch:<eventId>`。
3. **附件体系替换（用户拍板）**：`channel_files` 表、post-time 快照拷贝、`/api/channel-files/:id`、SDK `fetch()` **全部删除**。替代机制：
   - agent 发频道消息带 `files=["exp.py"]`（相对自己工作目录）→ 服务端解析（root=agent 目录，越界拒绝）→ **复制到本题 `workspace/shared/from-<agentId8>/<filename>`** → 消息 meta 记录 shared 相对路径 + 大小。路径转换：读者拿到的是 `/workspace/shared/...` 可直接访问的路径。
   - 同题 agent：同一容器，直接读 `/workspace/shared/...`。
   - 调度者：容器挂载 `data/events/<eid>/challenges:/challenges:ro`，读 `/challenges/<cid>/workspace/shared/...`（取代旧的 `/runs` 挂载）。
   - 用户 UI 发附件（multipart）→ 同样落 `shared/upload-<ts>/<filename>`，全题可见。
   - shared/ 只读是**提示词约定**（host 文件工具 root=agent 目录天然强制；bash 可写但提示词禁止）。
4. 题目频道树：`team` + 该题全部 agent 的 `dm`（UI 频道 tab / SDK list 的题视图）。

## 四、事件与观测

- `EventScopePayload`：`run.*` → `agent.*`（started / idle / finished / timedOut / flagAccepted / reopened）。orch 系统消息 tag = `「题名」agent-a3f1`；urgent 表不变（timedOut、starved、launch 失败、停滞、urgent ask）。
- LiveBus 通道键：`agentId`（agent SSE 流）+ `eventId`（事件流：agent 状态 + orch/team 频道消息）+ `challengeId`（题目 IM SSE）。
- fleet 端点：`GET /api/events/:id/fleet` → `{challenges, agentsByChallenge, schedulerAgent, config, status}`（runs + agentsByRun 双层结构消失）。
- 停滞 watchdog：per-agent（idle settle 后 2min 现查），少一层 run 间接。

## 五、Schema diff（v18 号迁移，破坏性，旧数据弃置）

```
删除表: runs, channel_files
重建表: agents（eventId NOT NULL, challengeId NULL=orchestrator, role, name, model,
        systemPrompt, tools, toolDefinitions, status, sessionFile, prompt, source,
        timeoutMs, deadlineAt, lastTimeoutAt, error, summary, createdAt/startedAt/
        updatedAt/completedAt；partial unique: 每 event 一个 orchestrator）
重建表: run_queue → spawn_queue（去 challengeId PK 约束，append 语义；agentId 回填）
改列:   session_entries 去 runId（agentId 已有）；challenge_flags.runId → agentId（text 无 FK）
        channel_messages.meta: runId → agentId
setting: scheduler.maxConcurrentRuns → scheduler.maxConcurrentAgents
SCHEMA_VERSION: v17 → v18
```

不做数据迁移（用户拍板：本地工具，历史弃置）；迁移 0013 为纯破坏性 DDL，附迁移测试。

## 六、API 变化（概览）

| 旧 | 新 |
| --- | --- |
| `POST /api/challenges/:id/runs`（enqueue） | `POST /api/events/:id/queue`（enqueue spawn 项） |
| `POST /api/runs/start` | `POST /api/challenges/:id/agents`（直接 spawn，fence 满报错） |
| `GET /api/runs/:id` / `.../messages` / `.../stream` / `.../files` / `.../queue` / `.../stop` / `.../close` / `.../timeout` / `.../flag` / `.../finish` / `.../target` | 对应 `GET|POST /api/agents/:agentId/...`（stop/close/timeout/flag/finish）与 `GET /api/challenges/:id/files`（题工作区树） |
| `POST /api/runs/:id/agents`（add solver） | 删（spawn 覆盖） |
| `POST /api/runs/:runId/switch-model` | `POST /api/agents/:id/model`（已有） |
| `GET /api/runs/:id/channels` | `GET /api/challenges/:id/channels`（team + 题内 dm） |
| `GET /api/channel-files/:fileId` | 删（shared/ 机制取代） |
| `GET /api/events/:id/fleet` | 形状换（§四） |
| scheduler start/pause/resume/close | 语义不变，锚 schedulerAgent |

wire 类型：`RunPublic`/`RunDetail`/`SolverSpec` 删；`AgentSummary` 扩展（challengeId/challengeName/deadlineAt/source/summary/usage…）；`FleetInfo` 换形状。

## 七、SDK（Python）

- `runs.*` 拆并入：`agents.list(challenge_id?)` / `agents.get` / `agents.start(challenge_id, prompt, model, timeout_ms)`（旁路）/ `agents.stop/close/read/set_timeout`；`agents.message` 已有。
- `queue.enqueue(challenge_id, prompt=..., model=..., timeout_ms=...)`——`strategy/solver_count/solvers` 参数死。
- `channels.announce(challenge_id)`（不再经 run 查 team key）；`channels.fetch` 删。
- `snapshot()`：fleet 新形状；`runs_by` → `agents_by_challenge`；`scheduler_run` → `scheduler_agent`。

## 八、提示词模板

- `initial`：Environment 段重写——你的工作目录 `/workspace/agents/<你>`（bash 落点、文件工具作用域）；附件 `/workspace/attachments/`（只读）；共享 `/workspace/shared/`（只读，服务端写入，同事产出与转发件出现在这里）；同事目录 `/workspace/agents/` 平级（可读）；`finish_run` = 结束你自己的任务。Strategy 段保留（spawn prompt 追加）。
- `orchestratorSystem`：runs→agents 全部措辞；`solver_count`/`solvers` 参数删；spawn/queue 表述；`/runs/<runId>/workspace` 挂载 → `/challenges/<challengeId>/workspace`（ro）；`announce(challenge_id)`；「给题加人手」= 再 spawn（并行多攻同一题）。
- `schedulerInitial`：措辞跟随。
- `mainSystem`：workspace 措辞检查。

## 九、UI 适配范围（本轮**不做新界面**，只改现有界面适应新模型）

用户拍板：不做作战页/新路由，保持现有页面形态（首页/事件页 4 tab/设置页/AgentDialog modal），全部概念从 run 换到 agent/challenge：

- 创建任务对话框 → spawn 对话框（题目+模型+提示词+超时+直接/队列；solver 数与逐 solver 高级删）。
- AgentDialog：直接以 agentId 打开；频道 tab = 题目频道树；文件 tab = 题工作区（agents/ shared/ attachments/ 可见）；概览 = agent 信息 + 题容器状态 + 同题 agent 花名册。
- AgentsGraph：事件→题→agent 三层（run 节点层删）。
- AgentsTab/EventSummary/TimelineTab/QueueList/SchedulerDM/ChallengeIM：类型与数据源跟随；EventSummary 的 fleet N+1 顺带修复（同一形状变更内完成）。
- Conversation：单 agent（多 agent tabs 删）；`/close` = 关闭该 agent。

## 十、明确不做

- 不做每题 agent 上限、不做 setup.sh、不做 PLAYBOOK 自动物化、不做新 UI 形态、不做旧数据迁移、不做 run 兼容层。
- 事件级跨题共享目录仍不做（方法论经频道分发）。

## 十一、删除清单（实现侧）

`runs` 表及其全部查询、`run-factory.ts` 的双 scope 分叉、`finishing` 原子标志、`scopeType` 分支（routes/UI/SDK）、`slot`/`isEntry`/`parentAgentId`、`runChannelTree`、`channel_files` 全链、SDK `runs.py`/`fetch`、web `api/runs.ts` 的 run 语义、`runShortId` 机制、`maxConcurrentRuns` 设置键。

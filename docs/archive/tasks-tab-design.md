# 任务 Tab 设计：题中心作战视图

状态：**已实施**（2026-08-18，纯 web 批次，零服务端改动）
前置：[model-v19-challenge-centric.md](model-v19-challenge-centric.md)（题中心模型；本 tab 建于 v19 形状之上，服务端无需任何改动）
关系：与 Agents tab **并行**，本轮不碰 Agents / agents-graph / AgentDialog（它们留待后续收敛）。本 tab 是纯 web 增量批次。

---

## 一、定位

事件页加第 5 个 tab「任务」（路由 `/events/:eventId/tasks`），落地仍默认「概览」。把 AgentDialog 的内脏（对话/频道/文件/概览）从 modal 搬进常驻 pane，并以题为单位组织——左侧选目标，右侧看详情。对话 tab 内再嵌 agent 选择器，把"盯哪个 agent"也纳入同一屏。

不替代 Agents tab；两者并存，数据源（fleet/queue/event-detail）共享缓存。

## 二、布局

```
┌──────────────┬──────────────────────────────────────────────┐
│ 调度者  ●运行 │  [概览][对话][频道][文件](+[配置] 调度者)    │
│ ── 活跃 ──   │ ┌──────────────────────────────────────────┐ │
│ ● pwn/shell  │ │                                          │ │
│   2 活·剩12m │ │         (tab content)                    │ │
│ ● crypto/x   │ │  对话: [agent list │ timeline+composer]  │ │
│   1 活·排队中 │ │                                          │ │
│ ── 沉默 ──   │ └──────────────────────────────────────────┘ │
│   rev/heap ✓ │                                              │
│   web/cookie │  (筛选框在左列顶部)                           │
└──────────────┴──────────────────────────────────────────────┘
```

左列 ~280px 固定；右侧填满 `h-[calc(100svh-5.5rem)]`。对话 tab 内 agent 列表 ~200px。

## 三、左列

三段，顺序固定：

1. **调度者**（置顶单行）：状态点（运行/暂停/未启动）+ 模型短名。点击 → `?c=orch`。无控制按钮。
2. **活跃组**：`liveAgentCount > 0` 或 `pendingCount > 0` 的题。按最近活动倒序。
3. **沉默组**：其余。按最近活动倒序（从没碰过的自然沉底）。

行（两行、~44px）：

```
[●] pwn/shell               2 活跃
    3 尝试 · 剩 12m · ✓
```

- 状态点：绿=有 running agent；琥珀=全 idle；灰=无 agent
- 第二行：尝试次数 · deadline 倒计时（live agent 的 min deadlineAt；<10min 琥珀、<5min 红；无 live 则空）· 解出（✓ 或多 flag `2/3`）· `排队中` 徽标（有 pending 项）· `⚠ 2m`（某 live agent idle 超 2min，客户端从 updatedAt 算）
- 调度者行：`● 调度者` + 模型 + `运行中/暂停/未启动`

顶部文本筛选框（题名/分类），筛选当前可见组。100+ 题不虚拟化，滚动足够。

## 四、右侧 pane

**题目变体 tabs**：概览 / 对话 / 频道 / 文件
**调度者变体 tabs**：概览 / 对话 / 频道 / 文件 / 配置

tab 状态组件内 `useState`，c 变化时重置为概览。

### 4.1 概览（题）

- 头：题名 + 分类 + 分值 + 描述（可折叠 markdown）
- flag 状态条：accepted 数 / partial（多 flag `2/3`）。只读展示，完整 CRUD 留在题目 tab
- **靶机面板**：复用 `TargetPanel`（v19 P3 已抽到 `features/runs/target-panel.tsx`，签名 `({challengeId})`）
- **agent 花名册**：按尝试序——行：状态点 + 短 id + 模型短名 + 创建时间 + deadline/剩余 + summary 一行。点击 → 切到对话 tab 并选中该 agent
- 动作：「新尝试」（spawn，预填本题）+「入队」
- 工作区/容器状态行：live agent 数 + 容器运行中/已回收
- 不做题级 usage（无廉价数据源：usage 仅事件级端点 + AgentDetail 级；保持零服务端改动，留作后续可选项）

### 4.2 概览（调度者）

- **调度者控制面板**（仿靶机面板）：状态 + start / pause / resume / close 四个动作（既有 scheduler API：`startScheduler/pauseScheduler/resumeScheduler/closeScheduler`）。未启动时只显示 start
- 配置摘要（模型 / instruction 片段 / maxTargets）+ 跳转「配置」tab
- orch inbox 摘要（`getInbox`：未读数 + deliveryPaused）——轻量，可选
- 不做 usage（同 4.1）

### 4.3 对话（题）

```
┌─────────────┬──────────────────────────────┐
│ ● a3f1 运行 │                              │
│ ● b7e2 ✓完 │      Timeline                │
│ ○ c1d0 ✗败 │                              │
│─────────────│──────────────────────────────│
│ ＋ 新尝试    │  composer(steer/stop/模型)   │
└─────────────┴──────────────────────────────┘
```

- agent 列表源：`fleet.agentsByChallenge[c]`，按 createdAt 升序（尝试 1/2/3…），live 优先置顶、terminal 置灰沉底；或纯时间序——本设计取**时间序 + terminal 置灰**（历史可读）
- 行：状态图标 + 短 id + 模型短名 + 活动距今
- 默认选中：最新 live agent；无 live 则最新 terminal；都没有 → 空态 + spawn CTA
- 底部「＋ 新尝试」→ 打开 spawn 对话框（预填本题）；成功响应带 agentId → 失效 fleet + 设 `?a=新id` + 留对话 tab
- 「仅活跃」筛选 chip（默认关）
- Conversation 组件传单 agent 复用（v19 后即单 agent 形态）；切 agent 重挂载、SSE 按 agentId——与 AgentDialog 行为一致
- 调度者选中时整个列表隐藏（单 agent）

### 4.4 频道

题变体：`ChannelsView({challengeId})`（v19 后签名已按 challengeId 直取，内部自带频道树 + 未读点 + composer）。
调度者变体：**复用 `SchedulerDmTab({eventId, active})`**（orch 收件箱 + 时间线 + composer 现成组件；`ChannelsView` 不支持 orch 键）。

### 4.5 文件

`FilesWorkspace` 适配题工作区 API（agents/ shared/ attachments/ 树一目了然）。调度者变体：v19 无 orchestrator 工作区文件端点（仅 `/api/challenges/:id/files`），显示占位说明（与 AgentDialog 行为一致）；待后续服务端批次补齐后再接。

### 4.6 配置（仅调度者）

复用 `SchedulerConfigTab`（instruction / 模型 / maxTargets 编辑）。

## 五、选择与路由

`/events/:eventId/tasks?c=<challengeId|orch>&a=<agentId>`

- c 为真实题 id → 题变体；c=orch → 调度者变体
- c 变化时清 a，对话 tab 重算默认 agent
- a 仅在对话 tab 有意义；切 tab 不丢 a
- 刷新不丢、可分享、可双开浏览器 tab 盯两个题（monitor grid 的廉价代偿）
- 无 c → 右侧空态「从左侧选择一项」，不自动选（避免跳动）

## 六、数据流

零服务端改动。三个已缓存 query 客户端拼装：

| 数据 | query | 来源 |
| --- | --- | --- |
| agents（live/terminal、updatedAt、deadlineAt） | `keys.agents.fleet(eventId)` | v19 fleet 端点 |
| pending 队列项（按 challengeId 聚合计数） | `keys.scheduler.queue(eventId)` | 既有 |
| 题元信息 / 解出状态 / flag 摘要 | `keys.events.detail(eventId)` | 既有（题目 tab 同源） |
| 选中 agent 对话 | `keys.agents.detail/messages(agentId)` + SSE `/api/agents/:id/stream` | v19 agent API |

全部 5s 轮询（fleet/queue/event-detail 均已有），对话 SSE 按 agent。与 Agents tab 共享缓存键，切 tab 不重拉。

## 七、边界与空态

| 场景 | 处理 |
| --- | --- |
| 选中题被删 | 清 selection，回空态 |
| 选中 agent 进 terminal | 列表行变灰、保持选中（可回看，发消息即重开） |
| 题无 agent | 对话空态 + spawn CTA；概览/频道/文件照常 |
| 调度者未启动 | 左列行灰态；Overview 给 start 按钮 |
| 无选中 | 右侧「从左侧选择」空态 |
| live agent idle>2min | 行内 `⚠ 2m` 提示（轻量，不做告警系统） |

## 八、明确不做（本轮范围守卫）

- 不碰 Agents tab / agents-graph / AgentDialog（行为不变）
- 不做事件级 SSE（fleet 仍轮询）
- 不做 monitor grid / 键盘导航 / 命令面板 / 频道未读徽标
- 不做每题 agent 上限、不做资源隔离强化
- 不从旧 tab（timeline/queue）做交叉深链（旧 tab 不改）

## 九、对 v19 的依赖

- `AgentSummary` 须含 `deadlineAt / updatedAt / status / challengeId / role`（v19 P0 已定）
- `fleet.agentsByChallenge` + `fleet.schedulerAgent`（v19 P0 已定）
- agent API：`/api/agents/:id/(detail|messages|stream|stop|close|timeout|model|compact|sessions|backtrack)` + `/api/challenges/:id/(files|channels|agents|target)` + spawn/enqueue（v19 P1 路由）
- `TargetPanel` 抽到独立文件（v19 P3 agent-overview 改造时顺手；否则本批次前置小改）

本批次**不改服务端**；仅上述前端可用的 v19 形状须先就位。

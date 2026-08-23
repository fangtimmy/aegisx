# 任务 Tab 实施计划

状态：**已实施**。设计依据：[tasks-tab-design.md](tasks-tab-design.md)（先读）。
前置：v19 P0（shared 类型）+ P1（server: fleet 形状、agent/challenge 路由）+ P3（web api 层：agents/challenges/keys）就位。本批次**纯 web、零服务端改动**。
规则：不碰 Agents tab / agents-graph / AgentDialog（行为不变）；`components/ui/**` 只读；一次性改完再统一检查。

---

## 文件清单

### 新增（`apps/web/src/features/tasks/`）

| 文件 | 职责 |
| --- | --- |
| `tasks-page.tsx` | 外壳：左右两栏布局 + selection（searchParams c/a）+ 数据组装（fleet+queue+event-detail）+ 默认 agent 推导 |
| `task-list.tsx` | 左列：调度者行 + 活跃组 + 沉默组 + 文本筛选 + 行渲染（状态点/计数/deadline/解出/排队/停滞提示） |
| `task-detail.tsx` | 右侧 pane：tab 容器，按 c=orch vs 真实题切变体；tab 状态本地；selection 变化重置概览 |
| `overview-pane.tsx` | 概览 tab：题变体（头/flag/靶机/花名册/动作/usage）+ 调度者变体（控制面板/配置摘要/inbox/usage）。花名册行点击回调 onSelectAgent |
| `conversation-pane.tsx` | 对话 tab 内部：agent 列表（左）+ Conversation（右，单 agent 复用）+ 「新尝试」spawn 入口 + 「仅活跃」筛选 chip |
| `scheduler-control-panel.tsx` | 调度者控制面板（仿 TargetPanel：status + start/pause/resume/close mutation） |

### 复用（不复制）

- `Conversation`（`features/runs/conversation.tsx`，v19 签名：`agent: AgentSummary` + `detail`，单 agent；对话 pane 照抄 AgentDialog 的适配层接线：status 映射 running/idle→idle/terminal→closed、streamPath=`/api/agents/:id/stream`、loadMessages/switchModel/sessionOps/stopAgent/closeAgent/compactAgent）
- `ChannelsView({challengeId})`（题变体频道 tab）
- `SchedulerDmTab({eventId, active})`（调度者变体频道 tab —— orch 收件箱 + 时间线）
- `FilesWorkspace`（`files: FilesApi` adapter：题工作区走 `getChallengeFiles(challengeId, path)`；调度者变体 v19 无工作区端点，占位说明）
- `SchedulerConfigTab`（调度者配置 tab）
- `TargetPanel({challengeId})`（已抽到 `features/runs/target-panel.tsx`）
- `SpawnAgentDialog`（`challenge` prop 预填本题；`onSpawned?: () => void` 无 agent id 回传 —— 见 S5 策略）

### 路由注册（唯一两处对既有文件的触碰）

- `App.tsx`：`eventTabs` 数组加 `"tasks"`（路由 `/events/:eventId/tasks` 随数组自动注册，加载 EventPage）
- `event-page.tsx`：左侧 `TabsList` 加一项「任务」（概览之后、Agents 之前）+ 对应 `TabsPanel` 挂载 `TasksPage`；`tabFromPath`/`pathForTab` 的 tab 联合类型加 `tasks`

不改 Agents tab / agents-graph / AgentDialog / challenge-card / timeline-tab / queue-list 任何行为。

---

## 实施顺序

### S1 外壳与路由（可独立编译）
- 注册路由 + 侧栏项；`tasks-page.tsx` 骨架：读 `useSearchParams` 的 c/a，挂 fleet/queue/event-detail 三个 query，渲染 `<TaskList>` + `<TaskDetail>`
- 空态（无 c）先 stub
- **验证**：`bun run --filter @aegisx/web check` 通过；访问 `/events/:id/tasks` 不崩、空态可见

### S2 左列
- `task-list.tsx`：组装三段分组（scheduler 项 + active + inactive），最近活动倒序，pending 计数合并
- 行渲染：状态点、两行密度、deadline 倒计时配色、解出/排队/停滞标记
- 文本筛选
- 点击 → `setSearchParams({c, a: undefined})`（a 由对话 tab 推导）
- **验证**：肉眼：调度者/活跃/沉默分组正确；筛选可用；100 行滚动不卡

### S3 右侧 pane 容器
- `task-detail.tsx`：按 c=orch vs 真实题选变体；tab 状态本地；c 变 → 重置概览 + 清 a
- tabs 渲染壳；各 tab 内容先占位
- **验证**：切调度者/题 tab 集正确切换；c 变重置

### S4 概览
- `overview-pane.tsx` 题变体：头（events.detail 的题元信息 + 解出/flag 状态）+ `TargetPanel` + 花名册 + 「新尝试」/「入队」。无 usage 段（零服务端改动承诺）
- 花名册行：`onClick → onSelectAgent(agentId)` → 父设 tab=对话 + `?a=`
- 调度者变体：`SchedulerControlPanel`（start/pause/resume/close + `getScheduler` 状态；仿 TargetPanel 模式新写）+ 配置摘要 + `getInbox` 摘要 chip
- **验证**：花名册点击跳对话且 a 正确；靶机/调度者控制动作可用

### S5 对话
- `conversation-pane.tsx`：agent 列表（时间序、terminal 置灰）+ 默认选中推导 + Conversation 复用（适配层照抄 AgentDialog）
- 「新尝试」spawn（`SpawnAgentDialog challenge={题}`）：`onSpawned` → `await invalidate(fleet)` → **清空 `?a`** → 默认推导自动选中最新 live agent（即新 agent，它 running）；留在对话 tab
- 「仅活跃」chip
- 调度者选中隐藏列表，Conversation 直连 schedulerAgent
- **验证**：切 agent 对话流正常、SSE 接通；spawn 后自动盯新 agent

### S6 频道 / 文件 / 配置
- 频道（题）：`ChannelsView({challengeId})`；频道（调度者）：`SchedulerDmTab({eventId, active})`
- 文件：`FilesWorkspace` + `getChallengeFiles(challengeId, path)` adapter；调度者变体占位说明（v19 无 orchestrator 工作区端点）
- 配置：`SchedulerConfigTab` 嵌入
- **验证**：题频道树含 team + dm；调度者频道为 orch 收件箱；文件树含 agents/shared/attachments

---

## 数据与键（无新增）

| 用途 | key | 形状 |
| --- | --- | --- |
| fleet | `keys.agents.fleet(eventId)`（v19） | `{challenges, agentsByChallenge, schedulerAgent, config, status}` |
| queue | `keys.scheduler.queue(eventId)` | pending 项按 challengeId 聚合 |
| 事件详情 | `keys.events.detail(eventId)` | 题元信息/解出/flag 摘要 |
| agent 详情 | `keys.agents.detail(agentId)`（v19） | 单 agent detail |
| agent 消息 | `keys.agents.messages(agentId)`（v19） | per-agent |
| 题工作区文件 | `keys.challenges.files(challengeId, path)`（v19） | 树 |
| 题频道 | `keys.challenges.channels(challengeId)`（v19） | team + dm 树 |

selection：`useSearchParams`；c 变 → 推导默认 a（最新 live / 最新 terminal / none）。

---

## 验证（全批次完成后统一跑）

```
bun run --filter @aegisx/web check   # oxlint --type-check + oxfmt
bun test apps/web                    # 既有测试不回归
bun run build                        # 生产构建
```

手工冒烟（dev 起服后，v19 已可用）：

1. `/events/:id/tasks` 空态正确；左列三段分组与计数正确
2. 选调度者 → Overview 的 start/pause/resume/close 可用；对话=orch DM；文件=调度者工作区
3. 选题 → 概览花名册点击 → 跳对话且选中该 agent；对话 SSE 接通、steer/stop/换模型可用
4. 对话「新尝试」spawn → 新 agent 自动选中、对话流接通
5. 题有 pending 项但无 agent → 左列活跃组带「排队中」徽标；选中后对话空态 + spawn CTA
6. deadline 倒计时配色（<10min 琥珀、<5min 红）；idle>2min 行内 ⚠ 提示
7. 刷新页面 selection 不丢；复制 URL 开新 tab 可盯第二个题
8. Agents tab 与 AgentDialog 行为完全不变（回归对照）

---

## scope 守卫（不要顺手做）

- 不重构 Agents tab / graph / AgentDialog（它们留待后续收敛时再与本 tab 去重）
- 不加事件级 SSE / monitor grid / 键盘导航 / 命令面板 / 未读徽标
- 不从旧 tab 做交叉深链
- spawn 对话框复用 v19 P3 的 SpawnAgentDialog；如该组件接口与本 tab 需求不符，在本 tab 内薄包一层而非改 v19 组件

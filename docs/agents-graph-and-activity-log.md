# Agents Graph 收敛与全局活动日志

状态：**已实施**（2026-08-19）
关系：接续 [tasks-tab-design.md](tasks-tab-design.md)（任务 Tab 是题中心作战视图；本轮把 Agents tab 收敛为纯导航图，时间线职责上移为全局日志）。

---

## 一、目标

1. Agents tab 从「左栏四子 tab + Graph」收敛为**纯 Agents Graph**：Graph 只做一件事——展示 `调度者 → 题目 → agent` 拓扑并把点击导航到任务页。
2. 计划队列从概览 Agents 面板（原「计划」子 tab）挪进**任务 tab 的调度者概览**——队列本就是调度者的产物。
3. 时间线上移为**全局活动日志**：顶栏常驻入口（无未读/红点概念），跨赛事的活动流，点行跳转。
4. 两个已知瑕疵修复：`TargetPanel` 对本地题永远「加载中」；调度者概览底部重复空态。

不动的：概览 tab、题目 tab、`@xyflow/react` / `@dagrejs/dagre` 依赖。

## 二、全局活动日志

### 形态

- 顶栏设置图标左侧的 icon button（`ScrollText`），全页面可见。
- `Popover` 面板（w-96、max-h 滚动）：图标 + 标题 + `赛事 · 题名 · 摘要` + 时间；点行跳转并关面板。
- 无未读计数、无 localStorage 游标——这是日志不是通知。
- 查询仅面板打开时启用，15s 轮询，关闭即停。

### 数据：派生，不存储

不建表、无迁移。`GET /api/activity?limit=N`（默认 100，上限 200）从现有表 union 派生：

| kind | 来源 | 附带 |
|---|---|---|
| `flag` | `challenge_flags` `status='accepted'` | flag 文本 |
| `agentSpawn` | `agents` `createdAt`（手动 + 调度都收——日志记全部活动） | source |
| `agentEnd` | `agents` `completedAt != null` | 终态 + summary/error |
| `timeout` | `agents` `lastTimeoutAt != null` | — |
| `queueFailed` | `spawn_queue` `status='failed'` | error |

各源 `LIMIT 100` 后 merge 排序切片。事件都是「某个时间戳列非空」这一事实的投影，零双写。

不收「题目添加」：批量导入一次刷几十条，会把真事件挤出窗口，且它是配置动作不是运行活动。

### wire 类型

canonical 定义在 `apps/shared/activity.ts`（server 与 web 共同 import）：`ActivityItem { id, kind, time, eventId, eventName, challengeId, challengeName, agentId, agentStatus, summary, flag }`。server 只返回结构化数据，中文文案与图标全在 web 层。

### 跳转映射

- `flag` → `tasks?c=<cid>`（概览）
- `agentSpawn` / `agentEnd` / `timeout` → `tasks?c=<cid>&a=<aid>`（对话）；`challengeId=null`（调度者）→ `c=orch`
- `queueFailed` → `tasks?c=orch`

配合任务页改动：带 `?a=` 进入时初始 tab 落「对话」。

## 三、Agents tab → 纯 Graph

- 删左栏「计划 / 时间线 / 题目 / Agents」四子 tab 与 `PlanPanel`、`EventAgentsPanel` 壳层；Graph 占满。
- 节点点击 = 导航：
  - 调度者节点（含「未启用」占位——启动入口在任务页调度者概览）→ `tasks?c=orch`
  - 题目节点 → `tasks?c=<cid>`
  - agent 节点 → `tasks?c=<cid>&a=<aid>`
  - 归档节点 → 本地展开/收起（保留）
- **删 Graph 右上角启动/暂停/关闭按钮**及其 mutations、`StartSchedulerDialog` 挂载——调度者生命周期控制的唯一入口是任务 tab 的调度者控制面板（启动/暂停/恢复/关闭齐全）。
- `selected` 高亮、viewport 聚焦、选中自动展开归档等交互链路随数据源（左栏列表/时间线/队列）一并删除。

## 四、计划队列进调度者概览

`SchedulerOverview`（任务 tab，`?c=orch` 概览）新增「计划队列」区块：

- 队列状态 badge（运行中/已暂停）+ 暂停/恢复按钮 + `QueueList`（沿用 pending/running/failed 过滤、编辑/移除/排序能力；行点击跳对话）。
- 数据来自 tasks-page 已有的 queue 查询，经 `TaskDetail` 传入，不新增请求。

## 五、瑕疵修复

1. `client.ts` 的 `ApiError` 携带 server 错误 `code`；`TargetPanel` 在 `not_bound`（本地题/未绑平台）时不渲染整个「题目目标」区块。
2. 删 `SchedulerOverview` 底部「调度者未启动」大 Empty——上方控制面板已有状态徽标、启动按钮与说明。

## 六、删除清单

| 文件 | 理由 |
|---|---|
| `web/features/events/timeline-tab.tsx` | 职责并入全局日志 |
| `web/features/events/challenges-tree-tab.tsx` | 题目 tab 的劣化重复 |
| `web/features/events/agents-tab.tsx` | 任务 tab 花名册的重复 |
| `web/features/events/agent-dialog.tsx` | 任务页右侧面板的 dialog 重复版 |
| `web/features/events/challenge-im-dialog.tsx` | 频道 tab 有同款 IM |
| `web/features/events/event-page.tsx` 内 `PlanPanel` / `EventAgentsPanel` 壳层 | 同上 |
| `event-agents-shared.ts` 的 `TimelineEvent` / `TIMELINE_ICONS` | 仅时间线使用 |

`queue-list.tsx` 从 `features/events/` 移到 `features/tasks/`（唯一消费者变为调度者概览）。

## 七、验证

- `bun run check` + `bun run test` 全绿（新增 activity 派生查询的 server 单测：五种 kind 映射、跨源排序、limit 截断）。
- 浏览器走查：顶栏日志面板（含点行跳转）、Agents tab 纯 Graph 导航、调度者概览计划队列、本地题无目标区块。

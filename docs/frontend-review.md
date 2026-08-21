# 前端全面检查报告（2026-08-20）

> **2026-08-21 修复记录（第一轮）**：P0-1、P0-2、P0-3、P1-1、P1-8、P1-9 已修复，各节内有标记。
>
> **2026-08-21 修复记录（第二轮）**：P1-2 ~ P1-7 与 P2 全部 11 项已修复，各节内有标记。至此本报告所有事项闭环。

基于对 `apps/web/src` 全量源码的静态走查（不含只读的 `components/ui/**` coss 组件库，业务代码约 18.6k 行），辅以项目自带检查工具。未启动服务器与浏览器，所有结论来自代码本身。

工具结果：`oxlint --type-check` 0 警告 0 错误；`oxfmt --check` 全部通过；`bun test` 36/36 通过。工具层面非常干净，本报告的问题全部来自人工走查。

## 检查维度

1. 工程与架构（技术栈、目录组织、类型安全、代码分割）
2. UI 视觉与一致性（设计系统纪律、颜色语义、容器语言、暗色模式）
3. 交互与状态设计（加载/空/错误三态、表单反馈、危险操作防护、快捷键）
4. UX 流程（信息架构、动线完整性、实时性、错误恢复）
5. 可访问性（语义化、键盘可达、焦点管理、对比度）
6. 性能（静态启发式：重渲染、轮询、长列表、bundle）
7. 健壮性与安全（竞态、边界、XSS、数据校验）
8. 文案与术语一致性

## 总体评价

这是一个质量显著高于平均水准的前端代码库：类型纪律严格（全库零 `any`、零 `@ts-ignore`）、实时流架构（SSE + stable/tail 快照合并 + rAF 批量通知）设计成熟、a11y 基础扎实（124 处 aria/role 用法、`role="log"`、`aria-live`、sr-only 补充文本）、三态覆盖普遍完整、危险操作普遍有确认。前一轮 `frontend-polish.md` 的容器语言统一已如实施落。

主要短板集中在三处：**若干反馈闭环漏洞**（确认框成功后不关闭、错误态退化为永久加载、静默失败）、**横向一致性**（同一状态在不同视图颜色与措辞冲突）、以及**少量功能性缺陷**（详见下文 P0）。以下问题清单均附代码位置。

---

## P0 · 功能性缺陷（3 项）

### P0-1 SpawnAgentDialog「加入队列」模式在全部外部调用点必然失败

> **状态：已修复（2026-08-21）**。`eventId` 改为 Dialog 必传 prop（消灭 `?? ""` 死路），4 个调用点（challenge-card、overview-pane、conversation-pane ×2）均补传。

`spawn-agent-dialog.tsx:168-171` 队列模式调用 `agentsApi.enqueueSpawn(eventId ?? "", …)`，而 `enqueueSpawn` 拼 URL 为 `/events/${eventId}/queue`（`api/agents.ts:39-42`）。全部 4 个外部调用点都没有传 `eventId`：

- `features/events/challenge-card.tsx:273`（题目卡「启动任务」按钮）
- `features/tasks/overview-pane.tsx:144`（题目概览「新尝试」）
- `features/tasks/conversation-pane.tsx:137` 与 `:173`（对话侧栏「新尝试」/空态）

结果：在这些入口打开的对话框里选择「加入队列」并提交，会 POST `/events//queue` → 404，弹出「入队失败」。直接启动（start 模式）不受影响（走 challengeId）。修法：调用点补传 `eventId`（challenge 所在赛事是隐含已知的），或让 Dialog 在无 `eventId` 时隐藏队列选项。

### P0-2 ChannelComposer 的 Enter 发送没有 IME 组合输入保护

> **状态：已修复（2026-08-21）**。channels-view composer、challenge-flags、steer-queue 三处 onKeyDown 均补上与 agent composer 一致的 `isComposing || keyCode === 229` 保护。

`channels-view.tsx:313-318`：`if (event.key === "Enter" && !event.shiftKey && text.trim())` 直接发送。中文输入法组词时按 Enter 确认候选词，keydown 的 `isComposing === true` 会被这段逻辑当作「发送」，把拼音半成品发进频道。agent composer 已正确处理（`composer.tsx:126`：`if (event.nativeEvent.isComposing || event.keyCode === 229) return`），频道 composer 漏掉了同样的保护。同类问题：

- `challenge-flags.tsx:69` 回车记录 flag——组词确认会提交半截拼音；
- `steer-queue.tsx:111` 队列项编辑回车（影响较小）。

对一个中文为工作语言的单兵平台，这是高频伤害路径。

### P0-3 危险操作确认框在成功后不关闭

> **状态：已修复（2026-08-21）**。全库收敛为「确认即关闭、错误走 toast」：`DangerAction` 改受控 open、确认后立即关闭（三个 mutation 均已有 onError toast，框内错误 Alert 移除）；challenge-dialog「移除目标」同样处理并补 onError toast。

`event-settings.tsx:560-618` `DangerAction`：确认按钮只 `onConfirm()`，AlertDialog 既不受控也不在成功后关闭。「清空题目」「清空运行历史」成功后对话框停留在原地（toast 已提示成功，框内按钮停止 loading），用户不确定操作是否生效。「删除赛事」因成功后路由跳转而掩盖了同一问题。同模式：`challenge-dialog.tsx:389-420`「移除平台目标」内嵌 AlertDialog，确认成功后同样不关闭。

对比正确写法：`queue-list.tsx:225-228`（`mutate` 后 `setRemoving(null)` 立即关闭，错误走 toast）。建议统一为「确认即关闭、错误走 toast」或「成功后关闭」，全库收敛到一种。

---

## P1 · 状态与反馈缺口（9 项）

### P1-1 三处查询失败退化为永久加载 / 静默失败

> **状态：已修复（2026-08-21）**。SchedulerPolicyCard 失败时渲染 `ErrorState`（含重试）；调度收件箱 badge 区分 `inbox.error` 显示「收件箱加载失败」；holdToggle 补 onError toast。

- `event-settings.tsx:309-318` `SchedulerPolicyCard`：`scheduler.data?.config` 为假值时无条件渲染「正在加载调度策略…」spinner。`getScheduler` 请求失败（后端重启、网络断）后没有 error 分支，永远转圈。用户在赛事设置页看到的是死掉的加载态而非错误 + 重试。
- `overview-pane.tsx:331-353` 调度收件箱：badge 只区分 `inbox.data` 有无，`inbox.error` 时永远显示「加载中…」。
- `scheduler-dm-tab.tsx:99-109` `holdToggle`（暂停/恢复投递）没有 `onError`——失败时无任何反馈，按钮状态与服务器实际状态静默漂移（直到下次轮询拉回）。

### P1-2 调度者 DM 时间线强制贴底、无分页

> **状态：已修复（2026-08-21）**。`ChannelTimeline` 从 channels-view 导出（新增 `active` prop 门控轮询与 SSE，隐藏 tab 停流），SchedulerDmTab 改为直接复用它——获得 follow-latest + 前插锚定 + 回最新按钮 + 「加载更早」分页；同时给 ChannelTimeline 补了 `tail.error` 的错误 + 重试分支。

`scheduler-dm-tab.tsx:93-97`：`messages.data` 每次变化（SSE 每条新消息都会 `setQueryData`）都执行 `scrollTop = scrollHeight`。用户上翻阅读历史时会被新消息不断拽回底部。`ChannelsView.ChannelTimeline`（`channels-view.tsx:469-496`）已实现完整的 follow-latest + 前插锚定 + 回最新按钮，DM tab 没有复用。另外 DM tab 只取最新 100 条（`listChannelMessages(channelKey, 0, 100)`），没有「加载更早」入口，更早的调度历史在 UI 上不可达。

### P1-3 同一 AgentStatus 的颜色语义跨视图冲突

> **状态：已修复（2026-08-21）**。以 `statusVariant` 为唯一权威：任务列表圆点 running 改蓝（`bg-info`）、live 非运行改绿（`bg-success`）；调度者状态词汇收敛到新 helper `schedulerStatusLabel`（未启动 > 已暂停 > agentStatusLabel），任务列表、概览 StatCell、调度者控制面板三处共用，颜色同步对齐（running=info、idle=success、暂停=warning）。

- `task-list.tsx:278-282`：任务列表圆点 **running=绿**（`bg-success`）、live 非运行=黄；
- `agent-overview.tsx:3-7` `statusVariant`：徽章体系 **running=蓝**（info）、**idle=绿**（success）。

即「运行中」在任务列表是绿色、在徽章/图表里是蓝色；「空闲」在徽章是绿色、在列表里被并入黄色 live。两套语言同时出现在同一屏（任务列表 + 花名册）。建议以 `statusVariant` 为唯一权威，任务列表圆点对齐。

同一问题波及调度者状态词汇：任务列表用「未启动/已暂停/运行中」（`task-list.tsx:168-172`），概览 StatCell 用 `agentStatusLabel`（`event-summary.tsx:199-206`，输出「空闲/已完成/已关闭/失败」）。一个暂停中的调度者在两处分别显示「已暂停」和「空闲」。

### P1-4 `aborted` 状态术语三处两种叫法

> **状态：已修复（2026-08-21）**。收敛为「已中断」：`agentStatusLabel`（agent-overview，作为唯一标签表）改输出「已中断/已失败」，`agent-status-icon` 删除本地副本改导入共享标签，`agentFinishBadge` 改用 `agentStatusLabel` 取值。

`agent-overview.tsx:13`「已关闭」 vs `event-agents-shared.ts:36`「已中断」 vs `activity-log.tsx:90`「已中断」。同一终止状态在花名册/图表/活动日志里名称不同。

### P1-5 附件上传失败 Alert 不可关闭

> **状态：已修复（2026-08-21）**。Alert 增加 `data-slot="alert-action"` 的关闭按钮（置空 `uploadError`）。

`event-page.tsx:539-545`：`uploadError` 警告条没有 dismiss 动作，只能被「下一次成功且无失败附件的保存」清除（`challenge-dialog.tsx:191-195`）。失败信息应当可手动关闭或随路由离开清除。

### P1-6 AgentConversation 把网络错误显示为「Agent 不存在」

> **状态：已修复（2026-08-21）**。按 `ApiError.code === "not_found"` 分支：404 仍显示「Agent 不存在」；其余错误显示「对话加载失败」+ 具体错误 + 重试按钮（`detail.refetch()`）。

`conversation-pane.tsx:341-352`：`detail.error || !agent` 统一渲染「Agent 不存在…请刷新后重试」，但既没有刷新按钮也没有区分传输错误与 404。断网时所有对话都会变成「Agent 不存在」。

### P1-7 频道消息的附件不可下载

> **状态：已修复（2026-08-21）**。服务端新增 `GET /api/channels/:channelKey/files/download?message=<id>&path=<p>`（按消息 meta 里记录的 path 反解所属题目工作区，不做自由路径读取），`AttachmentChip` 改为下载链接（含下载图标）；flag 列表每行增加一键复制按钮（toast 反馈）。预览 Dialog 未做——下载已满足「拿得到」，工作区文件页已有预览能力。

### P1-8 flag 删除无确认，与附件删除不一致

> **状态：已修复（2026-08-21）**。FlagRow 删除改为 AlertDialog 确认（展示 flag 值 + 不可恢复提示），确认即关闭、错误走 toast，与全库危险操作模式一致。

`challenge-flags.tsx:133-144` 一键删除 flag，无确认；附件删除（`challenge-attachments.tsx:58-97`）和队列项删除都有 AlertDialog。flag 历史是审计线索，删除应至少与附件同级防护（或统一都降为 toast 撤销式，但需全库一致）。

### P1-9 ChallengeDialog 把「描述」设为必填

> **状态：已修复（2026-08-21）**。描述移除 `required` 与校验规则，必填仅保留「名称」。

`challenge-dialog.tsx:244-257`：描述 `rules={{ required: true }}`。但数据模型允许无描述（题目卡渲染「无描述」兜底 `challenge-card.tsx:291`，导入的题目可能没有描述）。编辑一道导入的空描述题目时，被迫先填描述才能改分值/分类。必填应仅保留「名称」。

---

## P2 · 打磨项（11 项）

> **状态：全部已修复（2026-08-21）**，各条目内附实现说明。

1. **Composer 不自动增高**：`composer.tsx:184-199`、`channels-view.tsx:310-323` 都是 `rows={1}` + min/max-h 固定行高，多行草稿在一行高度内滚动，与主流 IM 体验不符。
   > 已修复：新增 `lib/utils.ts#autoSizeTextarea`（height=auto → scrollHeight，CSS min/max-h 仍兜底），两处 composer 在值变化时调用。
2. **主题快捷键 `d` 无修饰键且不可发现**：`theme-provider.tsx:141-179`，任意非输入元素聚焦时按 `d` 即切换明暗主题。用户会在不知情时误触（例如看完对话框按 d 关闭前先触发切换），且设置页外观区也未提及此快捷键。去掉这个快捷键。
   > 已修复：整个 keydown effect 与 `isEditableTarget` 助手移除，主题只经设置页切换。
3. **卡片网格固定 3 列**：`home-page.tsx:244,276`、`event-page.tsx:585`。全宽模式（用户已打开 fullWidth 开关）或超宽屏下赛事卡/题目卡被拉得过宽；可按断点给 4/5 列档位。仅桌面 ≥1024 是明确约束，但宽度上限没有约束。
   > 已修复（二轮修正）：首轮的 `@container` + `min-[1200px]/min-[1700px]` 档位实为**视口媒体查询**（Tailwind v4 容器变体需 `@` 前缀），且 `@container` 标记无子元素使用；在内容区 `max-w-6xl`（1152px 封顶）下，视口 ≥1700 时 5 列挤在 1152px 内，窗口越大卡片越窄。改为内在自适应 `grid-cols-[repeat(auto-fill,minmax(280px,1fr))]`：标准宽度（976–1152px）恒 3 列，全宽/超宽按内容宽自动增至 4/5/6… 列，卡片宽稳定在 280px 下限之上，无断点阈值需要维护。
4. **favicon 缺失**：`index.html` 无 `<link rel="icon">`，`public/vite.svg` 未被引用，浏览器标签页显示默认图标。
   > 已修复：新增 `public/favicon.svg`（深色圆角底 + 盾牌 + 绿勾，明暗标签栏均可读）并在 `index.html` 引用；删除未用的 `vite.svg`。
5. **设置页第四个 tab 叫「设置」**：`settings-screen.tsx:45-50`「设置 → 设置」导航语义含混（该 tab 实为 schema 驱动的运行参数表单），建议改名如「运行参数」。
   > 已修复：tab 与卡片标题均改为「运行参数」（路由路径 `/settings/settings` 不变）。
6. **小字号 + 贴线对比度**：`index.css:63-67`（浅色 muted-foreground ≈ neutral-500 与白的混合，对比度约 4.5:1 贴线）叠加大批 `text-[10px]/[11px]`（频道时间戳、分组头、计数 chip）。可把 muted-foreground 调深一档，或对 10-11px 文本改用 foreground/80。
   > 已修复：浅色 `--muted-foreground` 改为纯 `neutral-600`（白底约 7:1）；暗色原本即朝白混合，未动。
7. **ModelRefPicker 空态无引导**：`model-switcher.tsx:161` 无可用模型时只显示「选择模型」placeholder，不提示去设置页添加供应商。新用户首次打开启动对话框会困惑。
   > 已修复：下拉弹层内无可用模型时显示「无可用模型 + 前往 设置 → 模型供应商 添加并启用一个供应商」。
8. **Timeline aria-live 播报过频**：`timeline.tsx:892-894` 每次 items 变化（流式 delta 合帧后）都播报「agent 活动已更新」，读屏用户在流式输出期间会被刷屏。建议仅在状态转折（开始/结束）播报。
   > 已修复：Timeline 新增 `running` prop（Conversation 传入），仅在新用户消息出现（「新回合开始」）与 running→false（「回合结束」）时播报。
9. **面包屑截断无提示**：`product-header.tsx:52` 赛事名 truncate 但无 title，长赛事名无法查看全称。
   > 已修复：截断 span 补 `title={eventName}`。
10. **无组件级 ErrorBoundary**：只有路由级 `RouteError`（`App.tsx:28-53`）。时间线/图表任何一个渲染异常会击穿整个路由到错误页，丢失用户上下文（对话草稿虽有 localStorage 保全）。对 timeline、agents-graph 两个复杂渲染区值得各加一层。
    > 已修复：新增 `components/error-boundary.tsx`（类组件，就地显示「渲染出错」+ 重试），包裹 Conversation 内的 Timeline（按 agentId 重置）与 AgentsGraph。
11. **频道未读只有点无计数**：`channels-view.tsx:584-589` 未读显示为小圆点，离开页面再回来无法区分 1 条新消息还是 50 条。活动日志已有计数 badge 先例（`activity-log.tsx:213-217`）。
    > 已修复：rail 项未读改为计数 badge（99+ 截断，样式对齐活动日志）；ChannelsView 在非活跃频道 `lastMessageAt` 越过基线时拉取一次最新窗口计数（`at` 水位保证每次变化只拉一次，SSE 打开频道即时清零）。

---

## 各维度详细分析

### 1. 工程与架构 —— 优

- 技术栈现代且克制：React 19 + Vite 8 + Tailwind 4 + TanStack Query 5 + Base UI（coss）+ react-hook-form，无多余状态库；`ConversationStore` 用 `useSyncExternalStore` 自建轻量外部 store，选型正确。
- 目录分层清晰：`api/`（传输层，统一 `ApiError` 携带 error code 供视图分支）、`domain/`（会话条目 → 渲染条目折叠）、`stream/`（SSE 解析与 store）、`features/`（按域组织视图）、`components/`（跨域复用），无循环依赖迹象（`agents-graph.tsx:387-390` 注释甚至显式规避了一个 ESM 环）。
- 类型纪律：零 `any`、零 `@ts-ignore`；所有 SSE/localStorage 输入都经运行时校验（`parse-event.ts`、`platform-sync-stream.ts`、`event-view-prefs.ts` 的 sanitize）。
- 代码分割：首页 eager、赛事页与设置页路由级 lazy（`App.tsx:18-25`）。可进一步：`agents-graph`（xyflow + dagre，重依赖）静态打进赛事 chunk，可再拆一层，属锦上添花。
- query key 集中管理（`api/keys.ts`），重复轮询由 React Query 按 key 去重——任务页与概览同时观测 fleet 是安全的。
- 轮询节奏设计有分层意识：5s 业务轮询、60s 频道对账、15s/60s 活动日志开合分频、隐藏 tab 停轮（`scheduler-dm-tab.tsx:57,66`）。注意点：任务 tab 常驻（Base UI Panel keepMounted）意味着赛事页打开期间 fleet/queue/detail/inbox/usage 五类 5s 轮询常开，本地单用户场景可接受，报告仅作记录。

### 2. UI 视觉与一致性 —— 良，有横向裂缝

- 容器语言三层规则（CardFrame / Card / 裸沉浸流）已按 `frontend-polish.md` 落地，跨页一致性肉眼可验证。
- 主题 token 体系完整（`index.css`），暗色非反色而是独立调校（destructive/success 等做 color-mix 提亮），React Flow 变量也映射到自有 token（`index.css:272-288`）。
- 裂缝即 P1-3/P1-4：状态颜色与状态术语在不同视图存在两套并行体系，这是当前视觉层最值得收敛的一件事。
- 微字号已收敛到 10/11px 两档但数量庞大（30+ 处），与对比度问题（P2-6）复合。

### 3. 交互与状态设计 —— 良，闭环有漏

- 三态覆盖整体优秀：几乎所有列表/面板有 pending spinner（统一「正在加载 X…」措辞）、Empty 组件空态、`ErrorState` 带「重试」。漏洞是 P1-1 的三处永久加载与静默失败。
- 表单反馈路径完整：行内 Alert（mutation.error）、toast 成功/失败、按钮 loading 态、防重复提交；`ConnectPlatformDialog` 的「测试连接 → 发现赛事 → 绑定」三段式引导做得尤其好。
- 危险操作普遍 AlertDialog 确认且 destructive 视觉明确，例外见 P0-3（不关闭）与 P1-8（flag 无确认）。
- 键盘：agent composer 的 slash 命令面板（↑↓/Enter/Tab/Escape + IME 保护 + 外点关闭 + 焦点归还）是全库交互最精细的部分；Agents Graph 给节点补了 Enter/Space 激活（`agents-graph.tsx:414-427`，因为 React Flow 原生 keydown 不触发 onNodeClick）。缺口：频道 composer 无 IME 保护（P0-2）、两处 composer 无自动增高与快捷键提示（P2-1）。
- 草稿持久化（`composer-draft:{agentId}`）与投递方式在轮次结束后清空的细节（`conversation.tsx:145-147`）体验考虑周到。

### 4. UX 流程 —— 优

- 信息架构：赛事 → （概览/任务/Agents/题目/设置）→ 题目（对话/频道/文件/队列）三层，任务选择态放 URL（`?c=&a=`）可刷新可分享，tab 持久化到 localStorage 并处理了调度者专属 tab 的降级（`tasks-page.tsx:30-38`）。
- 实时性：agent 级 SSE + 频道级 SSE + 5s 轮询兜底 + 断线提示条（`conversation.tsx:426-430`）+ SSE 重连后状态复位（`conversation-store.ts:173-188`），实时链路完整。缺口：调度者 DM 的强制贴底（P1-2）反而破坏了阅读回溯这一基本动线。
- 错误恢复：`ApiError.code` 支持视图分支（`target-panel.tsx:50-51` 用 `not_bound` 隐藏无远端题目的面板，避免永久加载）——这是正确做法，P1-1 的三处应当效仿。
- 引导性：空态文案普遍带下一步指引（「发起第一次尝试，或在概览中入队等待调度」）；新手最大断点在「没有模型供应商时到处都是空 picker」（P2-7）。
- 并发可见性：任务列表的活跃/沉默分组、超时倒计时（<10min 黄 / <5min 红）、2 分钟无更新的 stall 提示（`task-list.tsx:18-22`）是围绕真实 CTF 作战节奏设计的，好。

### 5. 可访问性 —— 良（以桌面专家工具标准）

- 语义化：`output` 元素做加载态、`role="log"` 频道与导入日志、`aria-live` 活动徽章与导入进度、表单 label 关联普遍到位（coss Field 体系）。
- 键盘可达：ListRow 是真 button（focus-visible ring 样式齐全）、菜单/对话框由 Base UI 管理焦点。`ConversationPane` 的「仅活跃」用原生 `button[aria-pressed]`。
- 不足：P2-8 播报过频；`PolicySwitch`（`event-settings.tsx:538-558`）的 FieldLabel 未与 Switch 关联（Switch 无 id，靠 Switch 自身可聚焦补救，读屏读不到开关名称）；批量小字号文本对比度贴线（P2-6）；Graph 节点为 div（React Flow 限制，已有键盘激活补偿，可接受）。
- 明确不做移动端/触控（viewport 固定 1024），符合产品定位，不计为缺陷。

### 6. 性能（静态启发式）—— 优

- 流式渲染的核心优化正确且关键：stable/tail 以最后一条用户消息为界 memoize 历史区，text_delta 只重建活动轮（`conversation-store.ts:77-87`）；通知 rAF 合帧（`conversation-store.ts:366-377`）；`ConversationRow` memo。
- 长列表：对话与频道消息无虚拟化，但频道有游标分页（`before` 锚定回滚 `channels-view.tsx:442-467`），实际 DOM 规模受控。工具输出有 64k 截断 + 200 行表格截断（`timeline.tsx:133-136,145-178`）、Markdown 100k 截断——防巨型 payload 拖死渲染的意识贯穿全库。
- Shiki 按需加载语言、无语言时回退纯文本 HTML（`shiki.ts`、`tool-render.tsx:243-268`），并有 cancelled 标志防竞态。
- AgentsGraph：节点集不变时复用布局避免抖动、`onlyRenderVisibleElements`、归档折叠限制节点数（`agents-graph.tsx:483-499`）。
- 潜在点：全宽下题目卡固定 3 列纯视觉问题；频道消息 `groupMessages` 每次 render 全量重算（无 memo，但规模 ≤ 数百条，可忽略）。

### 7. 健壮性与安全 —— 优

- XSS：仅两处 `dangerouslySetInnerHTML`（`tool-render.tsx:281`、`code-preview.tsx:120`），内容均先经 `escapeHtml` 或来自本地 Shiki 输出；Markdown 走 react-markdown 无 rehype-raw，链接统一 `target=_blank rel=noreferrer`（`markdown.tsx:29-33`）。安全。
- 竞态处理成熟：频道三源合并去重（HTTP 窗口 / SSE 重放 / 对账轮询，`channel-tail.ts` 有测试覆盖）；SSE 重连清 ephemeral 态防陈旧；`fetch-event-source` 显式中断自动重试避免同步重启（`platform-sync-stream.ts:176-181`）；导入对话框进行中禁止关闭。
- 边界：空数组稳定引用防 useMemo 抖动（`event-page.tsx:94-96`）、localStorage 全部 sanitize、无效时间戳过滤（`tsMs`）。
- 弱点即 P0/P1 所列：确认框状态机、永久加载态、以及 `SettingsTransfer` 导入成功后 `window.location.reload()`（`general-settings.tsx:253`）这种全页重置（可用但突兀）。

### 8. 文案与术语 —— 良

- 全库中文措辞统一、口吻一致（短句、动词开头按钮），中英混用仅限领域词（agent/flag/live/Strategy），符合 CTF 人群习惯。
- 例外：P1-4（已关闭/已中断）、P1-3（调度者状态双词汇）、`formatAgo` 的「m 前 / h 前」英文单位与全中文界面并置（`task-list.tsx:50-58`，可改「分钟前/小时前」或保持紧凑刻意为之——建议至少全库统一）。
- 提示文案质量高：策略开关的 description 把行为后果和代价都写清了（如「#team 消息全部按紧急投递……代价是回合被更频繁注入」），这是给专家用户 correctly calibrated 的文案。

---

## 做得好的（保持，不要动）

- `ConversationStore` 的 stable/tail 合并 + rAF 批通知架构——流式场景的正确答案。
- `ApiError.code` 驱动的视图分支（`not_bound` 隐藏面板）。
- 任务选择态进 URL（`?c=&a=`）+ tab 持久化 + 调度者专属 tab 降级。
- agent composer 的 slash 命令面板与 IME 保护。
- 频道时间线的游标分页 + 前插锚定 + follow-latest（应把这套复用给 DM tab）。
- 任务列表的作战化信息设计（活跃/沉默、倒计时变色、stall 提示）。
- 危险区域集中化（赛事设置 DangerAction 列）与平台绑定的三段式引导。

## 建议明确不做的

- 虚拟化频道/对话消息——已有分页与截断控制规模，收益不成立。
- 全局快捷键体系、动画体系——沿用 polish 文档的结论，等真实需求。
- 移动端/响应式适配——产品定位桌面 ≥1024。
- 引入状态管理库或表单 schema 库——现有 useForm + 局部 state 规模可控。

## 修复优先级建议

| 顺序 | 项 | 工作量 |
| --- | --- | --- |
| 1 | P0-1 SpawnAgentDialog eventId（4 个调用点补参或隐藏队列选项） | 小 |
| 2 | P0-2 IME 保护（3 处 onKeyDown 补 isComposing） | 小 |
| 3 | P0-3 + P1-8 危险操作确认框统一「成功即关闭 + 错误 toast」，flag 删除补确认 | 小 |
| 4 | P1-1 三处永久加载/静默失败补 error 分支 | 小 |
| 5 | P1-3 + P1-4 状态颜色与术语收敛到 `statusVariant`/单一标签表 | 中 |
| 6 | P1-2 DM tab 复用 ChannelTimeline（顺带获得分页） | 中 |
| 7 | P1-5/6/7/9 反馈闭环与表单必填修正 | 小 |
| 8 | P2 按需 | — |

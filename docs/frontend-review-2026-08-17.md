# 前端全面审查报告（2026-08-17）

> 范围：`apps/web`（React 19 + Vite 8 + TS 7 + Tailwind 4 + TanStack Query v5 + react-router 8 + Base UI/coss）。
> 规模：136 个 TS/TSX 文件，约 23,100 行（含 52 个只读 coss `components/ui` 文件）。
> 方法：pi-lens 全量诊断（LSP + tree-sitter + ast-grep + opengrep + jscpd + knip）+ 生产构建分析 + `oxlint --type-check` + `bun test`（32 通过）+ 逐文件人工走查（core 全文阅读，外围针对性抽读）。
> 本报告只覆盖前端；服务端问题见 `code-review-2025-08-16.md`。

## 0. 总体结论

架构质量高于平均水平：分层清晰（`api` 薄封装 / `domain` 纯函数 / `stream` 实时流 store / `features` 页面组件）、核心流式会话链路（SSE → parse → store → 渲染）设计良好且有测试、三态覆盖（loading/error/empty）系统完整、lint 与测试全绿。**没有发现致命缺陷**。

需要处理的问题集中在四类：

1. **健壮性缺口**：全应用无 ErrorBoundary、无 404 路由（渲染异常/未知路径 → 白屏或 React Router 默认错误页）。
2. **首屏体积**：主 chunk 2,181 kB（gzip 672 kB）全量 eager，无路由级分割。
3. **每轮轮询的无效重算**：`agents-graph` 的 dagre 布局在每次 render（每 5s）重跑。
4. **主题 FOUC**：dark 用户每次硬刷新白闪。

## 1. 做得好的（先说优点，避免误伤）

| 项 | 证据 |
| --- | --- |
| 流式渲染性能设计 | `conversation-store.ts`：committed 历史按最后 user-turn 切分为 stable（memoized）+ tail，`text_delta` 高频事件只重建活动轮；rAF 批量通知合并通知风暴；revision 递增去重 |
| SSE 断线恢复 | `connect()`：原生 EventSource 自动重连；`onopen(reconnect)` → `resetForReconnect()` 清理临时态 + 全量重拉 committed；`resetForReconnect` 保留 pending 用户草稿 |
| 时间线滚动交互 | `timeline.tsx`：上滚暂停跟随、"最新"跳底按钮（portal 到滚动容器）、ResizeObserver 跟随、`aria-live` sr-only 播报 |
| 工具卡片信息设计 | running spinner→完成图标、参数/执行双耗时徽标、bash 退出码 chip、terminal 原因（超时/取消/失败）、ANSI 剥离、流式输出自动滚底 |
| 三态覆盖 | 所有数据视图有 Spinner/ErrorState(带重试)/Empty 空态（含筛选空态"没有匹配的题目"） |
| 破坏性操作确认 | 删赛事/回溯/取消队列/删 provider 均 AlertDialog 确认并说明后果 |
| 主题系统 | 自研 provider：dark/light/system + `prefers-color-scheme` 实时跟随 + storage 事件跨标签同步 + 切换时禁用过渡 + "d" 快捷键；shiki 经 `useResolvedTheme`（MutationObserver 监听 `<html>` class）同步换肤；react-flow 暗色变量映射在 `index.css` 中处理 |
| localStorage 防御 | `event-view-prefs.ts`：读取时全量 sanitize，坏数据降级为默认值；写入 try/catch（隐私模式） |
| 可访问性意识 | `role="status"/"alert"/"log"` 广泛使用、unread dot 带 aria-label、focus ring 全局、图标 aria-hidden |
| 工具输出防护 | `formatToolCell` 64k 字符截断、ToolData 200 行上限、Markdown 100k 截断、流式 markdown `isAnimating` |
| 测试 | 核心纯函数（buildConversation、parseLiveEvent、store、code-preview normalize）32 个用例全过 |

---

## 2. 构建与加载性能（E1）

### E1-1 [P2] 主 bundle 无路由分割

- **证据**：`vite build`：`dist/assets/index-*.js` **2,181 kB / gzip 672 kB**，另有 CSS 242.5 kB / gzip 32.9 kB。`App.tsx` 三个页面（HomePage / SettingsPage / EventPage）全部静态 import，无任何 `React.lazy`。xyflow + dagre + streamdown + shiki core + Base UI 全部进入首屏 chunk。
- **对比**：shiki 的 350+ 语言包与 mermaid 图表 chunk 已被库自身按需分割（dist 共 407 个文件 15MB，按需加载，无问题）。问题仅在应用代码 + 重型依赖的入口聚合。
- **影响**：本地部署影响有限（局域网加载快），但首屏解析/执行成本、dev 模式冷启动、以及内存占用都偏高；首页（赛事列表）完全用不到 graph/markdown。
- **建议**：`EventPage` 与 `SettingsPage` 用 `React.lazy` + Suspense 分割；xyflow/dagre 仅 EventPage agents tab 需要，可随路由 chunk 下沉。加 rolldown 的可视化分析器确认归因。

### E1-2 [P4] favicon 未引用

`public/vite.svg` 存在但 `index.html` 无 `<link rel="icon">`，生产环境浏览器请求 `/favicon.ico` 404。顺手补一行即可。

## 3. 运行时性能（E2）

### E2-1 [P2] agents-graph：每次 render 重跑 dagre 布局

- **证据**：`agents-graph.tsx:452` `sortedRuns` 在组件体内联计算（无 useMemo）→ 作为 `graph` useMemo 的 dep，数组身份每次 render 都变 → `buildAgentsGraph`（含 `layoutWithDagre` 全量布局）在**每次 render**执行，而 fleet 轮询每 5s 触发 re-render。代码注释声称"status-only poll updates reuse the cached layout"——被 `sortedRuns` 的不稳定身份破坏（`graphKey` 只保护了 ReactFlow remount，不保护布局重算）。
- **影响**：持续 CPU 浪费；归档全展开、节点多时每 5s 一次全图 dagre。无视觉跳变（dagre 确定性），纯属浪费。
- **修复**（一行级）：`sortedRuns` 包 `useMemo([runs])`；或 useMemo dep 直接用 `runs`。

### E2-2 [P3] Timeline 无虚拟化，DOM 随会话无界增长

- **证据**：`timeline.tsx:620` 渲染全部 `items`。`ConversationRow` memo + stable 引用使**重渲染**受控（好），但**DOM 数量**随 committed entry 线性增长；千条 entry 的长会话（CTF 长跑任务常态）会卡滚动与首帧。
- **建议**：数据侧已按 agent 分 store、行可预测高度（除 markdown），引入 `@tanstack/react-virtual` 的成本可控。列为按需项：先在真实长会话里量化，卡顿再上。

### E2-3 [P3] DiffPreview 无行数上限

`tool-render.tsx` `DiffPreview`：`parseDiff` 后全量渲染行；`toolDiff` 从 old/new 字符串重建 diff 时，大文件写入/编辑（几千行）会一次性挂几千个 DOM 行。对比：`ToolData` 有 200 行 + 64k 截断、Markdown 有 100k 截断、bash 有流式截断——diff 是唯一漏网。建议加同样的行数上限（如 1000 行 + 截断提示）。

### E2-4 [P3] channels-view：双 3s 轮询 + 无分页

- 频道列表与消息各一个 `refetchInterval: 3000` 查询（常开 2 个轮询）。
- `listChannelMessages(key, 0, 100)` 恒拉第一页：**超过 100 条的历史无法查看**（无"加载更多"）。既是性能问题也是功能缺口。
- 自动滚底无"用户上滚暂停跟随"（对比 Timeline 有完整实现）——轮询刷新会把正在上翻的用户拽到底部。

### E2-5 [P4] 全局通知广播

`conversation-store.ts`：`run.updated` / `agent.updated` / `context.updated` 对**所有 agent 的 listeners** 广播（`for (const listeners of this.listeners.values())`）。当前消费方多为单 agent 订阅，影响小；多 agent tabs 同时订阅时 context 更新会连带重渲染所有 tab。

## 4. 数据流正确性（E3）

### E3-1 [P3] 重连后全量重拉消息，未用增量 cursor

`runs.ts listMessages(runId, after=0)`：API 支持 `after` 增量 cursor（注释明确说明"所有现有调用点都用全量"）。SSE 每次重连都全量拉取该 agent 全部 committed 消息。长会话 + 网络抖动场景成本高。本地环境可接受；若后续遇到性能问题，这是现成的优化点（store 记录已见最大 seq → 传 after）。

### E3-2 [P3] `MessageProgress.pending` 是死标志

`conversation-store.ts:24` 定义 `pending: boolean`，`resetForReconnect` 特意保留 pending 项，但**没有任何代码设置过 `pending: true`**（唯一赋值处是 `{...event, pending: false}`）——乐观发送（本地回显用户消息）从未实现。发送后消息要等 SSE `message.committed` 回显，网络抖动时用户会疑惑"发出去了吗"。建议：要么实现乐观插入（sendMessage onSuccess 时插入 pending 项），要么删掉该字段避免误导。

### E3-3 [P4] `apiRequest` 无 AbortSignal/timeout

`api/client.ts`。react-query 轮询场景会自行去重/覆盖，页面切换泄漏风险低；但手动调用点（如 `loadMessages`）无取消。本地工具可接受，记录备查。

### E3-4 [P4] QueryClient 零配置

`main.tsx` `new QueryClient()`：默认 staleTime=0（每次挂载必 refetch）、默认 retry 3。事件详情、provider 列表等低频变化数据挂载即重拉。建议设全局 `staleTime: 15_000` 起步 + 按需覆盖。

### E3-5 竞态与一致性（验证通过，无需改动）

- SSE commit 与 GET 快照的竞态：`applySnapshot` 会把已 commit 的 key 从 progress 中删除；`completedTools` 抑制迟到的 tool.progress；revision 单调递增拒绝旧事件。链路自洽。
- StrictMode 双挂载：connect/disconnect 对称清理，无泄漏连接。
- `Timeline key={effectiveAgentId}` 切 agent 全量重建——正确的取舍（换数据源）。

## 5. 健壮性（E4）

### E4-1 [P1] 无 ErrorBoundary、无 404 路由

- **证据**：全项目 `rg ErrorBoundary|onCaughtError` 零命中；`App.tsx` 的 `createBrowserRouter` 无 `errorElement`、无 catch-all 路由。
- **影响**：任何组件渲染期抛错 → React 卸载整棵树 → **白屏**，无恢复入口（本地工具也无刷新提示）。访问未知路径（如手滑改错 URL）→ React Router 内置错误页。
- **建议**：①根路由 `errorElement`（复用 `ErrorState` + "回到首页"）；②`<Route path="*" >` 404 页；③可选：在 RouterProvider 外再包一层 ErrorBoundary 兜 router 自身错误。这是本次审查中优先级最高的单项。

### E4-2 [P2] 静默失败的 mutation

`settings-screen.tsx:70-81`：`remove`（删除 provider）与 `toggleProvider`（启停 provider）**均无 onError**——失败时无任何提示，UI 表现为"点了没反应"。全站 25 处 mutation 中 18 处有 onError（toast 或 inline Alert），这两个是缺口。

### E4-3 [P3] AgentDialog 无 not-found 分支

`agent-dialog.tsx:137`：`detail.isPending || !run || !agent` 恒 spinner。若 agentId 过期（graph 数据落后于详情）会**永远转圈**。建议区分"data 已到但 agent 缺失 → 提示并关闭"。

### E4-4 [P3] oxlint 残留 warning

`settings-screen.tsx:162` `no-floating-promises`（navigate 返回的 Promise 未处理）。`bun run check` 目前因它不是 error 而通过，建议补 `void`。

## 6. 类型与静态检查（E5）

- [P3] **无独立 `tsc --noEmit` 全量检查**：`check` 脚本用 `oxlint --type-check`，其对 TS 语义的覆盖不等于编译器（泛型推断、跨文件类型流）。建议 check 脚本加 `tsc -p tsconfig.app.json --noEmit`（TS7 本地全量编译秒级）。
- [P4] **`api/types.ts:66` 与 `apps/shared/queue.ts:6` 重复 23 行**（jscpd）：QueueItem 等类型两边各写一份，web 已依赖 `@aegisx/shared`，应直接复用。
- [P4] **未用导出**：`api/types.ts` 的 `ChannelMessagePublic` / `ChannelPublic` / `ThinkingLevel`（knip）。`channels-view.tsx` 用的是另一处定义，存在双份频道类型。
- knip 报告的 `components/ui/**` 未用文件/导出（context-menu、drawer、calendar、form 等）为 coss 组件库预期状态，**按项目规则忽略**；连带 `react-day-picker` 依赖仅被未引用的 `calendar.tsx` 使用，可从 `package.json` 移除（连带依赖，不属于 ui/ 文件本身）。
- `tsconfig.app.json` / `tsconfig.node.json` 的"Comments not permitted in JSON"为 LSP 严格 JSON parser 误报（tsc 接受 JSONC 注释），无需处理。

## 7. 安全（E6）

### E6-1 [结论：风险低，建议集中化] 两处 `dangerouslySetInnerHTML`

- `code-preview.tsx:120` 与 `tool-render.tsx:281`（BashCommand）。HTML 来源只有两个：①`plainHtml`/`plainCommandHtml`——手工 `escapeHtml`（`& < > "` 全转义；内容进入元素文本节点与 `data-line`（数字）属性，无单引号属性上下文，转义集足够）；②shiki `codeToHtml`——shiki 自行正确转义源码。
- **数据源为不可信的 LLM/bash 输出**，当前实现实际不可注入；但手工转义分散在两处、无测试锁定，属于"现在对、将来易改错"的结构。建议：escapeHtml 提到 `lib/`，加 2 个单测（含属性上下文样例），保留 dangerouslySetInnerHTML（shiki 输出绕 React 是标准做法）。opengrep 建议的 DOMPurify 对本地单用户工具属过度。
- `tool-render.tsx:16-18` 的"dynamic regex ReDoS"为**误报**：CSI/OSC/CHARSET 由 `String.fromCharCode` 常量构成，非用户输入。

### E6-2 Markdown 渲染（验证通过）

streamdown 打包了 `rehype-sanitize` + `rehype-harden`，LLM 输出经 sanitize 后渲染，默认安全。mermaid 图表由 `@streamdown/mermaid` 沙箱化渲染。`AttachmentChip` 下载链接 `href` 为服务端 URL（文件 id 路径参数），无 javascript: 注入面。

### E6-3 [P4] 无 CSP / 无外部链接场景

`index.html` 无 CSP meta。本地单用户部署符合项目规则（敏感信息不脱敏、无多租户）；若未来暴露到非信任网络需补。全站无 `target="_blank"` 外链，noopener 问题不存在。

## 8. 视觉与交互设计（A）

### A1. 布局与响应式

- **桌面锁定是三处一致的明确决策**：`index.html` `viewport width=1024`、`index.css` body `min-w-[1024px]`、`app-layout.tsx` `min-w-[1024px]`。features 层几乎不用响应式断点与此自洽。**非缺陷**。
- [P4] 窄窗口无任何提示，只有横滚条。可选加一条 `max-[1023px]:flex` 的提示条（"请在 ≥1024px 视口使用"），成本低。
- 题目网格 `grid-cols-3` 固定三列：全宽切换（`fullWidth` localStorage 持久化 ✓）时列宽拉伸，窄列（默认 max-w-6xl）合理。可用 `auto-fill minmax` 让全宽时更紧凑，属打磨项。
- `event-page.tsx` 855 行：结构实为"4 个顶层 tab 的容器 + 概览面板"，每个 tab 内部已拆子组件，职责尚清楚；后续若再增长应把 challenges tab（筛选/分组/排序菜单约 300 行）独立文件。

### A2. 设计系统一致性

- 语义 token 覆盖完整（`--background/foreground/card/popover/primary/...` + info/success/warning 扩展），`@theme inline` 桥接规范。features 层基本走 token。
- 例外（可接受/建议）：`tool-render.tsx` diff 的 emerald/red 双主题硬编码（`text-emerald-700 dark:text-emerald-400`）——语义上刻意区分于 success/destructive，保留合理；若要收口可定义 `--diff-add/--diff-del` token。
- `files-workspace.tsx` 的 5 处 inline style（缩进 `paddingLeft`、宽度）为动态值，合理；lens 的 inline-styles 告警可忽略。
- 对话框宽度不统一但各有语义（AgentDialog `max-w-5xl`、创建类 dialog 默认宽度），抽查未见漂移。

### A3/A4. 主题

- [P2] **FOUC：dark 用户每次硬刷新白闪**。`index.html` 无 pre-paint 脚本，`:root` 默认 light，ThemeProvider 在 React 挂载后的 effect 里才加 `.dark` class。修复：index.html 内联 3 行脚本（读 localStorage + matchMedia → 设 `<html>` class），与 ThemeProvider 的 storageKey/枚举保持一致。
- [P4] "d" 快捷键切换主题：功能正常且避开了输入框（isEditableTarget），但无任何 UI 提示其存在（设置页 ThemeSelector 也没提）。加个 hint 即可。
- system 模式实时跟随 ✓、跨标签同步 ✓、切换禁用过渡 ✓、react-flow/shiki 换肤 ✓。**mermaid 图表主题跟随未验证**（`@streamdown/mermaid` 内部行为），留一个手动验证项。

## 9. 交互反馈与状态设计（B）

### B1. 三态完整性（验证通过，质量高）

抽查全部数据视图：pending → Spinner/`role="status"`；error → `ErrorState`（带重试）或 inline Alert；empty → `Empty` 组件且多数带引导文案（"为本赛事添加第一个题目"、"调度者尚未规划任务…"）。无骨架屏但 spinner 风格统一——可接受，不强推 skeleton。

### B2. 实时流 UX（核心链路，验证通过）

打字动画（streamdown `isAnimating`）、上滚暂停跟随、跳底按钮、断线 banner（"正在重新连接…"）、工具 running→done 状态机与耗时、bash 流式滚底、context token 条、steer/followUp 队列编辑——均已实现且质量好。缺口：

- [P3] 发送无乐观回显（见 E3-2，同根因）。
- [P4] 无 token 速率/成本即时显示（usage 在 event-summary 有汇总，流中无）——可选增强。

### B3. 操作反馈

- 25 处 mutation / 18 处显式错误处理；缺口即 E4-2 的两处（remove/toggleProvider）。
- 破坏性确认全覆盖（删赛事、回溯、取消队列项、删 provider/model）✓。
- 乐观更新仅 model 切换有 draft echo（设计合理：切换有服务端确认语义）。

### B4. 表单

- react-hook-form 用于 8 个对话框，`rules={{required}}` + 原生 `required` 属性并用。
- [P3] 校验错误展示依赖**浏览器原生气泡**（中文文案受浏览器/系统语言控制，样式不可定制），未用 `FieldError`。建议关键表单补 zod resolver 或至少 `FieldError` 渲染 `form.formState.errors`。
- [P4] `schema-form.tsx`（设置页动态表单）体验好：搜索、单项重置、自动保存、修改标记。

### B5. Composer（对比缺口）

- [P3] `message-input.tsx` 主对话输入是**单行 `<Input>`**：无换行、无 Shift+Enter、无自动增高；对比 `channels-view.tsx` 的 composer 已是 Textarea + Enter/Shift+Enter + 自动增高。CTF 指令常含多行 payload，建议对齐 channels 的实现。
- 命令面板（/compact /new /close）经菜单可发现 ✓，插入后回焦点到输入框 ✓。

## 10. 可用性（C）

### C1. 键盘与焦点

- [P2] **Agents Graph 节点键盘不可达**：React Flow 节点可 Tab 聚焦，但 `onNodeClick` 只响应鼠标——键盘用户无法打开 agent 对话框/题目 IM/展开 run。修复：`onNodeClick` 之外给节点容器加 `onKeyDown`（Enter/Space 触发同一路由），或用 RF 的 `nodesFocusable` + 自定义 handle。
- [P4] 全站快捷键仅"d"切主题。作战场景可考虑：`⌘K` 命令面板、`g a` 跳 agents tab 等——列为产品可选项，非缺陷。
- Collapsible/Dialog/Menu/Tabs 均为 Base UI，焦点管理开箱即用 ✓。

### C2. 导航与信息架构

- [P2] 未知路径无 404 页（见 E4-1，同修复）。
- [P3] **深层状态不可 URL 寻址**：AgentDialog 打开哪个 agent、graph 选中的 run/agent、AgentDialog 内部的 view tab 都是组件 state——刷新即丢、不可分享链接。tab 级已同步 URL（event tabs / settings sections ✓）；若要强化，用 searchParams（`?agent=`、`?view=`）承载 dialog 选择。
- [P4] `/settings/prompts`、`/settings/templates` 两条 redirect 是 IA 变更残留，无害；确认无外部依赖后可删。
- 面包屑：header `AegisX / 赛事名` ✓；AgentDialog 从 graph 打开后上下文（题目归属）在 DialogDescription 里 ✓。

### C3. 长会话与大数据 UI

- timeline 无虚拟化（E2-2）；channels 100 条封顶（E2-4）；queue/challenges 列表量级受控（服务端限流 + 折叠设计）。
- graph 有界性设计好：归档默认折叠、`onlyRenderVisibleElements`、`graphKey` 仅节点集变化时重 fitView（保留用户缩放）——注释已说明权衡。
- 文件树懒加载目录（展开才请求）✓、侧栏可拖宽且持久化 ✓。

## 11. 可访问性（D）

- [P3] **暗色 muted 文本对比度临界**：`--muted-foreground`（dark）= color-mix(neutral-500 90%, white) ≈ #7d7d7d，背景 ≈ #0d0d0f，对比度 ≈ **4.4:1**，低于 WCAG AA 小文本 4.5:1。大量 `text-xs text-muted-foreground` 的辅助信息处于临界线。建议 dark 值提一档（neutral-400 基）。
- 错误状态不只靠颜色（图标 + 文字）✓；unread dot 有 aria-label ✓；`aria-live` 用于流式更新 ✓；`role="log"` 频道时间线 ✓。
- Graph 键盘问题见 C1；RF 的 Controls/zoom 按钮可聚焦 ✓。

## 12. 架构与一致性（E7）

- 分层与数据流边界清晰：react-query（服务器态）/ ConversationStore（实时流，外部 store + useSyncExternalStore）/ local state。无全局状态库、无越层引用。
- [P3] **9 处对话框样板重复**（jscpd，10-17 行）：`create-run-dialog` / `add-solver-dialog` / `connect-platform-dialog` / `home-page` / `provider-dialog` / `provider-detail` / `provider-model-dialogs` / `queue-list` / `event-settings` 相互重复"错误 Alert + DialogFooter(取消/提交+loading)"模式。建议提炼 `<DialogFormFooter error={...} />` 或类似局部组件（仍在 features 层，不动 ui/）。
- [P4] `conversation.tsx` 顶注提到 "orchestrator-view" 消费方——实际 `Conversation` 仅剩 `agent-dialog.tsx` 一个使用点，注释已漂移。
- `api/channels.ts` 自带 multipart 请求 helper，与 `client.ts` 有 11 行重复（错误处理逻辑一致）；可让 apiRequest 接受 FormData 或提取共享错误解析。

## 13. 测试（E8）

- 现状：6 文件 32 用例，覆盖 `domain/conversation`（合并/系统标记/live 流入）、`parse-event`、`conversation-store`、`code-preview`（normalize）、`lang-from-path`、`platform-sync-stream`。**纯逻辑层覆盖良好**。
- 缺口：零组件测试（RTL）、零 e2e。按风险排序的补测建议：
  1. `tool-render.tsx` 的 `parseDiff`/`toolDiff`/`stripAnsi`——纯函数，量大且直接渲染不可信输出（当前 0 覆盖）；
  2. `event-page.tsx` 的 `filterChallenges`/`challengeGroups`/`tabFromPath`——纯函数；
  3. `agents-graph.tsx` 的 `buildAgentsGraph`——纯函数（布局 mock 或跳过位置断言）；
  4. `Conversation` 组件一条 happy-path 集成（stream stub + 发送/切会话）——性价比最高的组件级用例。

---

## 14. 问题汇总表

| # | 级别 | 问题 | 位置 | 章节 | 状态 |
| --- | ------ | ------ | ------ | ------ | ------ |
| 1 | P1 | 无 ErrorBoundary / 404 路由，渲染异常白屏 | `App.tsx` | E4-1 | - [x] |
| 2 | P2 | 主 chunk 2.18MB 无路由分割 | `App.tsx` | E1-1 | - [x] |
| 3 | P2 | dagre 布局每次 render 重跑（sortedRuns 未 memo） | `agents-graph.tsx:452` | E2-1 | - [x] |
| 4 | P2 | dark 主题 FOUC（无 pre-paint 脚本） | `index.html` | A3 | - [x] |
| 5 | P2 | Graph 节点键盘不可达 | `agents-graph.tsx` | C1 | - [x] |
| 6 | P2 | remove/toggleProvider 静默失败（无 onError） | `settings-screen.tsx:70` | E4-2 | - [x] |
| 7 | P2 | channels：100 条历史不可达 + 双轮询 + 强制拽底 | `channels-view.tsx` | E2-4 | - [x] |
| 8 | P3 | Timeline 无虚拟化（长会话 DOM 无界） | `timeline.tsx` | E2-2 | - [ ] |
| 9 | P3 | DiffPreview 无行数上限 | `tool-render.tsx` | E2-3 | - [ ] |
| 10 | P3 | 重连全量重拉消息（after cursor 未用） | `runs.ts` / store | E3-1 | - [ ] |
| 11 | P3 | 乐观发送未实现，`pending` 死标志 | `conversation-store.ts:24` | E3-2 | - [ ] |
| 12 | P3 | AgentDialog 无 not-found 分支（恒 spinner） | `agent-dialog.tsx:137` | E4-3 | - [ ] |
| 13 | P3 | 无独立 tsc 全量类型检查 | `package.json check` | E5 | - [ ] |
| 14 | P3 | 暗色 muted-foreground 对比度 4.4:1 临界 | `index.css` | D | - [ ] |
| 15 | P3 | 主 composer 单行输入（无多行） | `message-input.tsx` | B5 | - [ ] |
| 16 | P3 | 表单错误依赖浏览器原生气泡 | 各 dialog | B4 | - [ ] |
| 17 | P3 | 深层状态（选中 agent / dialog view）不可 URL 寻址 | `event-page.tsx` 等 | C2 | - [ ] |
| 18 | P3 | 9 处对话框 footer/error 样板重复 | features 各 dialog | E7 | - [ ] |
| 19 | P3 | oxlint 残留 warning（floating promise） | `settings-screen.tsx:162` | E4-4 | - [x] |
| 20 | P4 | apiRequest 无 AbortSignal | `api/client.ts` | E3-3 | - [ ] |
| 21 | P4 | QueryClient 零配置（staleTime=0） | `main.tsx` | E3-4 | - [ ] |
| 22 | P4 | favicon 404 | `index.html` | E1-2 | - [ ] |
| 23 | P4 | api/types.ts 与 shared 23 行类型重复 | `api/types.ts:66` | E5 | - [ ] |
| 24 | P4 | 未用导出 + react-day-picker 依赖可移除 | `api/types.ts` 等 | E5 | - [ ] |
| 25 | P4 | "d" 快捷键无 UI 提示；orchestrator-view 注释漂移；/settings 旧 redirect 残留 | 多处 | A3/C2/E7 | - [ ] |
| 26 | P4 | 窄窗口无降级提示；grid-cols-3 全宽拉伸 | `event-page.tsx` | A1 | - [ ] |

**已核实的误报（无需处理）**：`tool-render.tsx:16-18` 动态正则 ReDoS（常量构造）；tsconfig JSONC 注释 blocking（LSP 严格解析）；`components/ui/**` knip 未用警告（coss 库预期）；`tailwindcss` unused 依赖（vite 插件需要）；`files-workspace` inline styles（动态值）。

## 15. 建议路线图

> **实施记录（2026-08-17，当日）**：第一、二刀已完成（#1–#7、#19）。路由级 `route.lazy` 分割后主 chunk 2,181 kB → 194.6 kB（gzip 672 → 62.2 kB），event-page 581 kB / settings-page 88 kB 独立 chunk。#7 附带服务端变更：`GET /api/channels/:key/messages` 新增 `before` 反向游标（`run/routes.ts` + `run/channels.ts`），前端以 after 追尾 + before 翻页的双向游标模型重写频道时间线。全部改动通过 oxlint/oxfmt、tsc 语义检查、32 个单测与生产构建。

1. **第一刀（< 半天）**：#1 ErrorBoundary + 404；#3 sortedRuns memo；#6 两处 onError toast；#4 FOUC 内联脚本；#19 void。全部为小改动、消除白屏/静默失败/白闪三类硬伤。
2. **第二刀（半天）**：#2 路由级 lazy 分割 + 构建分析；#7 channels 分页 + 滚动跟随；#5 graph 节点键盘。
3. **第三刀（按需）**：#8/#9/#10 长会话性能三件套（先量化再动手）；#11 乐观发送；#14 对比度；#15 composer 多行；#17 URL 寻址。
4. **持续**：#13 check 脚本加 tsc；#13/E8 按第 13 节顺序补测试；样板提炼随下次改 dialog 顺带做。

## 16. 未验证项（诚实声明）

- mermaid 图表在主题切换时的跟随行为（`@streamdown/mermaid` 内部）——留手动验证。
- 主 chunk 内各依赖的精确体积归因未做（需构建分析器），E1 的依赖列表为定性判断。
- `challenge-im-dialog` / `scheduler-dm-tab` / `run-overview` / `queue-list` / `agents-tab` / `challenge-card` 为抽读（模式与已读文件一致），未逐行审。
- 真实长会话（>1000 entry）下的滚动性能未实测，E2-2 建议基于代码结构推断。

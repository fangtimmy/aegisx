# Composer 与实时性整改（批次 A/B/C）

状态：**已实施**（批次 A/B/C 全部落地，验证见「验证」节）。
来源：2026-08-18 交互层走查（文档已删，见 git 历史）问题 2/4/5 中 v19 后仍然成立的部分（N+1 fleet、概览 getFleet、
spawn 表单瘦身已随 v19/tasks-tab 落地，不再重复）。relay 内置已砍（不做）。
决策记录：steer/followUp 队列**只开既有 SteerQueue 组件**，不做时间线 pending 气泡；
发送反馈 = HTTP mutation 自身的 loading 态。

## 批次 A：Composer 与队列可见性（纯 web）

### A1 开启 SteerQueue（存量组件，翻开关）

`features/runs/steer-queue.tsx` 已完整实现「输入框上方可编辑/删除队列」：
SSE `queue.updated` 驱动 + SSE 初始快照种子（`run/sse.ts` 会推 `bus.getQueue`）、
行点击编辑 / X 删除、`PUT /api/agents/:id/queue` 全量回写、服务端经 queue.updated 对账。

现状三处调用方都传 `canEditQueue={false}` 把它关了。改法：

- `conversation.tsx`：props `canEditQueue` 语义不变；`setQueue` prop 从「可选」改为必传
- 三个调用方开闸并接 `setQueueFn`：
  - `features/events/agent-dialog.tsx` → `agentsApi.setAgentQueue`
  - `features/tasks/conversation-pane.tsx` → 同上
  - （无第三处独立调用方；scheduler DM 不经过 Conversation）
- 展示门控保持现状：`running && 队列非空` 才出现（idle 无队列概念，合理）

### A2 Textarea 多行

`message-input.tsx` 的单行 `<Input>` 换 Textarea：Enter 发送 / Shift+Enter 换行，
与频道侧（`channels-view.tsx` ChannelComposer）行为一致。自适应高度（min 1 行 max ~6 行）。
锁定/禁用态、busy 逻辑不变。`aria-label` 保持。

### A3 slash 补全

draft 以 `/` 开头（trim 后首字符）且非完全命中命令时，composer 上方浮出补全面板：
现有三命令（/compact 压缩上下文 / /new 新会话 / /close 关闭容器）前缀过滤，
↑↓ 选择、Enter/Tab 选中（Tab 纯补全不发送）、Esc 关闭、点击选中。
不做参数补全。空 draft 不显示。

### A4 steer/followUp 常驻分段控件

现状：运行中才出现的小箭头 MenuRadioItem（可发现性差）。改为运行中在 composer 内
常驻分段控件（ToggleGroup 样式，两段：引导 | 追问），点击即切；idle 时隐藏。
移除旧 ChevronDown 菜单路径。分段控件位置：输入框左侧或按钮组前（实施时按视觉定）。

## 批次 B：频道实时性（server 1 端点 + web 接线）

### 问题

服务端 LiveBus 按**频道键**推 `channel.message`（`run/channels.ts:664`
`emitChannelsOf`：team→[eventId, challengeId]、orch→[eventId]、dm→[agentId]），
但 web 唯一 SSE 出口是 agent 视角的 `/api/agents/:agentId/stream`——IM 视角无端点可订，
channels-view 只能 3s 双轮询（rail 628 + tail 390）。

### B1 server：`GET /api/channels/:channelKey/stream`

- 位置：`run/routes.ts`（与既有 channel 路由同处）
- 照 `run/sse.ts` 的 streamAgent 模式：subscribe-before-snapshot、初始快照 = 该频道
  最新消息窗口（复用 `channels.listMessages(key, 0, PAGE)`）、后续转发 bus 事件、
  onAbort 清理。只转发 `channel.message` 类型事件
- 键校验：`parseChannelKey`（run/channels.ts:79）非法 → 400
- 无鉴权（单用户本地，与既有端点一致）

### B2 web：订阅 + 降轮询

- `channels-view.tsx`（题目 IM + tasks 频道 tab 共用）：active key 订阅 EventSource；
  收到 `channel.message` 后把消息追加进 `keys.channels.messages(key)` 缓存
  （setQueryData 按 id 去重），未读点 seenAt 对比逻辑不变
- `scheduler-dm-tab.tsx`（orch）：同模式订阅 `orch:<eid>`
- 轮询降级：tail 与 rail 的 `refetchInterval` 3s → 60s（对账兜底，防 SSE 静默丢事件）；
  EventSource 原生断线重连
- Tail 追加语义注意：现有 tail query 的 queryFn 用 `newestId.current` 做 after 游标 +
  `gcTime: 0`——SSE 追加路径要同步推进 `newestId.current`，否则 60s 对账会重复拉

## 批次 C：Provider 测试对话

### C1 server：`POST /api/providers/:providerId/test`

body `{modelId: string}`。发一次 max_tokens=1 的对话请求验证整条链路（baseUrl/apiKey/
模型存在性）。骨架照抄同文件 `/models/discover`（422 行）：按 provider.type 组 headers
（anthropic-messages → x-api-key + anthropic-version；openai → Bearer）、
`runtime.providerDiscoverTimeoutMs` 超时、失败 502 `{code: "provider_unavailable"}`。
成功返回 `{ok: true, latencyMs}`。

请求体按 type 分支：openai → `POST {baseUrl}/chat/completions`
`{model, messages: [{role:"user", content:"ping"}], max_tokens: 1}`；
anthropic-messages → `POST {baseUrl}/v1/messages` `{model, messages, max_tokens: 1}`。
（discover 不带模型所以不用分支 body；这里是新增的分支点。）

### C2 web：provider 详情页「测试对话」

provider 编辑区旁加：模型下拉（该 provider 已配模型）+「测试对话」按钮 →
成功 toast 显示延迟；失败显示 HTTP 状态 + 响应体摘要（截断）。

## 范围守卫

- 不改 Agents tab / agents-graph / AgentDialog 行为（A1 在 AgentDialog 内只是接线，
  不动对话流结构）
- 不做 relay、不做 pending 气泡、不做 fleet/queue 状态 SSE（轮询保留）
- relay 相关零改动

## 验证

- `bun run --filter @aegisx/web check && bun test apps/web && bun run build`
- server：`bun run --filter @aegisx/server check && bun test apps/server`
- 冒烟：SteerQueue 编辑/删除生效且重连后保留；多行输入；slash 补全；分段控件；
  频道页开两窗一发消息另一窗即时可见；断 SSE 后 60s 对账不重复消息；
  provider 测试按钮对错误 key 报 502

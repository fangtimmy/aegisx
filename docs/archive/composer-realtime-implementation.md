# Composer 与实时性整改实施计划

状态：**已实施**（设计依据 [composer-realtime-design.md](composer-realtime-design.md)）。
批次独立可编译：A（纯 web）→ B（server+web）→ C（最小）。一轮做完统一检查。

## 批次 A（纯 web）

### A1 开启 SteerQueue
- `features/runs/conversation.tsx`：`setQueue` prop 改必传；`showSteerQueue` 门控保持
  （running && canEditQueue && 队列非空）
- `features/events/agent-dialog.tsx`：`canEditQueue` 传 `true` + `setQueue={agentsApi.setAgentQueue}` 适配
- `features/tasks/conversation-pane.tsx`：同上
- 验证：运行中 agent 入队 2 条 steer + 1 条 followUp → composer 上方出现可编辑列表；
  编辑回写后 SSE queue.updated 对账；删除立即生效

### A2 Textarea 多行
- `message-input.tsx`：`<Input>` → `Textarea`（components/ui/textarea），Enter 发送 /
  Shift+Enter 换行（`onKeyDown` 拦截），自动高度 min-1/max-6 行（`field-sizing` 或
  rows 计算，按 coss 现有能力选）；IME 组合中 Enter 不发送
- 验证：三行 payload 发送成功；Shift+Enter 出现换行；锁定期禁用

### A3 slash 补全
- `message-input.tsx`：draft trim 后以 `/` 开头且≠命令全集 → 上浮过滤面板
  （三命令前缀过滤；↑↓/Enter/Tab/Esc/点击；Enter=补全到输入框，不直接执行——
  执行仍走既有 send 路径）
- 验证：`/c` 过滤出 /compact /close；Enter 补全后再 Enter 执行；Esc 关闭

### A4 分段控件
- `message-input.tsx`：删 ChevronDown+MenuRadioItem 路径；running 时在按钮组前渲染
  分段控件（coss ToggleGroup 或两枚 Button variant 切换），值绑 deliverAs
- 验证：运行中显示、idle 隐藏；切换后 send 的 deliverAs 正确

## 批次 B（server + web）

### B1 端点
- `run/routes.ts`：`GET /api/channels/:channelKey/stream`
  - `parseChannelKey` 校验（run/channels.ts:79），非法 400
  - 抽 `run/sse.ts` 的公共骨架（subscribe-before-snapshot / drain 队列 / onAbort），
    或直接内联同模式；初始快照 = `channels.listMessages(key, 0, 50)` 的 items 逐条作
    `channel.message` 事件；只转发 `channel.message` 类型
  - 注意：channelKey 含 `:`（合法路径字符），param 直接可用（既有 routes 同款）

### B2 web 订阅
- `channels-view.tsx`：`useEffect` 对 active key 建 EventSource（key 变则重建）；
  onmessage → JSON.parse → `queryClient.setQueryData(keys.channels.messages(key), prev =>
    appendDedup(prev, message))`，同时推进 `newestId.current`
- `scheduler-dm-tab.tsx`：同模式（orch 键，active 时订阅）
- 降轮询：两文件 `POLL_INTERVAL_MS`（3s）→ 60s 对账常量
- 验证：双窗发消息即时到达；断 SSE 后重连不丢；60s 对账无重复（id 去重）
- 测试：为 appendDedup / 推进游标补最小单测（web 侧现有 6 测试文件风格）

## 批次 C（server + web）

### C1 端点
- `providers/routes.ts`：`POST /api/providers/:providerId/test`
  - body schema（Type.Object）+ validateJson；provider 不存在 404
  - 分支请求体：openai-chat `/chat/completions` vs anthropic-messages `/v1/messages`
    （均 max_tokens=1, messages 单条 "ping"）；headers 按 type（抄 discover）
  - 超时/失败 → 502 `{code:"provider_unavailable", message:"Provider test failed"}`；
    成功 → `{ok:true, latencyMs}`（performance.now 差值）
  - 单测：对 mock fetch 断言 URL/headers/body 分支 + 超时路径（照 providers 既有测试风格）

### C2 UI
- provider 编辑区旁：模型下拉 + 「测试对话」按钮 + 结果行（✓ 132ms / ✗ 401 {"error":…}）
- 验证：错 key → 502 提示；对 → 延迟显示

## 统一验证

```
bun run --filter @aegisx/server check && bun test apps/server
bun run --filter @aegisx/web check && bun test apps/web && bun run build
```

冒烟清单（设计文档「验证」节）+ Agents tab 回归对照（SteerQueue 在 AgentDialog 开启后
对话流其余行为不变）。

完成后：两份文档状态改「已实施」。

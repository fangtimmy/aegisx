# 前端数据流审查

## 范围与方法

- **范围**：`apps/web/src/stream/`（SSE 生命周期与 store）、`apps/web/src/api/`（REST 封装）、`apps/web/src/domain/`（领域模型）、features 下消费数据流的组件（runs / tasks / events / activity / settings 的数据路径部分）。为核实重连补偿语义，交叉阅读了服务端对应实现：`apps/server/src/run/sse.ts`、`apps/server/src/agents/live.ts`、`apps/server/src/agents/event-pipeline.ts`、`apps/server/src/run/routes.ts`。
- **方法**：只读代码走查 + 服务端/客户端两侧对照推演（建连快照、重连补偿、去重键、revision 单调性、竞态防护逐一核对）。未启动任何进程。
- **排除**：`apps/web/src/components/ui/**`（coss 组件库，只读区）。

## 数据流架构梳理（SSE → store → UI）

**Agent 会话流（对话时间线）**

```
GET /api/agents/:id/stream (EventSource)
  └─ 服务端 pumpLiveStream（sse.ts）：先 subscribe 后 seed 快照，避免快照读取与订阅之间漏事件
     seed = ready + agent.updated + context + queue + activity + 全部在途 tool.progress 重放
  └─ 客户端 ConversationStore（stream/conversation-store.ts）
      ├─ message.committed → messages Map(key→item)，删同 key 的 progress 草稿，rebuildCommitted
      ├─ message.progress / tool.progress → 按 revision 单调覆盖（event.revision > existing.revision 才写入），
      │   已提交的 key/toolCallId 直接跳过（completedTools/messages 双闸门）
      ├─ agent.activity / context.updated / queue.updated → 独立 Map，notify
      └─ notify 合并到 rAF，一帧内多次事件只触发一次监听器
  └─ UI：Timeline / SteerQueue / ContextRing / AgentActivityBadge 各自 useSyncExternalStore 订阅同一 store
```

持久化历史由 REST 补充：`Conversation` 挂载时及每次 SSE 重连成功后调 `loadMessages`（GET /messages），经 `applySnapshot` 与流式状态按键合并。stable/tail 分割（最后一个 user turn 边界前记忆化）是纯渲染优化，不影响数据正确性。

**频道消息流（IM 视图）**：独立于上述 store——`ChannelTimeline` 自己开一个 EventSource（`/api/channels/:key/stream`），把 `channel.message` 写进 react-query 缓存（`appendChannelMessage` 推进 `nextAfter` 游标），本地 state 用 `mergeChannelMessages` 按 id 去重排序；60s 对账轮询兜底。服务端重连时重放最近 50 条快照，靠 id 去重幂等。

**其余数据面**：fleet / queue / event detail / inbox / activity 等全部走 react-query 定时轮询（5s–60s 不等），无 SSE 参与。

## 发现

### F1 · 频道消息 SSE 载荷零校验直通渲染链

- **严重度**：P3
- **位置**：`apps/web/src/stream/parse-event.ts:53`；下游 `apps/web/src/features/runs/channels-view.tsx:424-430`
- **证据**：

  ```ts
  // parse-event.ts:49-54 —— 同文件其它所有事件类型都有逐字段守卫，唯独这里整体断言
  if (value.type === "channel.message") {
    return { type: "channel.message", message: value.message as never }
  }
  ```

  ```ts
  // channels-view.tsx:425-430 —— 二次断言后直接入缓存
  const live = event.message as ChannelMessagePublic
  queryClient.setQueryData<ChannelMessageList>(..., (prev) => appendChannelMessage(prev, live))
  ```

- **触发场景**：服务端该载荷结构演进（如 `files` 字段改名/漏发）或被代理篡改后，畸形对象进入缓存；`MessageRow` 执行 `message.files.length > 0`（channels-view.tsx:164）对 `undefined` 抛 TypeError，整条频道时间线崩溃（有 ErrorBoundary 兜底为白板错误态）。对比：agent 流的每个事件在 `parseLiveEvent` 里都有完整运行时校验（isSessionEntry/numberValue 等），说明这是同类处理中唯一的漏网者。
- **影响**：当前两端同仓同版本时不会触发，属防御缺口而非现行 bug；一旦 wire shape 变更，故障表现为整页崩溃而非降级渲染。

### F2 · 调度者 DM 状态头存在「无错误分支的永久加载」同类隐患

- **严重度**：P3（上轮「永久加载」问题的同类，本轮新找到的一处）
- **位置**：`apps/web/src/features/events/scheduler-dm-tab.tsx:42-46, 69-73`
- **证据**：

  ```tsx
  const snapshot = useQuery({ queryKey: keys.scheduler.inbox(eventId),
    queryFn: () => schedulerApi.getInbox(eventId),
    refetchInterval: active ? POLL_INTERVAL_MS : false })
  ...
  {!snap ? (
    <Badge size="sm" variant="secondary">加载中…</Badge>
  ) : ( ... )}
  ```

  整个组件没有 `snapshot.error` 分支。
- **触发场景**：`GET /api/events/:id/inbox` 持续失败（server 重启窗口、路由异常、非 ApiError 的传输错误重试 3 次耗尽）。`snap` 恒为 undefined，状态头永远显示「加载中…」，用户无法区分慢与坏。
- **影响**：仅展示层误导；refetchInterval 每 5s 仍会继续拉取，服务恢复后自愈。对照其余页面（settings-screen.tsx:95-113、tasks-page.tsx:160-173、spawn-agent-dialog.tsx:203-225 等）均有 isPending+error 双分支，此处是遗漏而非模式。

### F3 · 前端手抄共享包「单一事实源」类型，枚举漂移风险

- **严重度**：P2
- **位置**：`apps/web/src/api/types.ts:61-86, 88-130`；对照 `apps/shared/queue.ts`、`apps/shared/scheduler.ts`
- **证据**：shared 包明确声明 canonical：

  ```
  // apps/shared/queue.ts 头注释：Canonical definition — ... both import from here
  // (no hand-mirrored duplicates).
  export type QueueItemPublic = { ... params: SpawnQueueParams ... status: "pending"|"running"|"done"|"cancelled"|"failed" ... }
  ```

  而 web 端另起炉灶：

  ```ts
  // types.ts:61-77
  /** Task-queue item (mirrors the server's QueueItemPublic). */
  export type QueueItem = { ... params: Record<string, unknown> ... status: "pending"|... }
  // types.ts:79-86 重复定义了 QueueState、QueueSnapshot
  // types.ts:88-130 SchedulerInfo.config/status 用内联字面量复抄 SchedulerPolicyConfig + SchedulerStatusSnapshot
  ```

  shared 同时导出 `QueueSnapshot`/`QueueState`/`FleetInfo`（web 已 re-export FleetInfo 却又手写 SchedulerInfo）。
- **触发场景**：后端给队列新增一个终态（如 `skipped`）或给 config 加策略开关——shared 改一处即生效于 server；web 因手抄件编译照常通过，新值流入前端后在 `pendingByChallenge` 过滤、queue-list 状态徽章等处静默落入 else 分支。
- **影响**：这是审查范围第 5 项的直接答案：**大部分 domain 类型确已共享（`@aegisx/shared`，含 LiveEvent/SessionEntry/枚举守卫函数），但 queue 与 scheduler 配置两块是复制粘贴**，且 `params` 类型还被放宽成 `Record<string, unknown>`，丢失了 `SpawnQueueParams` 的字段约束。属于结构性漂移温床，非现行错误。

### F4 · 模型选择器把查询失败渲染成「无可用模型」

- **严重度**：P3
- **位置**：`apps/web/src/features/runs/model-switcher.tsx:82-86, 183-188`
- **证据**：

  ```tsx
  const models = useQuery({ queryKey: keys.models.all, queryFn: () => providersApi.listModels() })
  const items = models.data?.items ?? []   // error 时退化为 []
  ...
  {grouped.length === 0 && (
    <span className="font-medium text-foreground">无可用模型</span>
    <span>前往 设置 → 模型供应商 添加并启用一个供应商。</span>
  )}
  ```

  全组件无 `models.error` 分支。
- **触发场景**：`/api/models` 持续报错（如 provider 表损坏、500）。所有模型选择场景（启动 agent、切换模型、调度配置）下拉里只剩误导性的「无可用模型，请前往设置添加」——而设置页本身可能显示供应商一切正常。
- **影响**：排障方向被带偏（指向配置而非服务）；数据本身不丢。

### F5 · Provider 测试对话流不可取消、关闭对话框不中断

- **严重度**：P3
- **位置**：`apps/web/src/api/providers.ts:103-139`（已支持 `signal` 参数）；消费方 `apps/web/src/features/settings/provider-test-dialog.tsx:57-95` 未传
- **证据**：`streamProviderTest` 签名收 `signal?: AbortSignal` 并传给 fetchEventSource，但 `run()` 调用时只给三个参数；对话框 `onOpenChange` 直接关闭，无 abort 逻辑。
- **触发场景**：上游 provider 挂起（不回包也不断连）→ `running` 恒 true、按钮转圈，没有任何超时或取消手段；用户关掉对话框后流仍在后台跑完（持续消耗上游 token，state 写入已关闭的对话框实例）。
- **影响**：本地单用户下危害有限，但这是范围内唯一「promise 无超时且无取消」的活跃流；同类的 `syncChallengeStream`（import-challenges-dialog）至少有 onclose 校验 + 错误上抛。

### F6 · SSE 重连补偿的两处小缝隙

- **严重度**：P3
- **位置**：`apps/server/src/run/sse.ts:75-96`（seed 内容）、`apps/web/src/stream/conversation-store.ts:173-188, 383-421`
- **证据与推演**：
  1. **流式草稿不重放**：服务端重连快照只补 context/queue/activity/在途 tool，不含 `message.progress` 草稿（sse.ts:78-94）。客户端 `resetForReconnect()` 又会把非 pending 的草稿清掉。若断连恰好发生在 assistant 正在输出、且下一个 delta 迟迟不来（长 thinking 停顿、网络抖动后的静默期），重连后该条流式文本会消失，直到下一个 delta 或 commit 才回来。
  2. **未知 agent 的无限静默重连**：`streamAgent` 对不存在的 agent 走 `seed → return false`，响应以 200 + 立即 EOF 结束（routes.ts:300-302 无 404 分支）。EventSource 把「200 后干净结束」当普通断开，按浏览器默认间隔永久重试。实际上游由两层缓解：挂载前 detail 查询 404 已渲染「Agent 不存在」空态（conversation-pane.tsx:345-359）；运行中 agent 被删除则 5s 轮询下次命中 not_found 自动拆掉会话视图。故仅剩极窄窗口（删除发生在两次轮询之间且 SSE 恰好掉线）。
- **影响**：均为短暂视觉缝隙/冗余请求，不产生持久状态漂移。值得肯定的是主链路补偿是完备的：committed 断连窗口由 onReconnect 全量重拉兜底（store 只增的 committed Map 也因此安全）、在途工具由服务端快照重放兜底、频道流靠 50 条快照 + id 去重 + 60s 对账三重兜底。

### F7 · `pending` 字段是无生产者的死分支，注释与现实不符

- **严重度**：P3
- **位置**：`apps/web/src/stream/conversation-store.ts:23, 181, 308`
- **证据**：`MessageProgress.pending` 仅在 `applyEvent` 中被硬编码为 `false`（:308 `{ ...event, pending: false }`）；`resetForReconnect` 里 `if (!entry.pending) progress.delete(key)`（:181）因此总是删除一切草稿。全仓 grep 无任何 `pending: true` 生产者，发送消息也不做乐观插入（POST 后等 SSE 回声）。类注释「Keeps optimistic pending user messages」（:170-172）描述了一条不存在的路径。
- **触发场景**：无运行时触发；风险在于后续维护者依据该注释推断「乐观用户消息在重连时受保护」，而实际行为是全清。
- **影响**：认知陷阱级死代码。要么删掉 pending 维度，要么真做乐观插入，二选一。

### F8 · 初始消息加载失败后，连接正常时无任何重试路径

- **严重度**：P3
- **位置**：`apps/web/src/features/runs/conversation.tsx:198-208, 210-219, 423-428`
- **证据**：`loadMessages` 失败仅 `setLoadError(...)` 渲染底部横幅；重新触发它的入口只有 SSE 重连回调与会话操作（/new、切换会话、回溯）。若首拉失败但 EventSource 连接一直健康，横幅将无限期停留，没有重试按钮，也不会自动重拉。
- **触发场景**：页面加载瞬间后端正在重启——HTTP 首拉失败，SSE 在服务起来后正常建连，之后永远不再调 loadMessages。
- **影响**：时间线空 + 一行错误横幅，需手动切走再切回。相比 F2 至少有可见的错误提示，故降为 P3。

### F9 · `postChannelMessage` 绕过统一封装，错误形态不一致

- **严重度**：P3
- **位置**：`apps/web/src/api/channels.ts`（postChannelMessage）对照 `api/client.ts:12-45`
- **证据**：因 multipart 无法直接用 `jsonRequest`，该函数手写了一遍 status/message 解析，抛普通 `Error` 而非 `ApiError`（丢掉 `code`）；其余 13 个 api 模块全部经 `apiRequest`。另一处小分叉：`settings.importSettingsPayload` 手写 JSON headers 而不用 `jsonRequest("POST", body)`。
- **触发场景**：频道发消息失败时 toast 只有 message 没有 code，未来任何想按 code 分支的处理（如容量满 429）在该路径拿不到。
- **影响**：一致性债。顺带说明认证/baseURL 现状（审查第 6 项）：`client.ts:16` 固定相对路径 `/api`，开发期靠 vite proxy（vite.config.ts，`VITE_API_URL` 可覆写目标），无认证头——与本地单兵部署定位一致，不算问题，但意味着未来若加鉴权只有一处需要改、multipart 路径除外。

### 竞态防护核查结论（审查第 4 项，无发现）

逐点验证过快速切换场景，现有防护成立：

- 全仓无 AbortController；竞态安全完全依赖 react-query 按 key 缓存 + 组件 keyed remount + 闭包捕获，逐一核对均成立：
  - agent 切换：`AgentConversation` 无 key 但 `Conversation` 的 effect 以 `[agentId, streamPath, store, loadMessages]` 为 deps 顺序 teardown/setup（conversation.tsx:210-219）；迟到的旧 agent `loadMessages` 应答写入**闭包捕获的旧 agentId 桶**（applySnapshot(A, …)），不会污染新 agent。
  - 频道切换：`<ChannelTimeline key={active.key}>`（channels-view.tsx:775）与 `<FilesWorkspace key={challengeId}>`（task-detail.tsx:138）remount 隔离；旧实例卸载后的 setState 是无害 no-op。
  - 未读计数循环用 `cancelled` 标志防晚到写入（channels-view.tsx:725, 739, 748-750）。
  - 「加载更早」用 `loadingOlder` 门闩 + prepend 时锚定视口（channels-view.tsx:449-474, 486-496）。
- 同一事件多订阅者的顺序问题不存在结构性风险：store 通知顺序 = 监听器集合插入序，且各消费者读的都是应用完事件后的最新快照（rAF 合帧保证一致性读）。

## 建议

1. **F3（优先）**：删除 `types.ts` 中手抄的 `QueueItem`/`QueueState`/`QueueSnapshot`/`SchedulerInfo` 内联结构，改从 `@aegisx/shared` 导入（`QueueItemPublic` 可按需 alias）。这符合项目「不要维护向后兼容」的取向——直接换，不留兼容层。
2. **F1**：给 `channel.message` 补一个最小守卫（id/channelKey/body/files 数组校验，风格对齐同文件其它分支），畸形帧丢弃。
3. **F2/F4**：两处各补一个 error 分支（inbox 头显示「状态获取失败」徽章；ModelRefPicker 显示错误 + 重试按钮），对齐仓库既有 isPending/error 双分支惯例。
4. **F5**：provider-test-dialog 持有 AbortController，对话框关闭/onOpenChange(false) 时 abort。
5. **F7**：删除 `MessageProgress.pending` 及相关分支，或实现真正的乐观用户消息插入（后者同时消除「发送后到回声前输入框空白等待」的体验缝隙，但属新功能，按需决策）。
6. **F8**：loadError 横幅尾部加一个「重试」按钮指向 `loadMessages`，一行改动即可闭环。
7. **F6/F9**：低优先。F9 可让 multipart 场景给 `ApiError` 补个工厂或在 client 增加 FormData 支持；F6 的未知 agent 404 化（route 层先查再 pump）顺手可做。

## 未确认事项

- **浏览器 EventSource 默认重试节奏的实际表现**（本机 Chrome 对 200+EOF 的重连间隔）未实测，F6-2 的「无限重连」基于规范行为推演；即便间隔较长也只是冗余请求。
- **服务端重启后 `nextRevision()` 归零**是否会与客户端残留 revision 冲突：推演结论是不会——重连必经 `resetForReconnect` 清空全部 progress（pending 恒 false），单调比较从零重建；但因无法启动双端实测，未 100% 排除「重连瞬间旧 revision 事件先于 onopen 到达」的窗口（onopen 前的事件仍会被 `source.onmessage` 应用，此时 progress 尚未清空，理论可拒收一次更新；下一个更高 revision 会自愈）。
- **`@microsoft/fetch-event-source` 在页面隐藏时的行为**已被 `openWhenHidden: true` 显式关闭（platform-sync-stream.ts:180-182），providers 测试流未设该项——测试对话框在后台标签页会自动断流，是否算问题取决于使用预期，未列入发现。
- features/events 下 challenge-card、challenge-attachments、platform-binding 等组件仅做了模式扫描（isPending/error 配对、useEffect 数据流），未逐行精读；若有与 F2 同型的漏网，预计也是 P3 展示层问题。

# 错误处理与吞错审查

审查日期：2026-08-23。基线 commit：`53516ca` 之后的工作区（HEAD 干净）。本篇是「错误处理与吞错」方向的残留模式审查——上一轮（docs/code-audit-2026-08-20.md P0-3 / P1-3）已修复调度排水与消息投递两条主干的吞错日志，本轮目标是找**仍然存在的模式性问题**。

## 范围与方法

- 全仓 grep `catch`（server src + scripts 约 137 处、web src 21 处），逐处人工核别，区分：业务主干吞错 / 清理类 best-effort / 探测性 try（EEXIST、statSync、URL 构造）/ 防御性 JSON.parse。
- 重点精读：`apps/server/src/providers/`（LLM 测试代理 + 模型发现）、`apps/server/src/platforms/`（core/adapters/flags/sync/errors）、`apps/server/src/run/sse.ts` 与三处 `streamSSE` 端点、`apps/web/src/api/` + `apps/web/src/stream/`、进程入口 `apps/server/src/index.ts`。
- 对照阅读 hono 4.13.0 `streamSSE` 实现，确认流式回调异常的兜底行为。
- 只读调查，未启动任何服务，未做写操作。

## 吞错模式统计

| 模式 | 数量 | 分布 | 判定 |
|---|---|---|---|
| server `.catch(() => undefined)` | 17 | abort×8、kill/remove×4（含 recoverOnBoot）、closeAgent×1、bash overflow 写入×2、chainLock 前驱×1、deadlines×1 | 全部为清理类/best-effort，无新增主干吞错（上轮修复后未回潮） |
| server 空 `catch {}` 或 catch→默认值 | 44 | 防御性 JSON.parse ~15、文件系统/EEXIST 探测 ~8、URL 构造探测 3、HTTP body 读取降级 3、SSE pump「client gone」1、其余见发现 F2/F3/F6/F7/F12 | 多数合理；问题个案在发现中列出 |
| server `catch (error)` 后折叠/改写错误 | ~10 处关键点 | `platformError()`、`syncFailureMessage()`、`submissionErrorMessage()`、providers 路由宽 catch、discover/test 路由 | **本轮主要发现集中区**（F1–F5） |
| web `.catch(() => …)` 静默 | 3 | shiki 高亮降级×2、channels-view 未读数刷新 | 高亮降级合理；未读数刷新可接受 |
| server `console.error/warn` 记录点 | 11 | queue drain、channel delivery、live listener、boot recovery、idle sweep、flush tick、config store、platform request、app.onError、prompt failed、hono 流兜底 | 上轮补日志的主干均有覆盖 |

## 发现

### F1 [P2] `platformError()` 把未知异常折叠成通用文案，全程零日志

- 位置：`apps/server/src/platforms/errors.ts:24-30`（消费方：flags.ts:417、sync.ts:244,442 及全部平台路由）
- 证据：

  ```ts
  // errors.ts:24
  export function platformError(error: unknown): PlatformActionError {
    if (error instanceof PlatformActionError) return error
    if (error instanceof PlatformError) {
      return new PlatformActionError("platform_error", error.message)
    }
    return new PlatformActionError("platform_error", "Platform request failed")
  }
  ```

  HTTP 层与网络层失败已有 `logPlatformRequest` 双写（DB `platform_request_log` + console，service.ts:67-91），但**适配器自身代码抛出的非 PlatformError 异常不经过该钩子**。典型触发点：ret2shell.ts:45/61 对分页响应盲目 `body[0].map(...)`——平台返回形状一变即 TypeError；以及 flags/sync 内部 DB、storage.write 异常。
- 失败场景推演：ret2shell 列表接口某天返回 `{code, data}` 信封而非 `[array, total]` 元组 → `body[0].map` 抛 TypeError → `platformError` 折叠 → 路由经 `platformActionHttpError` 返回 502 `"Platform request failed"`。由于返回的是正常 Response 而非 throw，`app.onError` 不触发；`onError` 钩子也未命中——**原始堆栈在任何地方都不存在**。
- 影响：这是上轮「主干吞错补日志」后残留的最后一条无观测路径。用户看到的是通用 502，作者排查时只有「平台请求失败」五个字，无法区分代码 bug 与平台故障。flags.ts:424-428 的 `submissionErrorMessage` 同样把未知错误在 `challenge_flags.message` 里落库为通用文案。

### F2 [P2] providers 路由宽 try/catch 错误归因混淆（上轮 P1-3 已指出，未修）

- 位置：`apps/server/src/providers/routes.ts:204-206`（POST /providers）、`:238-240`（PATCH /providers/:id）、`:301-307`、`:339-345`（模型创建/更新）
- 证据：

  ```ts
  // routes.ts:200-206 — try 包住整个业务体
  const providers = cloneProviders(configStore)
  providers.push(provider)
  configStore.updateProviders(providers)   // ← 磁盘写入
  return c.json(publicProvider(provider), 201)
  } catch {
    return badRequest(c, "invalid_base_url", "Invalid provider endpoint")
  }
  ```

  `updateProviders` → config-store.ts:334-338 → `save(data)` 是真实文件写入；唯一需要 try 的只有 try 体里的 `normalizeHttpBaseUrl`（urls.ts 校验抛错）。
- 失败场景推演：配置文件只读/磁盘满/原子重命名失败 → 用户在设置页添加 provider → 得到 400 `invalid_base_url "Invalid provider endpoint"` → 用户反复检查 URL 格式，而实际是服务端持久化失败。
- 影响：把服务端故障伪装成用户输入错误，排障方向被主动误导。上轮报告已给出修法（只包 `normalizeHttpBaseUrl`，或让其抛类型化错误），至今未动。`:301/:339` 的 catch 会把 error.message 带回（较好），但 `updateProviders` 失败同样会被标成 `invalid_model_metadata`。

### F3 [P2] `/api/providers/:id/models/discover` 吞掉全部失败上下文

- 位置：`apps/server/src/providers/routes.ts:394-434`
- 证据：

  ```ts
  // routes.ts:424-433
  } catch {
    return jsonError(c, {
      code: "provider_unavailable",
      message: "Could not fetch provider models",
    }, 502)
  }
  ```

  同文件 `/test` 端点（:516-527）对同类失败的处理是刻意保留上下文的：`` `Provider test failed: ${response.status} ${upstreamBody.slice(0, 200)}` ``。两个相邻端点标准不一致。
- 失败场景推演：用户填错 baseUrl 指向一个 HTML 门户页 → fetch 成功但 `response.json()` 抛错；或 apiKey 无效 → 上游 401。三种完全不同的故障（HTML 页 / 鉴权失败 / 网络）在 UI 上呈现同一条无差别文案，且无服务端日志。
- 影响：「配置 LLM provider」是本平台的第一个使用步骤，401 vs DNS 解析失败 vs 反代 HTML 的排查动作完全不同；当前实现迫使用户用 curl 手动复现。属于诊断信息丢失而非功能失效。

### F4 [P3] provider test 连接级失败一律报「timeout」

- 位置：`apps/server/src/providers/routes.ts:488-515`
- 证据：

  ```ts
  // :489-491  timer 到点才 abort(new Error("timeout"))
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout)
  // :505-514  但 catch 不检查 abort原因
  } catch {
    clearTimeout(timer)
    return jsonError(c, { code: "provider_unavailable",
      message: `Provider test failed (timeout after ${timeout}ms)` }, 502)
  ```

- 失败场景推演：baseUrl 域名不存在 → fetch 立刻 DNS 失败 → 用户看到 `(timeout after 30000ms)`，以为等了 30 秒或怀疑网络慢，实际是秒级失败的域名解析错误。
- 影响：错误分类失真，误导排障；修复只需在 catch 里比对 `controller.signal.aborted && signal.reason?.message === "timeout"`。

### F5 [P3] `pumpUpstreamSse` 静默容忍上游流截断

- 位置：`apps/server/src/providers/routes.ts:683-722`（pump）、`:538-554`（streamSSE 回调）
- 证据：reader 循环 `if (done) break` 后直接返回 usage；调用方无条件 `await send({ type: "done", ... })`。没有跟踪上游是否发出过终止帧（OpenAI `[DONE]` / anthropic `message_stop`）。
- 失败场景推演：上游网关在长回复中途干净地关闭连接（常见于反代超时）→ pump 正常结束 → 前端测试对话框收到 `done` 并显示 token 用量——截断的回复看起来像完整成功。
- 影响：仅影响 provider 测试对话框这一诊断工具本身，恰好会在「诊断别的流问题」时给出假阴性。主 agent 循环的流中断处理在 pi SDK 内，不受此影响。

### F6 [P3] `parseModelMetadata` 静默回退默认元数据，损坏数据不可见

- 位置：`apps/server/src/providers/builtin-models.ts:192-198`
- 证据：

  ```ts
  export function parseModelMetadata(value: string): ModelMetadata {
    try {
      return normalizeModelMetadata(JSON.parse(value) as unknown)
    } catch {
      return { ...defaultModelMetadata }   // 128k ctx / 16k maxTokens / 无 reasoning
    }
  }
  ```

- 失败场景推演：手编 metadata 留下一个非法字段（如 `contextWindow: -1`）→ 保存时被路由层校验拦截（这条路径 OK）；但若 config.json 被外部编辑或未来 schema 变更导致存量数据非法 → 每次读取都静默落到默认值：compaction 触发点按 128k 计算、thinking levels 为空、成本显示 0。UI 的 `metadataSource` 字段不会反映「解析失败」这一状态。
- 影响：数据损坏被转换成「看起来正常的错误行为」，无任何日志线索。建议至少 console.warn 一次。

### F7 [P3] 会话恢复跳过损坏 entry，无任何记录

- 位置：`apps/server/src/agents/db-session-manager.ts:148-157`；同模式渲染侧 `session-queries.ts:41,230,239`
- 证据：

  ```ts
  try {
    entry = JSON.parse(row.data) as SessionEntry
  } catch {
    // Corrupt row: skip but still count its seq so the next commit does not collide.
    if (row.seq > this.nextSeq) this.nextSeq = row.seq
    continue
  }
  ```

- 失败场景推演：SQLite 行损坏（异常断电等）→ 下次 resume 该条对话内容凭空消失，agent 与用户都看不到缺口在哪；seq 计数正确保证不会崩溃，但也没有一行日志说明丢了什么。
- 影响：单机本地工具可接受「跳过不崩」，但连 console.warn 都没有意味着作者永远不知道历史被截断过。渲染侧的 skip（timeline 查询）同理但影响更小。

### F8 [P3] bash 工具溢出日志写入失败静默放弃

- 位置：`apps/server/src/run/bash-tool.ts:143-146`（调用点）、`:165-176`（writeOverflow）
- 证据：`fullOutputPath = await writeOverflow(...).catch(() => undefined)`——mkdir/tar/putArchive 任一失败都被吞掉。
- 失败场景推演：容器内 `/workspace/.aegisx/tool-output` 写入失败 → 输出被截断（`truncated: true`）但 `fullOutputPath` 缺失，工具结果里不会出现全量输出指针；agent 和用户都不知道完整输出去了哪。注释明确声明 best-effort，属有意设计，但与其他 best-effort 点不同：这里丢的是**交付给用户的数据**而非内部状态。
- 影响：低频（容器内写自己挂载目录很少失败），发生时表现为「输出莫名缺失」。一行 console.warn 即可消除盲区。

### F9 [确认无问题] 平台适配器 HTTP 错误处理链路完整

- 位置：`apps/server/src/platforms/core.ts:144-241`
- 核验结论：`PlatformHttp.request` 非 2xx 时构造的 `PlatformError` **携带 status + 平台错误码 + 从 body 提取的 message**（message/detail/error.message 三种形状都试），responseHeaders/responseBody 通过 `onError` 回调落 `platform_request_log` 表；网络层失败（DNS/超时/abort）记录 `{status: null, error}` 后原样 rethrow 不包装；`json()` 有 content-type 检查 + JSON.parse 降级文案。dasctf/tsecbench submitFlag 把「信封错误码 = 判题结果」映射为确定性 rejected 以避免重试循环，注释清晰，是有意设计而非吞错。
- 重试面核验：flag 提交轮询上限 60 次 ×1s（flags.ts:29-30）；targets 就绪轮询有上限（targets.ts:162）；LLM 自动重试委托 pi SDK 且 `maxRetries` 被 settings-schema 限幅 0–10（默认 3，settings-schema.ts:112-121）。**全仓不存在无限重试路径。**

### F10 [确认无问题] SSE 服务端清理与前端断连感知

- 核验结论：
  - `run/sse.ts:19-58` pumpLiveStream：`stream.onAbort` 置位并唤醒 idle promise → 循环退出 → `finally unsubscribe()`，订阅不泄漏；写失败（客户端消失）由 catch 终止循环，语义正确。hono `streamSSE` 兜底对回调异常 `console.error(e)` 并关流（node_modules/.bun/hono@4.13.0 sse.js run()）。
  - 服务端推送失败不静默：平台同步流中途异常会向前端发 `type:"error"` 事件（platforms/routes.ts:172-182）；agent 主流的中途失败经 lifecycle.drive catch → console.error → `agentTurnSettled(error)` 持久化 status="failed" 并广播 `agent.idle{failed:true}`（lifecycle.ts:86-95、agent-status.ts:108-122），前端能感知。
  - 前端：conversation-store `onerror` → 断连横幅 + `resetForReconnect` 清理过期 live 态 + 重连重拉 committed 历史（conversation-store.ts:395-408）；platform-sync-stream 明确 rethrow onerror 阻止库自动重放 POST、`onclose` 校验收到了 `complete` 否则报「同步流意外结束」（platform-sync-stream.ts:175-189）——两处都是容易写错的点，实现正确。

### F11 [P3] IM 频道视图 SSE 断连无 UI 提示（与对话视图不一致）

- 位置：`apps/web/src/features/runs/channels-view.tsx:413-437`
- 证据：`new EventSource(...)` 仅设 `onmessage`，无 `onerror` 处理；对比 conversation.tsx:429-433 有「正在重新连接…」横幅。缓解因素：tail 查询有 `refetchInterval` 对账（RECONCILE_INTERVAL_MS），数据最终收敛。
- 影响：断连期间频道消息延迟且无提示，直到下次轮询补齐。属体验一致性小问题，非性能或正确性缺陷。

### F12 [确认无问题，附一个 papercut] 前端 fetch 封装

- 核验结论：`api/client.ts` 非 2xx 时解析 `{error:{code,message}}` 并保留 code 供视图分支；非 JSON 错误体降级为 `${status} ${statusText}`；204 显式返回 undefined。网络错误（fetch reject）直接向上传播，各 mutation 均有 `onError → toast`。「catch 后 setState 空数组假装成功」的模式**未发现**：conversation.tsx:203-207 失败显式 setLoadError；challenge-dialog.tsx:173-183 用 `allSettled` 收集逐文件上传错误并在 onSuccess 弹出「部分附件失败」。
- Papercut：`use-provider-editor.ts:52-66` `addModels` 用 `Promise.all` 批量建模型——第 N 个失败时前 N-1 个已创建，弹窗显示错误后重试会撞 `duplicate_model` 409。错误有展示、可恢复，仅多一步手工甄别。

### F13 [P3] 进程级兜底：仅有信号处理器，无 unhandledRejection/uncaughtException

- 位置：`apps/server/src/index.ts:21-22`
- 证据：全仓 grep 仅命中 `process.on("SIGINT"/"SIGTERM")`。未注册 `unhandledRejection` / `uncaughtException`，行为完全取决于 Bun 运行时默认值（uncaught exception 打印并退出；unhandled rejection 打印但不退出——后者随 Bun 版本可能变化）。
- 影响：本地单用户场景下依赖运行时默认是可接受的选择；风险在于一次未捕获的 rejection 若发生在关键 fire-and-forget 路径上，只有 stdout 里一行默认格式日志，没有统一的退出/告警决策点。注册一个显式 handler（记录 + 对 uncaughtException 选择退出）可以把行为固定下来。

## 建议

1. **给 `platformError()` 补一条日志**（F1，最高性价比）：在折叠未知错误的分支加 `console.error("unmapped platform error", { error })`，或在 `platformActionHttpError` 入口统一记录原始 error。一处改动覆盖所有平台路由。
2. **收窄 providers 路由的 try 范围**（F2，上轮遗留）：只把 `normalizeHttpBaseUrl(...)` 包进 try；持久化失败让它穿透到 `app.onError` 变成 500。
3. **discover 端点对齐 test 端点的错误信息标准**（F3+F4）：带上 upstream status / abort reason，区分 timeout 与其他网络错误。
4. **pumpUpstreamSsE 跟踪终止帧**（F5）：未见 OpenAI `[DONE]`/anthropic `message_stop` 即结束时发 `type:"error"` 而非 `done`。
5. **三处静默降级补 console.warn**（F6/F7/F8）：metadata 解析回退、会话 entry 跳过、overflow 日志写失败。均为一行改动。
6. 可选：注册显式的 `uncaughtException`/`unhandledRejection` 处理器固化进程行为（F13）；channels-view 补 `onerror` 横幅（F11）。

## 未确认事项

- **Bun 对 unhandledRejection 的确切默认行为**（打印后继续 vs 按版本退出）未实测验证——本机未运行任何进程；F13 的表述基于 Bun 公开文档印象，落地修复前建议先 `bun -e` 实测一次。
- **pi SDK 内部的 LLM 错误分类质量**（超时/限流/malformed response 是否保留原始 upstream body）不在本仓代码内，无法核验；AegisX 侧只能观察到 `prompt()` reject 后的 `error.message` 字符串。若 pi 把上游 4xx body 折叠进 message，F1 同样的「上下文丢失」问题也存在于 agent 主循环，需在 pi 仓库单独核查。
- `run/service.ts:988` `closeAgent(sibling.id).catch(() => undefined)`（删除赛事时批量关闭兄弟 agent）失败静默——closeAgent 自身有锁和善后逻辑，未能构造出它会失败且产生可见后果的场景，暂按清理类吞错归类，不做发现上报。

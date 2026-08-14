# AegisX 清理计划 P4：UI 结构冗余 + 依赖替换

状态：**已执行完毕**（见文末「执行结果附记」）
前置：`docs/cleanup-p0-p2.md`（已实施或进行中）。两计划相互独立，可在此期间执行。
本文档是执行的唯一依据：按条目顺序执行，每个条目独立 commit、统一验证。

## 基线快照（行数以符号定位为准，P0–P2 落地后行号会漂移）

| 文件 | 基线行数 | 涉及条目 |
|---|---|---|
| `apps/web/src/features/events/plan-tab.tsx` | 65 | E1 |
| `apps/web/src/features/events/event-agents.tsx` | 168 | E1、E4 |
| `apps/web/src/features/events/event-page.tsx` | 587 | E4 |
| `apps/web/src/features/events/challenge-dialog.tsx` | 732 | E3 |
| `apps/web/src/features/runs/conversation.tsx` | 937 | E2 |
| `apps/web/src/features/events/platform-sync-stream.ts` | 192 | N2 |
| `apps/server/src/platforms/routes.ts` | 219 | N2 |
| `apps/server/src/run/workspace/tar-stream.d.ts` | 40 | N1 |
| `apps/server/src/run/workspace/tools.ts`（detectImageMime） | ~48 | N3 |

验证命令（每个条目完成后全绿）：

```sh
bun run check && bun run test && bun run build
```

## 执行总则

1. `apps/web/src/components/ui/**` 只读。
2. 每条目一个 commit，message 前缀 `cleanup(p4-e1|e2|e3|e4|n1|n2|n3):`；条目内改动一次性完成后统一验证。
3. E 系列是纯移动/合并，不改行为、不改样式、不改文案；N 系列是等价替换，保持对外语义。
4. 新增依赖已经用户确认（tar-stream 主版本升级、@types/tar-stream、@microsoft/fetch-event-source、file-type），无需再次询问。

---

## E1. 删除 plan-tab.tsx（内联到 tab 容器）

事实：`PlanTab` 是 `QueueList` 的**唯一**消费者，本身只做 status 过滤（`["pending","running","failed"]`）+ 空状态 + 标题/Badge/Card 包装，然后原样渲染 `<QueueList>`。

动作：
1. 删除 `apps/web/src/features/events/plan-tab.tsx`。
2. 其实质内容（约 30 行：`visibleQueue` 过滤、`Empty` 空状态、`计划队列` 标题 + Badge + Card 包装）内联进 E4 合并后的 tab 容器的 `plan` panel（E1 先于 E4 执行时，先内联进 `event-agents.tsx`）。
3. 顺带删除 `QueueList` 的 `onChanged` prop：`queue-list.tsx` 内部的 `invalidate()` 已自行 invalidate `scheduler.queue` 与 `runs.fleet` 两个 query key，plan-tab 传入的是 `() => undefined` 纯占位。注意 `EditQueueItemDialog` / `ClearQueueButton` 的 `onChanged` 是组件内部回调（接 `invalidate`），**保留**。

验证：`rg -n "PlanTab|plan-tab" apps/web/src` 无残留；`rg -n "onChanged" apps/web/src/features/events/queue-list.tsx` 仅剩内部回调；build 全绿。

## E2. conversation.tsx（937 行）拆四件

现状结构（按符号）：
- `ConversationProps` / `SessionOps` 类型 + `Conversation` 主体（store 装配、SSE effect、mutations、渲染骨架）
- `MessageInput`（592–737）+ `COMPOSER_COMMANDS` / `ComposerCommand`（仅 MessageInput 使用，见 659 行）
- `formatStatTokens` + `ContextStatStrip`（738–807）
- `QueueRow` 类型 + `SteerQueue`（808–937）

目标（`apps/web/src/features/runs/`）：
| 新文件 | 内容 | 预计行数 |
|---|---|---|
| `conversation.tsx` | Conversation 主体 + 两个类型 | ~470 |
| `message-input.tsx` | MessageInput + COMPOSER_COMMANDS + ComposerCommand | ~160 |
| `context-stat.tsx` | formatStatTokens + ContextStatStrip | ~80 |
| `steer-queue.tsx` | QueueRow + SteerQueue | ~130 |

规则：纯移动，props 签名不变；被移动的组件从非导出改为导出。不重命名、不调整 JSX。

验证：build 全绿；会话页视觉无变化（手动打开一个 run 对话页冒烟：输入框、命令菜单、状态条、运行中 steer 队列各看一眼）。

## E3. challenge-dialog.tsx（732 行）拆三件

现状结构（按符号）：
- `ChallengeDialog`（100–142，trigger + open 态）
- `ChallengeDialogContent`（143–489：表单、保存/上传 mutation、附件 section 壳、平台目标 section）
- `AttachmentRow`（490–564）、`PendingFileRow`（565–595）、`formatBytes` / `pendingFileKey` / `mergePendingFiles`（59–81）
- `FLAG_STATUS_LABEL` + `FlagsSection`（596–694）+ `FlagRow`（695–732）

目标（`apps/web/src/features/events/`）：
| 新文件 | 内容 | 预计行数 |
|---|---|---|
| `challenge-dialog.tsx` | ChallengeDialog + ChallengeDialogContent + 表单/目标 section | ~500 |
| `challenge-attachments.tsx` | AttachmentRow + PendingFileRow + formatBytes（若仅行组件使用）| ~120 |
| `challenge-flags.tsx` | FLAG_STATUS_LABEL + FlagsSection + FlagRow | ~140 |

规则：
- `FlagsSection` 是自足组件（props: challenge + eventId），整体移动，零改动。
- `AttachmentRow` / `PendingFileRow` 已接 props 回调，纯移动。**pendingFiles state 与上传 mutation 留在 DialogContent**（它们与表单提交耦合）——只移"行级展示组件"，不强行拆 state。若 `pendingFileKey` / `mergePendingFiles` 只被 DialogContent 调用，留在原文件并从 challenge-attachments.tsx 导入/或反向，以现场引用方向定，避免循环导入。

验证：build 全绿；挑战详情对话框冒烟（附件列表、待上传行、flags 区、平台目标区）。

## E4. event-agents.tsx 并入 event-page.tsx

事实：`EventAgents` 仅被 `event-page.tsx` 的 agents panel 引用；自身只是 OverviewTab 状态 + selection + fleet/scheduler/queue 三个查询 + Tabs 容器 + AgentsGraph + AgentDialog。

动作：
1. 将 `EventAgents` 全部内容移入 `event-page.tsx` 作为**本地组件**（建议名 `EventAgentsPanel`，非导出），`event-page` 的 agents panel 改为渲染它。
2. 删除 `event-agents.tsx`。
3. `event-agents-shared.ts` **保留**（POLL_INTERVAL_MS、SchedulerWithAgents、TimelineEvent 等被多个 tab 组件消费）。
4. 预期 event-page.tsx 增至 ~700 行——这是接受的中间态（消除 4 层嵌套优先于文件行数；后续如需可再拆挑战过滤 UI，不在本计划）。

执行顺序：**E1 → E4**（E1 内联进 event-agents.tsx，E4 再整体上提），两步各自验证。

验证：`rg -n "EventAgents\b|event-agents\"" apps/web/src` 无残留（event-agents-shared 除外）；agents 总览页冒烟（五个子 tab、图谱、agent dialog、队列操作）。

---

## N1. tar-stream v2 → v3 + @types/tar-stream

事实：`tar-stream@2.2.0` 只在 `backend.ts` 的 `buildSingleFileTar` 使用（仅 `pack()`，无 `extract()`）；`tar-stream.d.ts` 是 40 行手写环境声明，与 @types 包提供的声明会冲突。

动作：
1. `apps/server/package.json`：`tar-stream` 升级 `2.2.0` → `^3.2.0`；devDependencies 加 `@types/tar-stream@^3.1.4`。
2. 删除 `apps/server/src/run/workspace/tar-stream.d.ts`。
3. v3 的 pack API 与 v2 兼容（`pack()` / `entry()` / `finalize()`），v3 为 ESM-only——server 是 `type: module` + Bun，无影响。`buildSingleFileTar` 代码预期零改动（若 oxlint 报 import 顺序，`bun run fmt`）。
4. 已有测试 `test/run(s)/workspace.test.ts` 的 `buildSingleFileTar` 断言（tar 结构）必须原样通过——这是 v3 行为等价性的直接证据。

验证：`bun install` 后 check + server 测试全绿；`rg -n "declare module \"tar-stream\"" apps` 无残留。

## N2. 平台同步流：hono streamSSE + @microsoft/fetch-event-source

现状：server 端 `platforms/routes.ts` 用 `streamText` 写 NDJSON 行；web 端 `platform-sync-stream.ts` 手写 `getReader` + `TextDecoder` + buffer `split("\n")` 循环（~35 行）。

动作：
1. **server**：`streamText` → `streamSSE`（同为 `hono/streaming` 导出），每帧改为 `await stream.writeSSE({ data: JSON.stringify({...}) })`，原来四类事件（progress / item / complete / error）的 JSON 载荷不变。`streamSSE` 自动设置 `text/event-stream`，与 fetch-event-source 的默认 onopen 校验匹配。
2. **web**：加依赖 `@microsoft/fetch-event-source@^2.0.1`。
3. **重写 `syncChallengeStream`**：
   - `fetchEventSource(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remoteIds }), ... })`（等价替换现有 `jsonRequest("POST", ...)` 的用法）。
   - `onmessage(ev)` → `parseSyncStreamLine(ev.data)`，分发逻辑（error 抛错 / complete 记 syncedAt / item 收集 + onEvent 回调）保持现状。
   - 自定义 `onopen`：`response.ok` 为假时抛 `同步失败（${response.status}）`，保持现有中文错误语义。
   - **`onerror` 必须 throw**：该库默认按间隔自动重连，重发 POST 会重新触发整轮同步——必须显式中断。
   - **`openWhenHidden: true` 必传**：该库默认在 `document.hidden` 时 abort 流。现有 fetch 实现不感知页面可见性，保持该语义。
   - `onclose` 中处理"流正常结束但缺 syncedAt"的现有错误（`同步流意外结束`）。
4. `parseSyncStreamLine` 及其运行时守卫（isResult/isProgress，~100 行）**保留不动**——它们校验的是 JSON 载荷，与传输层替换无关。

验证：check + build 全绿；**手动冒烟**：对任一已连接平台的事件触发一次题目同步，观察进度事件逐条到达、完成/错误路径正常。

## N3. file-type 替换 detectImageMime

事实：`workspace/tools.ts` 的 `detectImageMime`（~48 行）手写 jpg/png/gif/webp 四种 magic bytes；唯一调用点在 read 工具的 `execute`（async 上下文）。

动作：
1. `apps/server/package.json` 加依赖 `file-type@^22`（纯 ESM，Bun 支持）。
2. `workspace/tools.ts`：删 `detectImageMime`；调用点改为：

   ```ts
   const detected = await fileTypeFromBuffer(bytes)
   const mime = detected?.mime.startsWith("image/") ? detected.mime : null
   ```

   语义保持：只有 `image/*` 才走附加分支；file-type 检测出的非图片类型（pdf/zip 等）与现在一样落回文本/二进制读取路径。
3. 已有测试 `test/run(s)/read-image.test.ts`（text-only model、超限、attach 三条路径）必须原样通过。

验证：check + server 测试全绿；`rg -n "detectImageMime" apps` 无残留。

---

## 总验收清单

- [ ] `bun run check && bun run test && bun run build` 全绿（每条目 commit 时）
- [ ] `rg -n "PlanTab|detectImageMime|declare module \"tar-stream\"" apps` 无残留；`event-agents.tsx` / `plan-tab.tsx` / `tar-stream.d.ts` 已删除
- [ ] features/runs 四件（conversation ~470 / message-input ~160 / context-stat ~80 / steer-queue ~130）
- [ ] features/events 挑战对话框三件（~500 / ~120 / ~140）
- [ ] 依赖变更：+ `@types/tar-stream`、`@microsoft/fetch-event-source`、`file-type`；`tar-stream` → ^3.2.0
- [ ] 手动冒烟四项：会话页（E2）、挑战对话框（E3）、agents 总览（E4）、平台同步（N2）
- [ ] git log 七个条目各自成 commit 且可独立通过 check+test

## 不做（留档）

- `parseSyncStreamLine` 运行时守卫的简化（信任服务端类型）——独立决策，另议
- event-page.tsx 挑战过滤 UI 的进一步拆分——待合并后观察
- E 系列不重构任何样式/文案/交互

## 执行结果附记（存档时补记，含对本文档两处错误假设的纠正）

1. **N1 纠正**：tar-stream@3.2.0 实为 CJS（`main: index.js`，具名导出，无
   default），本文档“ESM-only”表述有误。实际改为 `import { pack } from
   "tar-stream"`（backend.ts 与 workspace.test.ts 同步）；tar round-trip
   测试断言零改动。
2. **N3 最终方案**：本文档假设 file-type 与手写 magic bytes 等价，但 v20+
   对 PNG 严格校验 IHDR+IDAT，签名级 fixture 无法检出。执行分两步：先以
   customDetectors 保留签名级 PNG 检测器；后经用户确认改为方案 B——删除该
   检测器、把 fixture 换成结构合法的 1×1 PNG（断言零改动），非 image/*
   检出（含截断的 PNG）落回文本/二进制路径。
3. **N2 附注**：删除了不可达的 `!response.body` 分支（fetch 对 200 响应
   必然带 body 流）；`onerror` 抛错中断重连与 `openWhenHidden: true` 均已
   落实，中文错误语义保留。

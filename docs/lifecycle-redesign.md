# AegisX 会话生命周期重设计（v4 → v5）

Status: **superseded by v8** — the per-agent lifecycle (惰性 session、per-agent
锁 + 代次、run 状态 SQL 派生) lives in [orchestration-redesign.md](./orchestration-redesign.md)
(implemented P0–P5). This document is the v4→v5 plan, kept for history.
Related: [architecture.md](./architecture.md)、[refactor-v4.md](./refactor-v4.md)

## 一、为什么要做

v4 把「agent 结束一轮 turn」和「run 销毁」焊死了：`prompt()` 一 resolve，`finalize`
就 dispose session + 杀容器 + 标终态。于是逼出整套 `resume`（重建容器 + 重开 session +
发罐头 prompt "Continue from where you left off."）。

现在完全用 pi-sdk，应该**围绕 pi 的状态来**：一个 session 本质就是一段对话，`isStreaming`
二分；jsonl 是持久真相，`SessionManager.open` 廉价无损重建。所以「结束后续话」根本不该
是重建，而是**给常驻 session 再 `prompt()` 一次**。

本方案消除 `resume` 概念，把 run 重定义为「一个常驻 pi session + 一个容器」，状态围绕
`isStreaming` + 容器是否存活，turn 结束默认**不拆**资源。

## 二、状态模型

只有三个状态（`streaming + cold` 不可能，所以三值够用）：

| status | pi (`isStreaming`) | 容器 | 含义 |
|--------|-------------------|------|------|
| `running` | streaming | warm | agent 在跑这一轮 |
| `idle` | idle | **warm** | 一轮自然结束 / Esc / pi 出错；容器**保留**，随时秒回 |
| `closed` | idle | **cold** | 容器已释放（finish_run 后 / 手动关闭 / 崩溃恢复）；jsonl 保留，可冷恢复 |

> 旧的 `completed / failed / stopped / timed_out` 全部废除：
> - `completed` → 拆给 `finish_run`（summary + `completedAt`）+ `submit_flag`（flag）。
> - `failed` → 降级为 `idle` + `error` 字段（容器照常保留到手动关闭）。
> - `stopped` → stop 现在是 Esc（取消当前轮 → idle），不是终态。
> - `timed_out` → 延后项；若日后加超时，等同 abort → idle。

### 状态机

```
                 ensureWarm()+prompt(text)
   ┌─────────────────────────────────────────────┐
   │                                             ▼
 [closed] ──── 发消息(冷恢复) ────►  [idle] ◄──► [running]
 cold, jsonl 在                     warm        warm
   ▲                                │  │           │
   │                                │  │ stop(Esc) │ steer/followUp
   │  finish_run resolve            │  │ abort     │ (排队进当前轮)
   │  手动 close                     │  ▼           │
   │  崩溃恢复                       └ (turn resolve, 非 finish) ── idle
   │                                                
   └────────────────── delete(任意状态) ──► 删除行+jsonl+workspace
```

转换规则（service 层）：
- **turn resolve，本轮调过 finish_run** → `closed` + 写 summary/completedAt + 释放容器/session（留 jsonl+workspace）。
- **turn resolve，其余（自然结束 / abort / pi 出错）** → `idle`（保留容器+session）；有错写 `error`，下次成功 turn 清掉。
- **发消息给 idle（warm）** → 直接 `prompt(text)`，零重建。
- **发消息给 closed** → 冷恢复（重建容器 + `SessionManager.open` + `createAgentSession`）→ `prompt(text)`。
- **发消息给 running** → `steer` / `followUp`（按 `isStreaming` 分流，**不看 run status**）。
- **stop（Esc）** → `session.abort()` → 当前轮结束 → settle 到 `idle`（**不动容器**）。
- **手动 close** → 若在跑先 abort → 释放容器/session → `closed`（留 jsonl）。
- **delete** → 有 warm 容器则一起关 → 删 jsonl + workspace + 行。
- **recoverOnBoot** → 之前 `running`/`idle`（持有过活资源）的一律标 `closed`，顺手杀孤儿容器；不自动恢复。

### 「解出题目」怎么判断（两个独立信号）

- **`finish_run`** = agent 主观声明「我做完了」→ 触发容器释放 + 记 summary/completedAt。**不代表答对。**
- **`submit_flag` 成功**（平台校验通过）= 客观「解出」→ 写 `run.flag`。

列表 badge：有成功提交 → 绿 `solved`；`finish_run` 调过（completedAt 非空）→ `finished`。
**容器释不释放只跟 finish_run 走，跟对错无关**（flag 错了重试 = 重建容器，已接受）。

## 三、动作集

| 动作 | 行为 | 可用状态 |
|------|------|---------|
| 发消息 | running→steer/followUp；idle→prompt；closed→冷恢复+prompt | running/idle/closed |
| **stop（Esc）** | `abort()` 取消当前轮 → idle，不动容器 | running |
| **关闭容器（close）** | 释放容器+session → closed，留 jsonl | running\* / idle |
| finish（强制） | 设 pending finish + abort → closed+summary | running/idle |
| 删除 | 关容器（若有）+ 删 jsonl + workspace + 行 | 任意 |

\* running 时 close 先 abort 再释放。

> `resume` 作为用户/路由概念**彻底删除**。冷恢复是「给 closed run 发消息」时的内部实现细节，用户感知不到。

## 四、系统提示词改动

冷恢复后容器是全新的（/tmp、gdb 会话、运行中进程都没了），agent 会懵。在
`DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE`（`apps/shared/prompt-defaults.ts`）加一段常驻说明，
冷恢复时系统提示词会重渲染，自然生效。建议文案（放 `## Tools` 或新增 `## Environment lifecycle`）：

> 你运行在一个隔离容器里。当你调用 `finish_run` 结束任务后，若用户稍后让你继续工作，
> **容器会被重建为全新状态**——你之前的发现保留在 workspace 文件和本对话历史里，但容器内
> 任何内存态、临时文件、运行中的进程都已丢失，需要重新建立（如重新拉起靶机连接、重建
> exploit 进程等）。

child 模板无需改（child 在一次 spawn_agent 调用内 run-to-completion，不跨 turn 复活）。

## 五、Schema 变更（v4 → v5，wipe）

`SCHEMA_VERSION = 4 → 5`。本地单用户，wipe 重来（见 §六 迁移 runbook）。

`apps/server/src/db/schema.ts`：
- `runs.status` check 约束：`in ('running','completed','failed','stopped','timed_out')`
  → `in ('running','idle','closed')`。
- `agents.status` check 约束：`in ('running','completed','failed','stopped')`
  → `in ('running','idle','completed','failed')`（main 用 running|idle；child 用 running|completed|failed）。
- 现有列复用，**不加列**：`completedAt`/`summary` 表示 finish_run 时刻与摘要；`error` 表示最近一轮错误；`flag` 表示已接受 flag。无需新增 `finishedAt`/`containerState`——三态 status 已编码容器维度。

`apps/server/src/db/index.ts` `assertCompatibleSchema`：
- `userVersion < SCHEMA_VERSION`（即 v4 库 user_version=4 < 5）会自动被现有分支拒绝；
  只需把错误文案里的「v4」改成「v5」。

`apps/server/src/db/schema-compat.test.ts`：
- `fresh database ... user_version=4` → `5`；`rejects v3` 保留；可补 `rejects v4` 用例。

`apps/shared/run-status.ts`：
```ts
export type RunStatus = "running" | "idle" | "closed"
// 删除 TERMINAL_RUN_STATUSES / isTerminalRunStatus（无终态，closed 可恢复）
// isActiveRunStatus(status) = status === "running" || status === "idle"  // 容器 warm
export type AgentStatus = "running" | "idle" | "completed" | "failed"
```

> `apps/shared/challenge.ts` 的 `runStatusCounts: Record<RunStatus, number>` 随之自动变
> `{running, idle, closed}`，无需手改；但消费它的 `catalog.ts` SQL 要改（见 §七）。

## 六、配置迁移 runbook（wipe 不碰 config.json）

> DB 在 `data/aegisx.sqlite*`；配置在 `data/config.json`。**删 DB 不影响 config.json**，
> providers / API key 自动保留。所谓「迁移配置」只是确保提示词回退到含新说明的默认值。

1. 停 server。
2. 检查 `data/config.json` 的 `settings` 是否含 `prompts.mainSystem` / `prompts.childSystem`
   / `prompts.initial`：
   - 若有且等于旧 v4 默认值 → 删掉这几个 key（强制回退到代码里的新默认值，含 §四 的容器重建说明）。
   - 若是用户自定义 → 保留，但需手动把 §四 文案补进 mainSystem。
   - 一行清理（谨慎，先备份）：`bun -e "const f='data/config.json';const c=require('./'+f);delete c.settings?.['prompts.mainSystem'];delete c.settings?.['prompts.childSystem'];delete c.settings?.['prompts.initial'];require('fs').writeFileSync(f,JSON.stringify(c,null,2))"`
3. `rm -f data/aegisx.sqlite*`（wipe DB）。
4. （可选）`rm -rf data/runs/` 清掉 v4 残留 run 目录（jsonl+workspace 孤儿；不清也无害，只是占盘）。
5. 重启 → v5 bootstrap 建新库；config.json 的 providers/API key 原样可用。

> 是否把「剥 prompts.* 回退默认」做成 `migrateLegacySettings`（shared）里的自动一次性迁移，
> 留作实施时决定；单用户本地，runbook 一行清理也够。

## 七、后端改造（文件 / 函数级）

### `apps/server/src/run/service.ts`（核心，重写生命周期）

删除：`resume`（函数 + 暴露）、`finalize`（拆成 `settleTurn`/`idleRun`/`freeRun`）、
罐头 `"Continue from where you left off."`。

新增/改写：
- **`driveRun(runId, text)`**：置 status=`running` + emitRun；`session.prompt(text)`
  `.catch(e=>err=e).then(()=>settleTurn(runId, err))`。turn resolve 默认不拆资源。
- **`settleTurn(runId, runError)`**（取代 finalize 的非销毁语义）：
  ```
  outcome = pending.get(runId); pending.delete(runId)
  if outcome?.mode === "finish"  → freeRun(runId, { summary, completedAt })   // closed + 摘要
  else if outcome?.mode === "close" → freeRun(runId)                          // closed 无摘要
  else → idleRun(runId, runError)                                             // idle 保留容器
  ```
- **`idleRun(runId, runError?)`**：status=`idle`；有错写 `error`+agent error，无错清 `error`；
  **不 dispose、不杀容器**；main agent 标 idle；emitRun + emitAgents。
- **`freeRun(runId, { summary?, completedAt? })`**（唯一释放点）：terminate 容器 +
  dispose session + 移出 `sessions`/`contexts` map；status=`closed`；写 summary/completedAt；
  **保留 jsonl + workspace**；emitRun。
- **`ensureWarm(runId)`**：若 run 已 warm（session 在 map）→ no-op 返回；若 `closed` →
  冷恢复（建容器 + `SessionManager.open(mainAgent.sessionFile)` + `createAgentSession` +
  订阅 pipeline + 入 map + 重建 contexts）。失败抛 `launch_failed`。即现 `resume` 的「重建」
  主体，但不发罐头 prompt、不由用户显式触发。
- **`sendMessage(runId, { text, deliverAs })`**（取代 `steer` + `resume`，统一入口）：
  ```
  const s = sessions.get(runId)
  if (s && s.session.isStreaming) {                          // running
    deliverAs === "followUp" ? await s.session.followUp(text) : await s.session.steer(text)
    return
  }
  await ensureWarm(runId)                                    // idle(warm) no-op / closed 冷恢复
  pending.delete(runId)
  driveRun(runId, text)
  ```
  全程 `withLock`。
- **`stop(runId)`**（Esc）：`if (s?.isStreaming) await s.session.abort()`；不动容器；
  abort → turn resolve → settleTurn → idle。（不再设 pending stop / 不再 finalize。）
- **`close(runId)`**（手动关闭容器）：`pending.set(runId,{mode:"close"})`；
  若在跑 `await s.session.abort()`（→ settleTurn 走 close 分支 → freeRun）；若 idle 直接 `freeRun`。
- **`finish(runId, summary)`**（强制 finish，HTTP /finish）：`pending.set(runId,{mode:"finish",summary})`；
  若在跑 `abort()`，若 idle 直接 `freeRun(runId,{summary,completedAt})`。
- **`requestFinish`**（finish_run 工具回调）：`pending.set(runId,{mode:"finish",summary})`。
  工具返回 terminate 结束本轮 → settleTurn → freeRun(closed+summary)。
- **`create`**：建 session+容器（warm）；插 run status=`running`；`driveRun(runId, initialPrompt)`。
  首轮 resolve → settleTurn → idle（或 agent 立即 finish_run → closed）。**不再 finalize。**
- **`deleteRun`**：若 warm（容器在）→ terminate + dispose；`rm -rf runDir`（jsonl+workspace）；
  删行。（基本沿用现状，确保兼容新常驻态。）
- **`recoverOnBoot`**：`status in (running, idle)` 的行 → 杀孤儿容器（若在）→ 标 `closed`
  （completedAt/summary 不动，仅表示资源已释放、可冷恢复）。不调模型。

返回对象暴露：`create / sendMessage / stop / close / finish / delete / recoverOnBoot /
close(inner) / listMessages / get / detail / ...`；**移除 `resume`、`steer`**。

### `apps/server/src/run/routes.ts`

- `POST /api/runs/:id/message` → `sendMessage({ text, deliverAs })`（body 同现 messageInput）。
- `POST /api/runs/:id/stop` → `stop`（Esc）。
- **新增** `POST /api/runs/:id/close`（emptyInput）→ `close`。
- `POST /api/runs/:id/finish` → `finish(summary)`（保留，强制完成）。
- `DELETE /api/runs/:id` → `delete`。
- **删除** `POST /api/runs/:id/resume`。

### `apps/server/src/run/public.ts` / `queries.ts`

- `toRunPublic`：status cast 到新三态；`hasFlag`（solved）、`completedAt`/`summary`（finished）
  已有字段，无需加列。可补 `isFinished = completedAt != null`、`isSolved = hasFlag` 便于前端。
- `listForEvent`/`detail`：无需改逻辑（status 取值变了，过滤随之生效）。

### `apps/server/src/run/events.ts`

- 无需改（事件投影与 status 无关；turn 结束照常 commit，settleTurn 负责状态）。
- `agent_end` 的 `willRetry` 跳过 commit 逻辑保留。

### `apps/server/src/run/tools.ts`

- `finish_run` 工具的 `requestFinish(summary)` 回调不变（仍 `pending.set({mode:"finish"})`）。
  唯一变化：工具返回 terminate 后，service 侧 settleTurn 走 `freeRun`（closed）而非旧 finalize。

### `apps/server/src/events/catalog.ts`（事件/题目列表聚合，**必改**）

旧 SQL 按废弃状态计数并据此判「solved」，新模型无 `completed/failed/stopped/timed_out`，会全部归零/报错。改：

- **`solvedCount`（事件级）**：`challengeRemote.solved=1 OR exists(select 1 from runs where challengeId=… and flag is not null)`
  —— 以**被接受的 flag**（submit_flag 成功）为客观解出信号（替代旧的 `status='completed'`）。
- **`runStatusCounts`（题目级）**：计数键随 `RunStatus` 自动变 `{running, idle, closed}`；SQL 的 `case when status=…` 改成新三态。
- **题目 `status`**：`solved` = `remote.solved OR exists(run with flag)`；否则 `runCount>0` → `in_progress`；否则 `not_started`。（`completedCount>0` 这条判据换成 flag。）
- **`activeRunCount`**：`status in ('running','idle')`（warm 即活跃；closed 算归档）。
- 顺带：`publicChallenge` 里 `failedCount/stoppedCount/timedOutCount` 局部变量与 `runStatusCounts` 旧键一并换成 `idleCount/closedCount`。

> `runStatusCounts: Record<RunStatus, number>`（`apps/shared/challenge.ts`）类型跟随 RunStatus 自动更新，无需手改。

### `apps/shared/prompt-defaults.ts`

- `DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE` 补 §四 的容器重建说明段。

## 八、前端改造（文件级）

### `apps/web/src/api/runs.ts`

- `steerRun` → 重命名 `sendMessage(runId, { text, deliverAs? })`，仍打 `POST /message`。
- 新增 `closeRun(runId)` → `POST /close`。
- **删除** `resumeRun`。
- `stopRun` / `finishRun` / `deleteRun` 保留。

### `apps/web/src/features/runs/runs-view.tsx`（列表 badge）

- 每行两个 badge 清晰显示：
  - **pi 状态**：`running` → 旋转点/info；`idle`/`closed` → 静止点。
  - **容器状态**：`running`/`idle` → warm（如「容器运行中」）；`closed` → cold（如「已释放」）。
- 额外标记：`hasFlag` → 绿 `solved`；`completedAt` 非空 → `finished`。
- 分区建议：**Open**（running|idle，warm，正在做的）在上，**Shelved**（closed，已释放可恢复）
  在下；两区都可发消息/删除。（具体分区可实施时定，badge 是硬要求。）
- 轮询触发：`some(r => r.status === "running")` 维持（idle/closed 不需高频轮询）。

### `apps/web/src/features/runs/run-workspace.tsx`（动作区）

- 头部动作按状态：
  - `running`：[Stop（Esc）] [Close] [Delete]
  - `idle`：[Close] [Delete]
  - `closed`：[Delete]
- **移除 Resume 按钮**。
- Stop 文案改为「取消当前轮」（title 说明等同 Esc，容器保留）。

### `apps/web/src/features/runs/conversation.tsx`（消息路由 + 输入框）

- 输入框**三种状态都显示**（running/idle/closed 都可发消息）。
- 发送：统一 `sendMessage({ text, deliverAs })`；后端按状态路由，前端不用判断。
- steer/followUp 切换：**仅 running 时显示**（idle/closed 是 prompt 新轮，无队列语义）。
- placeholder 随状态：running→「插队/追加消息」；idle→「继续给 agent 指令」；closed→「重新打开并继续（容器将重建）」。
- 现有 store/SSE/loadMessages 结构保留。

### `apps/web/src/stream/conversation-store.ts`

- `terminalStatuses` 概念删除/置空：**没有任何状态是终态**（closed 可恢复）。SSE 连接生命周期
  跟随「是否在查看该 run」，不跟 status。`closeOnTerminal` 退役或改成 no-op。
- `resetForReconnect`（已加）保留——closed run 重新发消息冷恢复后，SSE 重连仍需清 ephemeral。

### `apps/web/src/domain` / 其它

- 无需改（ConversationItem 模型与 status 无关）。

## 九、SSE / 事件

- `live.ts` 不变；每次 status 翻转（running/idle/closed）都 `emit run.updated`，前端据此刷新 badge。
- closed run 无活 session → 无 live 事件，但 EventSource 可常开（无害）；发消息冷恢复后会重新出事件。

## 十、实施顺序（Phase）

> 一轮改完统一 `check`/`test`/`build`（AGENTS.md 节奏）。

- **P1 shared + schema**：`run-status.ts` 三态、`SCHEMA_VERSION=5`、schema check 约束、
  `db/index.ts` 文案、`schema-compat.test.ts`、`prompt-defaults.ts` 补段。
- **P2 service 核心**：`settleTurn`/`idleRun`/`freeRun`/`ensureWarm`/`sendMessage`/`stop`/`close`/
  `finish`/`create`/`deleteRun`/`recoverOnBoot`；删 `resume`/`steer`/`finalize`/罐头 prompt。
- **P3 routes + public**：`routes.ts`（message/stop/close/finish/delete，删 resume）；
  `public.ts`/`queries.ts` 适配。
- **P4 前端**：`api/runs.ts`、`runs-view.tsx` badge、`run-workspace.tsx` 动作、`conversation.tsx`
  路由、`conversation-store.ts` 去终态。
- **P5 验证**：`apps/server` `bun run check` + `bun test`；`apps/web` `check` + `build`；
  手动 E2E（§十一）。

## 十一、验证清单

- [ ] `apps/server`：`bun run check` 绿；`bun test`（schema-compat 更新到 v5）绿。
- [ ] `apps/web`：`bun run check` + `bun run build` 绿。
- [ ] 迁移 runbook 跑通：wipe DB 后 config.json 的 providers/API key 仍在，新建 run 可选模型。
- [ ] E2E（需 Docker + API key，你跑）：
  1. 新建 run → agent 跑一轮自然结束 → 状态 `idle`，**容器仍在**。
  2. idle 直接发消息 → 秒回（无重建），新 turn。
  3. agent 调 `finish_run` → 状态 `closed`，容器释放，summary 落库；列表 badge 显示 finished。
  4. 给 closed run 发消息 → 冷恢复（容器重建）→ 继续；系统提示词的容器重建说明生效。
  5. running 中发 steer/followUp → 排队进当前轮。
  6. running 中 Stop（Esc）→ 当前轮取消 → idle，容器保留。
  7. 手动 Close（idle）→ closed（容器释放，jsonl 留）。
  8. Delete（任意态）→ 有容器则一起关 + 删 jsonl/workspace/行。
  9. 崩溃恢复：kill server → 重启 → 之前 running/idle 的 run 标 closed，杀孤儿容器。
  10. `submit_flag` 成功 → 列表 `solved` badge。

## 十二、不做 / 延后

- **target 状态 badge**：本轮不做（你已确认）。
- **per-run timeout**（`timed_out`）：仍延后；若加，等同 abort → idle。
- **idle 超时自动 close**（回收闲置容器）：本轮不做；现靠手动 close + finish_run 释放。
  日后可加可配 idle 超时 → 自动 close（留 jsonl）。
- **usage/cost 回填 Overview**：✅ 已实施（assistant 消息存 usage，run 聚合，Overview 展示 token/cost；设置 UI 暴露 compaction/retry）。
- **agent inspector**：不做（无后端端点）。

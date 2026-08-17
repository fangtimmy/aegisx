# 代码质量审查报告

> 全量审查于 2025-08-16 完成。所有条目均已定位到文件并核实代码；审查时工作区有一批未提交的 scheduler-inbox 改动，测试在其下全部通过 —— `bun run --filter @aegisx/server test` 231 pass / 0 fail。

## 1. 正确性

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| C-1 | **major** | `queue.enqueue` 对已存在 item 的 upsert 没有 status 守卫：注释说 "a hit — including done/cancelled/failed — resets to pending"，但代码同样作用于 **running**。后果：正在跑的 run 的 done 追踪丢失（`markDone` 的 `(id, runId, running)` guard miss），且同 challenge 会被 drainer 二次 launch → **同题双 run 并行烧 token**。HTTP `POST /api/events/:id/queue`、`enqueue_run` 工具、Python SDK 均可触发 | `apps/server/src/run/queue.ts` enqueue() |
| C-2 | **major** | `DELETE /api/events/:eventId` 的 active-run guard 用 `innerJoin challenges`，而 scheduler run `challengeId=null` 永不匹配 → 删除 event 时 scheduler run 行被 cascade 删除，但其容器（`sleep infinity` + AutoRemove）**不会被杀，永久泄漏**；`contexts`/`lifecycle`/`eventScopes`/`inboxes` 中的内存条目悬挂，正在 streaming 的 orchestrator 继续运行 | `apps/server/src/events/routes.ts`（activeRun 查询）|
| C-3 | **major** | scheduler 队列入队不校验 `challengeId` 归属：`POST /api/events/:eventId/queue?challengeId=` 只查非空；`queue.enqueue` 也不校验。跨 event 的 challenge 入队后：queue item 挂在 event A，launch 出的 run 属于 event B —— list / starved 检测 / digest 全部错位。SDK 的 `enqueue` 工具（scheduler-admin `buildSchedulerToolContext`）同样只传 challengeId，LLM 幻觉传错 id 即触发 | `apps/server/src/scheduler/routes.ts`、`queue.ts` |
| C-4 | minor | `submitFlag` 的 lookup→insert 非原子：并发提交同一 flag 时第二个撞 `UNIQUE(challengeId, flag)`，原始 SQLite 错误直接变成 HTTP 500 而非合并结果 | `apps/server/src/platforms/flags.ts` |
| C-5 | minor | `DbSessionManager.commit` 用 `seq = fileEntries.length`；`load()` 跳过 JSON 损坏行后内存计数 < DB 行数 → 后续 insert 撞 `unique(sessionId, seq)`，该 session 之后全部写入失败 | `apps/server/src/agents/db-session-manager.ts` |
| C-6 | minor | teardown 竞态：`teardownRun` 先写 closed 再 `inbox.close()`，窗口内 flush 的 digest 会 `lifecycle.send` → `onResume` → 把刚关闭的 scheduler 冷恢复（拉起容器）。窗口极小但语义错误 | `teardown.ts` / `scheduler-inbox.ts` |
| C-7 | minor | SSE 初始快照（`detail`）在 `bus.subscribe` 之前读取，两步之间提交的 run/agent 更新既不在快照也不进队列。前端有轮询兜底 | `apps/server/src/run/sse.ts` |
| C-8 | minor | `addAgent` 无 `withLock` 包裹（对比其他所有 agent 操作）：并发调用算出同一 solver index → `UNIQUE(runId, slot)` 冲突 → 500 | `apps/server/src/run/run-factory.ts` addAgent |
| C-9 | minor | `create()` 容器构建失败时只回滚 runs 行，已 `mkdirSync` 的 `data/runs/<id>/` 目录残留 | `run-factory.ts` create 的 catch |
| C-10 | minor | bash 工具在 `manager.exec` 正常 resolve 后才检查 `signal?.aborted`：完成与 abort 竞争时正常结果被误标 `terminal=cancelled` | `apps/server/src/run/bash-tool.ts` |

## 2. 类型安全

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| T-1 | minor | 三处 `as unknown as` 桥接（均有注释说明 + 运行时契约测试兜底，列出供知悉）：`DbSessionManager→SessionManager`、payload→`SessionEntry`、Node stream→Web stream | `host-session.ts:108`、`db-session-manager.ts:179`、`run/routes.ts:290` |
| T-2 | minor | server tsconfig 未开 `noUnusedLocals`/`noUnusedParameters`（web 开了）—— 已产生实际死变量 `const next = patchSettings(...)` 从未使用 | `apps/server/tsconfig.json`、`settings/routes.ts` |
| T-3 | minor | 未启用 `noUncheckedIndexedAccess`，大量 `specs[i]!` 风格非空断言维持索引访问安全 | `run-factory.ts` 等 |

## 3. 性能

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| P-1 | minor | `queries.get()`（`emitRun` 高频路径，每 turn start/settle 调用）每次对 run 的全部 `session_entries` 做 JSON1 聚合扫描；长 run（数千 entries）随会话线性劣化。有 runId 索引 + 本地 SQLite 兜底，实测尚可 | `run/queries.ts`、`run-status.ts` |
| P-2 | minor | `computeContextSample` 在每个 message 边界（start/end/turn_end）调 `getEntries()`（每次 `[...fileEntries]` 全量拷贝）+ 全量遍历累计 usage —— O(N) per message | `event-pipeline.ts`、`db-session-manager.ts` |
| P-3 | minor | N+1：`queue.toPublic` 每 item 单查 challenge 名（前端轮询路径）；`getStatusSnapshot` 每 run 单查 challenge 名 | `queue.ts`、`scheduler-admin.ts` |
| P-4 | minor | `listMessages` 无 LIMIT：`after=0` 首拉全量 renderable entries | `session-queries.ts` |

## 4. 安全（本地单用户语境，无 critical）

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| S-1 | minor | 管理 API 完全无鉴权，且 solver 容器经 `host.docker.internal` 可达（API URL 已注入 scheduler 容器）。solver agent 产生的任意代码可调用全部管理 API（删 run、改 providers）。信任边界 = agent 本身，建议至少文档化该决策 | `index.ts`、`run-factory.ts` schedulerSdkContainerOpts |
| S-2 | minor | `detach` 只挡 `running` 不挡 `idle`（与 event 删除的 `running+idle` guard 不一致）—— warm run 在平台解绑后继续持有 target 会话 | `platforms/service.ts` detach |
| S-3 | minor | 附件上传无总磁盘配额（单文件有 maxAttachmentMb） | `infrastructure/storage.ts` |

正面确认：`workspace-files.ts` 的路径逃逸防护（realpath + O_NOFOLLOW + `/dev/fd` 复核）严谨；`PlatformHttp` 的 sameOrigin 凭据门控正确；`shellQuote` 转义使用正确；容器 CapDrop ALL + no-new-privileges + tmpfs noexec 到位。

## 5. 可维护性

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| M-1 | **major** | **855 行死代码**：SDK 收敛后 `ORCHESTRATOR_TOOLS = []`，18 个 scheduler 工具永不授予（`filter over []` 恒空），但 `createSchedulerTools` 每次 scheduler prepare 仍构建 tool context（含 DB 查询）再创建零工具；`RunSchedulerToolContext` 类型 + `scheduler-admin` 大半方法只服务此死路径。注释表明有意保留，但这是仓库最大死代码块 | `run/scheduler-tools.ts`、`run-factory.ts`、`scheduler-admin.ts` |
| M-2 | minor | 死变量 `next`（settings/routes.ts）；`queries.entryAgent` 导出未被使用（service 用自己的闭包版 —— 两份重复实现） | `settings/routes.ts`、`run/queries.ts` |
| M-3 | minor | `runError` 函数两份完全相同 | `run/routes.ts`、`scheduler/routes.ts` |
| M-4 | minor | `toFlagPublic` 三份重复 | `platforms/flags.ts`、`run/queries.ts`、`events/catalog.ts` |
| M-5 | minor | 导入路径笔误 `".//events/catalog"`（双斜杠） | `app.ts:5` |
| M-6 | minor | `biome-ignore` 注释但 linter 是 oxlint（注释无效） | `web/src/features/runs/conversation.tsx` |
| M-7 | minor | solver 镜像内 `pi-coding-agent@0.80.7` vs 项目 overrides `0.83.0` 版本漂移 | `containers/solver/Dockerfile` vs `package.json` |
| M-8 | minor | oxlint 存量 warning ~40 条未清（teardown unbound-method ×8、测试 await-thenable ×30、web floating-promises ×2），不阻塞 check 但淹没信号 | 各处 |

## 6. 测试

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| TEST-1 | **major** | 测试只能在 `--max-concurrency 1` 下通过：裸 `bun test` 并行跑 96 fail（data-dir lock / 共享态竞争）。隔离性依赖串行执行，新增测试会静默依赖执行顺序 | `apps/server/package.json` |
| TEST-2 | **major** | web 端核心流式逻辑零覆盖：`conversation-store.ts`（448 行状态机）、`parse-event.ts`（201 行运行时校验）、`domain/conversation.ts`（508 行渲染归并）无任何测试 —— 前端最复杂、最易回归的部分 | `apps/web/tests/`（仅 3 个文件） |
| TEST-3 | minor | 本次发现的三个 major（C-1/C-2/C-3）均无测试覆盖 —— 修复时应一并补 | — |
| TEST-4 | minor | Python SDK 无自动化测试（仅手动 smoke.py，设计取舍） | `apps/sdk/python/` |

## 7. 依赖与配置

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| D-1 | minor | `knip.json` 存在但 knip 未安装、无脚本引用 —— 孤立配置 | 根目录 |
| D-2 | minor | root `dev` script 用 `cmd & cmd & wait` 并发，Ctrl-C 信号传递不干净 | `package.json` |

---

# 修复计划（按优先级，等确认后执行）

**P0 — 正确性（每项先补复现测试再修）**
1. C-1：`enqueue` 对 `status === "running"` 的 item 拒绝（`invalid_state`，提示先关 run）→ 验证：新增 queue.test 用例（running item 重入队被拒、双 launch 不发生）
2. C-3：`queue.enqueue` 内统一校验 `challenge.eventId === input.eventId`（同时覆盖 HTTP 与 SDK 路径）→ 验证：跨 event challengeId 返回 409/400
3. C-2：event 删除 guard 改为同时覆盖 event-scope run（`scopeType='event'` 的 running/idle → 409），并确认 cascade 前先 `teardownRun(scheduler)` → 验证：新增 events 测试（有 live scheduler 时删除被拒 / 关闭后删除无容器残留）

**P1 — 高价值**
4. M-1：**需你决策** —— scheduler-tools.ts 死代码：(a) 整文件删除 + scheduler-admin 瘦身（我的建议，HTTP 端点保留），或 (b) 保留现状但把 `buildSchedulerToolContext` 的构建从 prepareAgent 热路径摘掉
5. TEST-2：为 `parse-event.ts` 与 `conversation-store.ts` 补测试（纯逻辑、无 DOM 依赖，成本低收益高）
6. 小竞态批量修：C-4（upsert 化 flag 写入）、C-5（seq 用 DB max 而非内存长度）、C-8（addAgent 套 withLock）
7. S-2：detach 的 guard 对齐为 `running+idle`

**P2 — 清理与一致性**
8. M-2/M-3/M-4/M-5 去重与死代码清理；开 server `noUnusedLocals`
9. C-6/C-7/C-9/C-10 小修（inbox flush 前检查 closed；SSE 先 subscribe 再取快照；create 失败清目录；bash abort 判定移到 exec resolve 前）
10. M-7 Dockerfile pi 版本对齐 0.83.0；M-8 分批清 oxlint warnings
11. D-1：安装 knip 接入 check，或删除配置（**需你决策**）
12. S-1：若认可，加一个静态 token 到 scheduler SDK 与 server（最小改动）；否则在 README 记录信任边界

两个决策点请先定：**M-1 死代码删还是留**、**D-1 knip 装还是删**。其余项确认后按 P0 → P1 → P2 顺序一次性实施，统一跑 `bun run check` + `bun run test` 验证。

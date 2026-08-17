# 代码质量审查报告（2025-08-16，状态更新于 2026-08-17）

> 全量审查于 2025-08-16 完成。2026-08-17 执行了一轮大规模清理（见 git log 11c684d），
> 以下条目已标注状态。

## 1. 正确性

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| C-1 | major | ✅ 已修 | `queue.enqueue` 对 running 拒绝 | `queue.ts` |
| C-2 | major | ✅ 已修(旧修) | event 删除 guard 已补（a7b70df） | `events/routes.ts` |
| C-3 | major | ✅ 已修 | 弱化端点已删，剩余入队路径的 eventId 均从 challenge 行派生 | `scheduler/routes.ts` |
| C-4 | minor | ❌ 待修 | flag 写入非原子 | `flags.ts` |
| C-5 | minor | ✅ 已修 | `DbSessionManager` 改用 nextSeq 计数器 | `db-session-manager.ts` |
| C-6 | minor | ❌ 待修 | teardown 竞态（inbox closed 检查） | `teardown.ts` |
| C-7 | minor | ✅ 已修 | SSE 先 subscribe 再取快照 | `sse.ts` |
| C-8 | minor | ✅ 已修 | `addAgent` 裹 `withLock` | `service.ts` |
| C-9 | minor | ✅ 已修(旧修) | create 失败清目录（a7b70df） | `run-factory.ts` |
| C-10 | minor | ✅ 已修 | bash 改用 `runHijacked.aborted` 判定 | `bash-tool.ts` |

## 2. 类型安全

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| T-1 | minor | ❌ 待修 | 三处 `as unknown as` 桥接 | 各处 |
| T-2 | minor | ⚠️ 部分修 | 死变量 `next` 已删，但 tsconfig 未开 `noUnusedLocals` | `settings/routes.ts`、`tsconfig.json` |
| T-3 | minor | ❌ 待修 | 未启用 `noUncheckedIndexedAccess` | `run-factory.ts` 等 |

## 3. 性能

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| P-1 | minor | ❌ 待修 | `queries.get()` 频繁 JSON1 聚合扫描 | `queries.ts`、`run-status.ts` |
| P-2 | minor | ❌ 待修 | `computeContextSample` O(N) per message | `event-pipeline.ts`、`db-session-manager.ts` |
| P-3 | minor | ⚠️ 部分修 | `getStatusSnapshot` 的 N+1 已批量预取；`queue.toPublic` 仍 N+1 | `queue.ts` |
| P-4 | minor | ❌ 待修 | `listMessages` 无 LIMIT | `session-queries.ts` |

## 4. 安全（本地单用户语境，无 critical）

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| S-1 | minor | ❌ 待修 | 管理 API 完全无鉴权，信任边界未文档化 | `index.ts`、`run-factory.ts` |
| S-2 | minor | ❌ 待修 | `detach` guard 只挡 `running` 不挡 `idle` | `platforms/service.ts` |
| S-3 | minor | ❌ 待修 | 附件上传无总磁盘配额 | `infrastructure/storage.ts` |

正面确认：`workspace-files.ts` 的路径逃逸防护（realpath + O_NOFOLLOW + `/dev/fd` 复核）严谨；`PlatformHttp` 的 sameOrigin 凭据门控正确；`shellQuote` 转义使用正确；容器 CapDrop ALL + no-new-privileges + tmpfs noexec 到位。

## 5. 可维护性

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| M-1 | major | ✅ 已修 | `scheduler-tools.ts` 整文件删除(855行)，`scheduler-admin` 瘦身(~250行) | `run/scheduler-tools.ts`、`scheduler-admin.ts` |
| M-2 | minor | ✅ 已修 | 死变量 `next` 删；`queries.entryAgent` 导出删 | `settings/routes.ts`、`queries.ts` |
| M-3 | minor | ✅ 已修(旧修) | `runError` 已合并进 `errors.ts` | `run/errors.ts` |
| M-4 | minor | ⚠️ 部分修 | 从 3 份减到 1 份(`run/public.ts` 唯一导出，`catalog.ts` 改为 import) | `events/catalog.ts` |
| M-5 | minor | ✅ 已修 | 导入路径笔误修复 | `app.ts` |
| M-6 | minor | ✅ 已修 | 4 处 `biome-ignore` 注释已删除 | `web/src/features/runs/conversation.tsx` 等 |
| M-7 | minor | ❌ 待修 | solver 镜像 pi 版本 0.80.7 vs overrides 0.83.0 | `containers/solver/Dockerfile` |
| M-8 | minor | ❌ 待修 | oxlint 存量 warning ~140 条(server 102 + web 38) | 各处 |

## 6. 测试

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| TEST-1 | major | ❌ 待修 | 测试依赖 `--max-concurrency 1`，裸跑失败 | `apps/server/package.json` |
| TEST-2 | major | ✅ 已修(旧修) | web 流式三件套测试已补（a7b70df） | `apps/web/tests/` |
| TEST-3 | minor | ❌ 待修 | C-1/C-4/C-6/C-8 仍有待补复现测试（C-1/C-8 代码已修） | — |
| TEST-4 | minor | ❌ 待修 | Python SDK 无自动化测试 | `apps/sdk/python/` |

## 7. 依赖与配置

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| D-1 | minor | ✅ 已修 | knip 已安装 (`knip@6.32.2`)，已接入 `check` 脚本 | `package.json` |
| D-2 | minor | ❌ 待修 | root `dev` 脚本 Ctrl-C 信号传递不干净 | `package.json` |

---

# 当前状态

2026-08-17 一轮清理后：**18/34 项已修**，剩余 16 项（多为 minor，包括 C-4/C-6、P-1~4、S-1~3、M-7/M-8、TEST-1/3/4、D-2）。
测试 291 pass / 0 fail，`knip`、`oxlint`、`oxfmt` 均通过（warning 不阻塞）。

## 2. 类型安全

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| T-1 | minor | ❌ 待修 | 三处 `as unknown as` 桥接 | 各处 |
| T-2 | minor | ⚠️ 部分修 | 死变量 `next` 已删，但 tsconfig 未开 `noUnusedLocals` | `settings/routes.ts`、`tsconfig.json` |
| T-3 | minor | ❌ 待修 | 未启用 `noUncheckedIndexedAccess` | `run-factory.ts` 等 |

## 3. 性能

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| P-1 | minor | ❌ 待修 | `queries.get()` 频繁 JSON1 聚合扫描 | `queries.ts`、`run-status.ts` |
| P-2 | minor | ❌ 待修 | `computeContextSample` O(N) per message | `event-pipeline.ts`、`db-session-manager.ts` |
| P-3 | minor | ⚠️ 部分修 | `getStatusSnapshot` 的 N+1 已批量预取；`queue.toPublic` 仍 N+1 | `queue.ts` |
| P-4 | minor | ❌ 待修 | `listMessages` 无 LIMIT | `session-queries.ts` |

## 4. 安全（本地单用户语境，无 critical）

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| S-1 | minor | ❌ 待修 | 管理 API 完全无鉴权，信任边界未文档化 | `index.ts`、`run-factory.ts` |
| S-2 | minor | ❌ 待修 | `detach` guard 只挡 `running` 不挡 `idle` | `platforms/service.ts` |
| S-3 | minor | ❌ 待修 | 附件上传无总磁盘配额 | `infrastructure/storage.ts` |

正面确认：`workspace-files.ts` 的路径逃逸防护（realpath + O_NOFOLLOW + `/dev/fd` 复核）严谨；`PlatformHttp` 的 sameOrigin 凭据门控正确；`shellQuote` 转义使用正确；容器 CapDrop ALL + no-new-privileges + tmpfs noexec 到位。

## 5. 可维护性

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| M-1 | major | ✅ 已修 | `scheduler-tools.ts` 整文件删除(855行)，`scheduler-admin` 瘦身(~250行) | `run/scheduler-tools.ts`、`scheduler-admin.ts` |
| M-2 | minor | ✅ 已修 | 死变量 `next` 删；`queries.entryAgent` 导出删 | `settings/routes.ts`、`queries.ts` |
| M-3 | minor | ✅ 已修(旧修) | `runError` 已合并进 `errors.ts` | `run/errors.ts` |
| M-4 | minor | ⚠️ 部分修 | 从 3 份减到 1 份(`run/public.ts` 唯一导出，`catalog.ts` 改为 import) | `events/catalog.ts` |
| M-5 | minor | ✅ 已修 | 导入路径笔误修复 | `app.ts` |
| M-6 | minor | ✅ 已修 | 4 处 `biome-ignore` 注释已删除 | `web/src/features/runs/conversation.tsx` 等 |
| M-7 | minor | ❌ 待修 | solver 镜像 pi 版本 0.80.7 vs overrides 0.83.0 | `containers/solver/Dockerfile` |
| M-8 | minor | ❌ 待修 | oxlint 存量 warning ~140 条(server 102 + web 38) | 各处 |

## 6. 测试

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| TEST-1 | major | ❌ 待修 | 测试依赖 `--max-concurrency 1`，裸跑失败 | `apps/server/package.json` |
| TEST-2 | major | ✅ 已修(旧修) | web 流式三件套测试已补（a7b70df） | `apps/web/tests/` |
| TEST-3 | minor | ❌ 待修 | C-1/C-4/C-6/C-8 仍有待补复现测试（C-1/C-8 代码已修） | — |
| TEST-4 | minor | ❌ 待修 | Python SDK 无自动化测试 | `apps/sdk/python/` |

## 7. 依赖与配置

| # | 级别 | 状态 | 问题 | 位置 |
|---|------|------|------|------|
| D-1 | minor | ✅ 已修 | knip 已安装 (`knip@6.32.2`)，已接入 `check` 脚本 | `package.json` |
| D-2 | minor | ❌ 待修 | root `dev` 脚本 Ctrl-C 信号传递不干净 | `package.json` |

---

# 当前状态

2026-08-17 一轮清理后：**18/34 项已修**，剩余 16 项（多为 minor，包括 C-4/C-6、P-1~4、S-1~3、M-7/M-8、TEST-1/3/4、D-2）。
测试 291 pass / 0 fail，`knip`、`oxlint`、`oxfmt` 均通过（warning 不阻塞）。

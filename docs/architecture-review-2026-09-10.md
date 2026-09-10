# AegisX 架构评审与重设计提案（2026-09-10）

> **状态：提案 1–7 已全部实施（2026-09-10，七个提交），提案 8 经决定不做。** 本文保留评估原文（痛点清单与量化附录是重构前的证据快照，其中的行号/路径指向旧树）；每项提案的落地提交见下表。与 [audit-2026-09-09.md](audit-2026-09-09.md) 的关系：那轮审计修的是**实例**（settleAgent 收敛、wire 映射下沉等），本轮改的是**生成这些实例的结构**——其主题 3（资源生命周期无人收敛）与主题 5（同一机制的副本并存）的根因由本轮处理。

评审方式：通读 [architecture.md](architecture.md)、两轮审计文档与运行时核心（`run/service.ts`、`run/agent-factory.ts`、`agents/lifecycle.ts`、`run/channels-delivery.ts`、`run/drainer.ts`），辅以全仓证据扫描（体量 / 依赖方向 / 定时器族 / 技术债标记 / 测试形态 / schema 演进）。引用的行号以 2026-09-10 的 main 为准。

## 总判断

形态选型是对的，不应推翻：单进程 + 同步 SQLite + 频道单一账本 + 「调度者是一个 agent」，对本地单机约束都是恰当的简单方案。真正的痛点集中在三个结构性主题：

1. **所有权分散** —— 存活 agent 的资源散落在多个按 agentId 索引的边表里，终态善后靠约定收敛而非结构保证；
2. **时间不可控** —— 定时器与轮询无处不在且不可注入，测试被迫串行 + 真等；
3. **双实现温床** —— 同一机制的多份副本反复长出（jsonl 双后端、SSE 客户端 ×2、未读 ×2、flag→wire ×2，后两者已修）。

如果重新设计：**保持形态、更换承重结构**——柱子没立错，柱子之间的连接靠 mortar（约定）太多、靠 joint（结构）太少。

## 痛点清单（按代价排序）

### 1. `run/service.ts` 是 god object，`run/` 与 `agents/` 的边界名存实亡

- 1,383 行、单个闭包内 43 个函数、被 6 个模块引用；churn 全仓第一（近 100 天 88 次改动，见 audit-2026-09-09 附录 B）。flag 联动、scheduler 生命周期、workspace 删除、编排策略目前全住在里面。
- 跨目录依赖：`run → agents` 13 处（`run/service.ts:23-34`、`run/agent-factory.ts:10-16` 等），反向 `agents → run` 5 处（`agents/lifecycle.ts:1`、`agents/host.ts:9-12`、`agents/model-switch.ts:8`）。无文件级环，但目录边界只剩命名意义。
- `run/service.ts:302-304` 的 `let factory! / schedulerAdmin! / queue` 后绑定互指：组装图本质是环，靠手工声明顺序解开。

### 2. 每个 agent 的资源生命周期是「散落账本 + 约定收敛」

一个存活 agent 的资源分布在至少七处：`lifecycle` 的 session Map、`deadlines.timeoutTimers`、`pendingFinish` / `finishFlagWarned`、LiveBus 的 5 个 Map（`agents/live.ts:22-30`）、`factory.contexts`（`run/agent-factory.ts:300-304`）、容器引用计数（`run/container-lifecycle.ts`）、queue item 回填。

`settleAgent`（`run/service.ts:312`）已把五份终态拷贝收敛成一份（audit P1-1），但类的根源还在：**新增一条终态路径仍必须记得挨个清**——正确性靠纪律，不靠结构。全局版本是 `close()` 手工按固定顺序串联 8 个子系统清理（`run/service.ts:1270-1287`）。

### 3. 时间无处不在、不可注入

运行时至少 8 族独立定时器：投递 flush tick（`run/channels-delivery.ts:237`）、容器 idle sweep（`run/container-lifecycle.ts:186`）、drainer 双 setTimeout 链（`run/drainer.ts:116,137`）、per-agent deadlines（`run/deadlines.ts:60,72`）、stall watchdog（`run/stall-watchdog.ts:69`）、exec 超时 + `pollExitCode` 10×30ms 轮询（`run/container/container-manager.ts:166,306`）、local-manager、providers fetch 超时。

测试侧全无 fake timers；`bun test --max-concurrency 1`（`apps/server/package.json:7`）是明令约束——本质是全局单例（真实 DB、service 闭包、真实定时器）导致测试只能串行，时间相关逻辑只能真等（`container-manager.test.ts` 里的 `Bun.sleep(1)`）。

### 4. 双后端 / 双实现持续交税

- jsonl 会话双路径在全仓留了 20+ 处分支（`agents/host-session.ts:37,59,218`、`run/agent-session-ops.ts:178,197`、`agents/db-session-manager.ts:78`、`db/index.ts:257-263`、`infrastructure/config-store.ts:118-131`、web 侧三处），且 legacy 路径功能不齐（无 backtracking、无 startedAt）——与根 AGENTS.md「不留兼容层」的原则矛盾。
- 历史同型问题：SSE 客户端两套手写（仍未收敛）、频道未读两套（已修）、flag→wire 映射两份（已修）。经验规律：同一机制的副本总会再长出来，除非结构上只允许一份。

### 5. 与调度者 agent 的协议是隐式的

系统侧要跟一个自然语言规划者对话，为此背了 digest 渲染、urgent 冷唤醒、paused 门、resume 唤醒语、flush tick 批处理——channels 五模块 + scheduler-policy + scheduler-admin 的大部分复杂度在服务这个接口。调度行为的可观测性等于读 LLM 的 DM 对话，出问题时定位链路长。

### 6. 授权 / 作用域靠每处手写条件

P0-1（multipart 越权）、P0-2（跨赛事 available 翻转）、P0-8（跨赛事删队列项）的共同根：每层各自拼 scope 条件，没有一处是结构上不可绕过的。修一个少一个，但温床还在。

### 7. 前端手写 reactive store，单流约束外溢成产品限制

`web/src/stream/conversation-store.ts` 507 行、15 个 Map/Set（:87-107）、手工 epoch 防串话 + rAF 批量 + 断线重连；「同时只能订阅一个 agent」这一实现代价变成了用户可感知的功能上限。

### 8. schema 演进税

`SCHEMA_VERSION = 20`（`db/schema.ts:15`）、19 个迁移（drizzle 0000–0018）、每个重大迁移固定配 250–390 行 compat 测试（仅 0011–0013 有专属测试即已 870 行）；`db/schema.ts` 是 churn 榜第三。对本地单机工具，这个流程的重量会反过来抑制 schema 改进。

## 重设计提案

仍然单进程、仍然 SQLite、仍然调度者即 agent。改的是承重结构：

| # | 提案 | 针对痛点 | 状态（提交） | 备注 |
|---|---|---|---|---|
| 1 | **`AgentRuntime` 作为所有权根**：一个存活 agent 的全部运行时资源收进一个对象，spawn 一处创建、`dispose()` 一处释放；service 退化为 `Map<agentId, AgentRuntime>` + 策略 | 1、2 | ✅ `10bf5b9` | 落地形态：`run/agent-runtime.ts`（settle 唯一终态路径），`deadlines.ts` / `stall-watchdog.ts` / `host/lifecycle.ts` 并入后删除，`chainLock` 移入 `run/locks.ts`；`service.ts` 1,389 → 1,365 行 |
| 2 | **统一时间层**：所有定时器进一个可注入的 clock + 定时器注册表；事件驱动唤醒优先于周期 tick | 3 | ✅ `7c19c7e` | `run/clock.ts`（Clock + TimerHub + FakeClock）；run/ 下裸 `setTimeout/setInterval` 归零，stall-watchdog 与 container-manager 超时测试改为确定性推进 |
| 3 | **合并 `run/` 与 `agents/` 为一个运行时层**，依赖方向用 lint 规则强制 | 1 | ✅ `1f4b7b9` | `agents/` → `run/host/`（含公共出口 `index.ts`）；两条 oxlint `no-restricted-imports` 规则守方向（host 不反向依赖编排层；路由层只经出口进 host） |
| 4 | **principal 贯穿 service API**：授权在中间件解析一次，service 方法签名收 principal | 6 | ✅ `dce7188` | `Principal`（user/agent/system）+ `run/principal-scope.ts` 断言；路由层不再拼 scope 条件；新增 4 条绕过路由直调 service 的越权拒绝测试；`test:sdk` 契约保持通过 |
| 5 | **调度接口显式化**：系统→调度者的通知改为类型化事件 + 渲染模板 | 5 | ✅ `0758557` | `run/orch-notices.ts`（9 类事件 + 投递契约纯函数）；文本默认值入 `prompt_templates`（可编辑）；`launchFailed` 的措辞由 drainer 移交模板 |
| 6 | **服务端多路复用 SSE**：全局 `/api/stream` + web 进程级单 EventSource | 4、7 | ✅ `0758557` | 旧的 per-agent / per-channel 端点删除；`web/stream/live-connection.ts` 为唯一连接，`conversation-store` 退化为按 agentId 键控状态 + selector，单流约束消失；两套手写 SSE 客户端收敛；死变体 `ready` 移除 |
| 7 | **砍掉 jsonl 双后端**；迁移纪律减负 | 4、8 | ✅ `c5e1299` + `b907ad5` | **执行强于提案**：决策为「不再兼容旧 schema」，19 个迁移压缩为单一基线（同时修复断裂的 drizzle 快照链），开机三态（fresh / current / stale 硬失败），v1–v19 旧库无升级路径；jsonl 会话双后端路径全部删除 |
| 8 | **（可选）容器内 exec sidecar** | 3 及容器层 | ⛔ 不做（决定） | 保持 dockerode hijacked exec 现状 |

**实施顺序**：B1 迁移与 legacy（7）→ B2 目录合并（3）→ B3 时间层（2）→ B4 AgentRuntime（1）→ B5 principal（4）→ B6 并行（5 ∥ 6）。每批次完成后 `bun run check` + `bun run test`（+ 涉及 agent API 时 `bun run test:sdk`）全绿再提交；B6 的两个方向在同一批并行落地。

## 明确不动清单

以下选型经评审确认正确，重设计亦不触碰（与 audit-2026-09-09 的「明确不动清单」互补，该清单中面向具体文件的条目继续有效）：

- **单进程进程模型** —— 冷恢复 + 按需重开已把崩溃代价压到可接受（存活 agent 转 idle，不自动续跑）；
- **同步 SQLite + chainLock 并发模型** —— 简单且与单进程自洽（`run/locks.ts`）；
- **channels 单一账本 + 派生键**（无频道表）；
- **调度者即 agent** —— 产品灵魂；问题只在接口隐式（见提案 5），不在理念；
- **agent loop 在宿主进程内**（pi）+ 每题一个长寿工具箱容器；
- **monorepo 形态**与 `apps/shared` 作为 wire 类型 canonical 来源。

## 量化附录（证据快照，2026-09-10 —— 重构前）

| 指标 | 值 |
|---|---|
| `run/` 非测试行数 | 10,573（`service.ts` 1,383 / `agent-factory.ts` 975 / `routes.ts` 768 / `queue.ts` 534） |
| `agents/` 非测试行数 | 2,198（`event-pipeline.ts` 530 / `db-session-manager.ts` 522 / `host-session.ts` 254） |
| 定时器族 | ≥ 8（正文所列） |
| 非测试源码 `new Map/Set` | 63 处 |
| 测试 | 74 文件 / 18,639 行；最大 `test/run/channels.test.ts` 1,558 行；无 fake timers |
| 迁移 | 19 个 SQL，`SCHEMA_VERSION = 20`；`src/db/` 下 7 个测试文件 1,447 行 |
| 前端最大 store | `conversation-store.ts` 507 行 / 15 个 Map/Set / 37 个方法 |

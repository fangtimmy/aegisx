# Handoff：修复 TSecBench 分析发现的问题

本轮不改代码。这是一个交接提示词，供下一个会话直接执行。背景、证据、修复方案与验收
标准都已固化在 [tsecbench-analysis-2026-09-08.md](tsecbench-analysis-2026-09-08.md)，
本文件只做执行索引。

## 0. 前置约束（来自 AGENTS.md，必须遵守）

- 先规划再实施；**规划需要用户确认**，在用户明确给出实施信号后才开始写代码。
- 一轮对话中完成所有修改后再统一检查（typecheck / lint / test），不要写一个文件检查一次。
- 不要维护向后兼容性；直接移除废弃路径，不加兼容层。
- 采用尽可能简单的实现方案；抵抗过早抽象、臆想式错误处理、不必要的可配置、没有生命力
  的灵活性。
- 不要在代码中引用文档。注释只在代码本身无法表达约束时才写。
- **禁止修改 `apps/web/src/components/ui/**`**。
- 敏感信息无需脱敏。
- 完成后明确说明未完成内容。

## 1. 环境与现状

- 仓库：`/Users/timmy/Projects/aegisx`，分支 `main`。
- **`main` 领先 `origin/main` 6 个提交**（含本轮两个修复 `9a6efb5`、`c59713b`），
  尚未 push，用户未授权 push。
- **用户本地未提交改动：`AGENTS.md`（删除了一行"不要使用子代理"）——不得提交、不得
  改动。** 另有 `docs/README.md` 已修改、`docs/tsecbench-analysis-2026-09-08.md` 新增
  （均为本轮文档，可随修复一起提交）。
- 检查命令：`bun run check`（oxfmt + knip + 各包 check）、`bun run test`。当前基线：
  **359 个测试全部通过**。
- 基准测试数据（只读，用于验证修复）：`/Users/timmy/aegisx-runs/tsec-full-2026-09-08/aegisx.sqlite`。

## 2. 修复清单

按建议实施顺序。每项都给出精确落点、改动要点、验收方式。

### 修复 1：系统通知不投递给触发者（R-9 / H-6）

**这是用户明确指定采用"方案 A"的一项，优先做。**

问题：投递过滤只排除 agent 作者，系统消息（flag 通知）被推给提交者本人，触发冗余收尾
回合（实测 1.84M token）。

落点：

- `apps/server/src/run/channels-context.ts:112` — `serverMeta` 当前只在
  `author.type === "agent"` 时写 `meta.agentId`。放开为系统作者也可写入（提交者）。
- `apps/server/src/run/channels-delivery.ts:82-85` — 过滤条件扩展，同时排除
  `authorType === "system" && parseMeta(row.meta).agentId === agentId`。
- `apps/server/src/run/service.ts:886-906`（`postExtraFlagNotice`）、`:926-950`
  （`postFullSolveTeamNotice`）、`:956-993`（`notifyFlagPartial`）— 把提交者写进
  `meta`。`notifyFlagPartial` 已有参数但名为 `_submitterAgentId`（`:959`），去掉 `_`
  并透传。
- `apps/server/src/app.ts:63,67` — 确认 `agentId` 已传入（已传）。

语义确认：当提交者是该题唯一存活 agent 时，通知没有接收者——这是期望行为。

验收：新增回归测试（`apps/server/test/run/channels.test.ts`）：一个 agent 提交 flag 触发
系统通知后，该 agent 的投递不包含这条通知，而同题另一个存活 agent 的投递包含它。
期望在旧代码上失败、新代码上通过。

### 修复 2：完全解出即停 + 收尾硬超时（R-2 / P-5）

- 判据用 `notifyFlagAccepted` 的 `outcome === "first"`（对应平台 `is_completed`），
  **多 flag 题的中间 flag 不能停**。
- 评测场景：完全解出后立即终止提交者（不写 WP）。正常场景：保留收尾但加硬超时。
- 落点：`apps/server/src/run/service.ts` 的 `notifyFlagAccepted`（:852）与
  `stopOthersOnSolved`（:1015，当前显式排除提交者以让它写 WP）。
- 配置项加在 `scheduler_config`（`apps/server/src/db/schema.ts:403`）+ 策略读取
  （`apps/server/src/run/scheduler-policy.ts`）。注意 AGENTS.md 的"不必要的可配置"红线
  ——只在确有评测/正常两种场景差异时才加开关。

验收：测试覆盖"单 flag 完全解出 → 提交者被终止"与"多 flag 中间 flag → 提交者不被终止"。

### 修复 3：给编排者靶机控制权（R-3 / I-1）

a-17 饿死 3.4 小时的直接原因。两个方案，**推荐 B（更简洁）**：

- A：SDK 暴露靶机 stop 接口给编排者。
- B：`agents.close()` 在最后一个同题 agent 离开时联动停止平台实例——`onAgentTerminal`
  （`apps/server/src/run/service.ts:250-269`）已有类似逻辑，可复用。

验收：测试覆盖"关闭同题最后一个 agent → 触发 target stop"。

### 修复 4：调度多样性 + 性价比打分（R-1 / P-1）

当前 `nextTaskPolicy` 只有 eager/drained 两个二元开关，无多样性考量。目标：槽位组合
"2 难题 + 1 流水线槽"，且难题不得为同一题；靶机满时把空置的 LLM 并发用于已占靶机上的
分工。

**这一项改动面最大、设计空间最开，建议单独与用户确认方案后再动。**

### 修复 5：工作区回收 + 尝试计数去伪（R-5 / H-1 / H-2）

- agent 终结路径回收 `agents/<id8>`（当前全生命周期无删除）。
- "尝试次数"改统计真实调度（`spawn_queue` distinct 项），不再用原始 agent 行
  （`apps/server/src/events/catalog.ts:167-170`、`apps/server/src/run/queries.ts:90-119`）。

### 修复 6：提示词与长命令（R-4 / R-6 / R-7 + §6.2）

- 编排者：卡住时优先新开不同角度的 agent，而非反复 steer 同一个（实测被 steer 的 5 个
  agent 全部 aborted，仅 1 个产出 flag）。
- 提示词强制"预计 >2min 的命令 `nohup … &` + 轮询"（当前 560 分钟前台阻塞）。
- flag 格式 `flag{<uuid>}` 注入；多 flag 进度实时注入；删 `extend_target` 引导；说明
  409 语义与 category=难度；破题止损规范。
- 落点：`apps/server/src/orchestration/prompt-defaults.ts`。

### 修复 7：其余 Harness / Infra 项

- H-3 / H-4：频道投递预算丢最旧消息（`channels-render.ts` 的 `MAX_DELIVER_CHARS`）。
- H-5：`queue.ts:255` 的裸 `sql` 片段（同类优先级隐患）。
- I-2：靶机 stop 是 fire-and-forget，与下一次 spawn 竞态。
- I-3：解出释放靶机不唤醒排水器（`stopOthersOnSolved` 不调 `scheduleDrain()`）。
- I-4：`get_target` 每次全量拉取 63 题列表。
- I-5：多 flag 进度是同步时刻的冻结快照（无周期同步）。

## 3. 不要做的事

- **不要**把 `maxConcurrentAgents` 降到 3——它与靶机 3 槽是正交的，降了会砍掉同题分工
  所需的 LLM 并发（详见文档 §3）。
- **不要**把"编排者主动关闭 agent"当成 bug 去修——本轮分析一度误判，实际是它的调度决策；
  真正的病根是它没有靶机控制权（修复 3）。
- **不要**对 f2-05 下结论它是坏题——agent 侧证据强但需平台确认（文档 §8）。

## 4. 交付要求

- 每项修复配回归测试；测试需先验证在旧代码上失败。
- 全部改完后统一跑 `bun run check` 与 `bun run test`，报告实际结果（不要只说"应该没问题"）。
- 明确列出未完成的项与原因。
- **不要提交、不要 push**，除非用户明确授权。`AGENTS.md` 始终不动。

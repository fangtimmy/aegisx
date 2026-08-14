# Session 存储优化（v10 · 增量方案）

状态：**已实施（v10）**
Schema：**v10**（仅 `session_entries` 加一列 `meta`，additive 迁移）
取代：[session-format-redesign.md](./session-format-redesign.md)（v10 整表重构设计稿，**废弃**）

> 结论先行：**放弃整表重构，采用最小增量改动**。经两轮事实核查（rev3）确认，
> 三个痛点中两个用增量即可解决，v10 的互转层/迁移/invariant 测试成本没有对应的
> 硬收益。本方案只做四件事：加一列、写一个计时状态机、暴露一个已有字段、删几行
> 死代码。**字段完整性与未来 pi 兼容由"data 列原样存储"免费保证**——不重构
> 恰恰是这两个问题的最优解。

---

## 一、要解决的实际问题（全部经代码/数据核实）

### 痛点

| # | 问题 | 核实状态 |
|---|---|---|
| P1 | session 维护麻烦：DbSessionManager 4 个内存 map、树形语义、data 列 pi 黑盒 | labels 相关方法被 pi SDK 编译代码直接调用（`agent-session.js` 3 处），**方法不能删**；map 当前零写入 |
| P2 | timeline 看不到系统提示词/模型配置 | `agents.system_prompt`/`model`/`tools` 已快照在行上（createAgent 写一次、运行时不变、冷恢复复用），**数据已在库中，只差暴露与渲染** |
| P3 | 看不到耗时：前端 `durationMs` 死代码（`conversation.ts` L142 定义、`timeline.tsx` L358 渲染、从未赋值）；工具耗时是运行时 `Date.now()` 计时，刷新丢失 | 属实 |

### 隐患（实施时会导致丢数据，已被本方案根除）

| # | 隐患 | 本方案如何处理 |
|---|---|---|
| H1 | usage 若被简化只存 `{input, output}` 会抹掉 cache/reasoning/cost 七维度统计 | **data 列原样存储 pi message，不重写转换逻辑 → 天然完整** |
| H2 | toolResult.details 若丢，bash 非零退出的失败分类（timed_out/cancelled/failed）全退回"普通失败" | 同上，原样存储天然保留 |
| H3 | stopReason 枚举是 `toolUse` 不是 `tool_use`（现网 124 toolUse / 1 stop），写错前端 switch 全 miss | 同上；前端 `conversation.ts` L314 依赖 `stopReason === "error"` 渲染错误块，原样存储不受影响 |
| H4 | compaction 的 `firstKeptEntryId` 是 pi legacy，未来迁移 retainedTail | **data 是宽松 JSON，pi 升级后新字段（retainedTail/n）自动透传，无需迁移、无需 schema 预留** |

**核心洞察**：H1–H4 全部是"重写格式时才可能犯的错"。既然不重写格式，这些隐患
自动消失。这正是增量方案相对整表重构的最大优势。

---

## 二、方案设计（四件事）

### 2.1 `session_entries` 加一列 `meta TEXT`（解决 P3 的存储侧）

```
session_entries (
  ... 现有列不变 ...
  meta TEXT   -- timing 元数据 JSON；仅 message 行有值，其余为 null
)
```

载荷：

```json
// assistant message 行
{ "durationMs": 45312, "blocks": [
  { "type": "thinking", "index": 0, "startMs": 0,     "endMs": 38000 },
  { "type": "text",     "index": 1, "startMs": 38000, "endMs": 45000 },
  { "type": "toolCall", "index": 2, "startMs": 45000, "endMs": 45312 }
] }

// toolResult 行（无 blocks）
{ "durationMs": 8432 }
```

- 列是 nullable、无默认值 → drizzle `ADD COLUMN`，additive backfill，**零迁移风险**
  （migrations.md：`CREATE TABLE`/`ADD COLUMN` 属安全项）。
- 升 `SCHEMA_VERSION` 至 10。
- 旧行 meta = null，前端容错（无耗时则不显示徽标）。

**`blocks` 约束（写死）**：仅覆盖 `thinking`/`text`/`toolCall` 三类块，`index` = 该块在
content 数组中的下标；其他类型块不计时、不出现。

**meta 版本**：meta 是无版本的 TEXT JSON。当前无旧行有 meta，可忽略版本；若未来 blocks
schema 演进，在 meta 里带 `v` 字段（记一笔，本期不做）。

### 2.2 pipeline 计时状态机（解决 P3 的数据侧——唯一躲不掉的工程）

位置：`apps/server/src/agents/event-pipeline.ts`。**两条路径**（assistant 与 toolResult
计时来源不同）：

```
── assistant 路径 ──
message_start          → 记 t0；重置 blocks 累积器
message_update         → text_delta/thinking_delta/toolcall_delta：
                          块无 startMs 则记 start（相对 t0 偏移），持续更新 endMs
toolcall_start/end     → toolCall 块的 start/end（= 参数生成耗时）
message_end            → durationMs = message_end − t0；组装 blocks

── toolResult 路径（不经 message_start——pipeline 现跳过其 draft）──
tool_execution_start   → 记 toolCallId → execStart
tool_execution_end     → durationMs = execEnd − execStart；写入对应 toolResult 行
```

**meta 注入路径（pre-commit，不是 onAppend）**：`onAppend` 是 `commit` 在
`db.insert(...).run()` **之后**触发的 post-insert 通知（db-session-manager.ts：先 insert
再 `onAppend?.(entry, seq)`），meta 要写进数据库行，必须在 `db.insert` 的 `values()`
**之前**拿到。正确机制是反方向的注入：

```
DbSessionManager 持有 metaProvider?: (entry: SessionEntry) => TimingMeta | null
  （由 pipeline 注入；内部按 entryKeyOf(agentId, entry) 从计时状态回捞）

commit(entry):
  meta = this.metaProvider?.(entry) ?? null        ← db.insert 之前
  db.insert({ ..., meta })                          ← meta 进行
  this.onAppend?.(entry, seq)                       ← 不变：post-insert 通知，仅供 SSE
```

`onAppend` 保持 `(entry, seq)` 签名不变。meta 若挂在 onAppend 上：insert 后才取到则进不了行；
只传 SSE 则刷新即丢，直接违背 §六"刷新后仍显示"。

**计时状态生命周期**：随 `message_start` 重置、随 agent session 销毁回收。**没有**
"SSE 断线清理"——计时状态住在服务端 pipeline（生命周期 = agent session），SSE 是
server→browser 传输层，客户端重连不经过它。

**单测覆盖**：
- `message_start → deltas → message_end` 序列，断言 durationMs/blocks 正确。
- 工具并行：多个 `tool_execution_start/end` 交错，断言各 callId 不串线、写入各自行。
- toolResult 行不因被跳过的 `message_start` 产生错误 durationMs。

### 2.3 系统提示词可见性（解决 P2——数据已在库中，只差暴露）

`agents` 行已快照（createAgent 写一次、运行时不变、冷恢复复用——已核实）：
- `system_prompt`：完整系统提示词
- `model`：规范串 `<providerKey>/<modelId>:<effort>`
- `tools`：JSON 数组

**改动**：
1. API 层：`AgentSummary`（`apps/shared/agent.ts`）加 `systemPrompt: string`、`tools: string[]`
   字段（读 agents 行，一行代码；`model` 字段已有）。
2. 前端：timeline 头部渲染可展开的"系统配置"卡片——systemPrompt（markdown 预览）+
   模型（解析规范串）+ 工具列表。

**不新增 header 事件**（v10 设计稿的 seq 0 方案废弃）：该列运行时不变，显示它 =
显示初始快照，语义自洽；timeline 与 agents 数据源解耦没有额外收益。

### 2.4 死代码清理（解决 P1 的一部分——比 review 声称的少，诚实标注）

**修正 review 的"labels map 直接删"**：pi SDK 编译代码（`agent-session.js`）**内部
3 处直接调用** `sessionManager.appendLabelChange`（setLabel RPC 路径 + moveTo 分支
路径）。虽然 AegisX 运行时这些路径不触发（无 setLabel RPC、无 branch/moveTo），
但 **方法签名必须保留**，删了 pi SDK 走到 label 路径即 TypeError。

实际可清理的：
- `labelsById`/`labelTimestampsById` 两个 map：当前零写入（上述路径不触发），
  保留为惰性（无害），或删除并把 `appendLabelChange`/`getLabel` 改为空实现
  ——**推荐后者**（map 是纯内存，删掉后方法空转，行为等价且少两处状态）。
- 其余方法（appendCompaction 等）全部是 pi 实际调用的，不动。

**诚实的结论**：P1 的"维护麻烦"通过本次改动只能改善**心智层面**（本文件 + §2.2
的 meta 通道让 timing 逻辑有明确归属），代码量的削减比 v10 设计稿声称的少得多——
因为 pi 编译代码的接口依赖决定了方法集不能缩减。这是增量方案的固有边界。

---

## 三、可选增强（不做也能解决全部痛点）

**API 层投影**：现状前端 `buildConversation` 已集中 parse pi entry（一处）。
若想让前端彻底不接触 pi message 结构，可在 API 层把 entry 投影为自有结构
（`{role, content, usage, meta}`），前端消费投影结果。成本：API 写投影 +
前端改消费；收益：心智模型，无功能差异。**建议实施顺序排在核心四件事之后**，
按需决定。

---

## 四、不做的事（明确排除及理由）

| 排除项 | 理由 |
|---|---|
| 整表重构（session-format-redesign.md v10） | 互转层 + 迁移 + invariant 测试成本无对应硬收益；H1–H4 靠"原样存储"免费解决 |
| 删 agentId/runId 冗余列 | run 级查询现为单表（`session_entries_run_seq_idx`），删了要改多处 join，无收益 |
| 删 parentId | pi 树需要；一列成本，删了要写重建逻辑（负收益） |
| header 事件（seq 0） | `agents` 行已有完整快照且运行时不变，暴露它即可 |
| 迁移旧数据 | 无 schema 结构变更（仅加 nullable 列），旧行直接兼容 |

---

## 五、实施步骤

1. `apps/server/src/db/schema.ts`：`session_entries` 加 `meta` 列 + `SCHEMA_VERSION` → 10
   → 验证：`bun run db:generate` 产出 additive `0004_*`，migrate 后旧库可开
2. `apps/server/src/agents/event-pipeline.ts`：计时状态机（§2.2 两条路径）
   → 验证：单测断言 durationMs/blocks/并行 callId 不串线
3. `apps/server/src/agents/db-session-manager.ts`：注入 pre-commit `metaProvider`；`commit`
   在 `db.insert` 前调用它、结果写 `meta` 列；删 labels 两 map（方法留空实现）
   → 验证：db-session-manager.test 仍绿（与 SessionManager.inMemory 输出一致）；
   单测断言 metaProvider 在 insert 前被调用、返回值进 `meta` 列
4. `apps/server/src/agents/session-queries.ts` + shared `EntryItem`：meta 透传到 API
5. `apps/server/src/agents/host-session.ts`：接线——pipeline 提供 `metaProvider`（按
   `entryKeyOf` 回捞计时状态）注入 DbSessionManager；`onAppend` 保持 post-insert 不变
6. API：`AgentSummary` 加 `systemPrompt`/`tools`
7. 前端 `conversation.ts`：AgentBlock/ToolBlock 读 meta 填 `durationMs`/`blocks`
   （死代码复活）；`timeline.tsx` 渲染"参数生成 · 执行"双耗时
8. 前端：timeline 头部系统配置卡片（systemPrompt + model + tools）
9. 端到端验证：真实 run 中观察耗时显示、刷新后不丢、系统卡片正确

---

## 六、验证标准

- 耗时：新写的 assistant 行有 durationMs + blocks（块级）；toolResult 行有
  durationMs（工具执行，非"结果时间减参数生成时间"）；刷新后仍显示。
- 系统提示词：timeline 头部卡片展示 systemPrompt/model/tools，与 agents 行一致。
- 字段完整性：抽查新写行的 usage 含七维度、toolResult 含 details、stopReason 为
  `toolUse`（现网值），零丢失。
- 兼容：旧会话（meta=null）打开不报错、无耗时徽标；migrate 前后行为一致。

---

## 七、与前版设计稿的关系

`session-format-redesign.md`（v10 整表重构，rev3）保留为历史参考，**不实施**。
本方案继承其已被两轮 review 验证的正确结论：耗时分层设计（参数生成 vs 工具执行）、
timing 状态机两条路径、字段完整性规矩、`toolUse` 枚举值修正、pi compaction
retainedTail 方向认知——这些不依赖整表重构，全部在增量方案中原样落地。

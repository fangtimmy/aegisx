# Session 格式与存储重构（v10 设计稿 · rev3）

状态：**设计稿，未实施**（rev3：第二轮事实核查修订——message 载荷改为"完整 AgentMessage 原样 +
timing"、不枚举字段；compaction usage 示例对齐完整 Usage 规矩；迁移回填规则（header 合成/
effort 解析/timing 缺省）；timing 状态机分 assistant/toolResult 两条路径、删除臆造的 SSE 断线
清理；retainedTail 措辞改为"pi 产出、互转层透传"并定并存优先级；增量对比收益措辞校准）
取代：`apps/server/src/agents/db-session-manager.ts` 现有的"byte-for-byte 存 pi SessionEntry"方案（v9 现状）
Schema：**拟 v10**（`session_entries` 结构重定义 + 旧数据一次性转换；见 §七迁移策略）

> 本设计源自与 DSH（DeepSeek Harness）session.jsonl 格式的对比讨论。核心论断：
> **pi 的树形 SessionEntry 是 SDK 运行时的内部实现，不是我们的数据模型的必然需求。**
> 数据库是唯一事实，格式由我们定义（面向查询/渲染/统计）；pi 树只存在于内存，
> 边界上用纯函数互转。
>
> rev2 修订记录：§二.3 载荷规格全面补全（usage=完整 pi Usage、toolResult/compaction 带 details）；
> §二.4 定义 time 列权威性；§二.2 明确 header 定位与 agents 行的关系；§三 详述 timing 元数据
> 数据流；§四 定义往返 invariant 为 `buildSessionContext` 输出等价；§五 新增增量方案对比
> （P2 回应）；§二.3.4 compaction 按 pi 当前方向（retainedTail）重新设计，附 trade-off。
>
> rev3 修订记录：§2.3.2/2.3.3 message 载荷改为"完整 pi AgentMessage 原样 + timing 附加"，
> 不枚举字段（stopReason 真实值为 `toolUse`，示例修正）；§2.3.4 compaction usage 示例对齐
> 完整 Usage；§七 迁移补回填规则（header 合成、effort 解析、timing 缺省）；§3.1 状态机分
> assistant/toolResult 两条路径、删 SSE 断线清理（臆造）；§2.3.4 retainedTail 改"透传"并定
> 并存优先级；§五 收益 #2 措辞校准为"写入/序列化边界"。

---

## 一、目标与动机

现有实现的三个痛点：

1. **session 维护麻烦**：`session_entries.data` 列存 pi 的 SessionEntry JSON（树形 id/parentId），
   `DbSessionManager` 为此维护 `byId`/`leafId`/`labelsById`/`labelTimestampsById` 四套内存索引；
   行上还冗余 agentId/runId 两列 + 5 个索引。实际业务只有线性 message 流，树的复杂度
   是 pi 带来的、又没用到。
   - **已核实**：`appendLabelChange`/`branch`/`branchWithSummary` 运行时**零调用**，
     `labelsById`/`labelTimestampsById` 是纯死代码。
2. **timeline 看不到系统提示词**：systemPrompt 只存在 `agents.system_prompt` 列（每 agent
   最新值），会话历史里没有快照，无法追溯"这轮对话当时用了什么系统提示词/模型配置"。
   - **已核实**：`agents.system_prompt` 在 createAgent 时写一次（schema 注释原话），
     冷恢复时原样复用（`run/service.ts` L1674 `systemPrompt: agentRow.systemPrompt`），
     运行时**无 update 改写它**。即"最新值 = 初始值"。
3. **看不到 chunk 耗时**：前端 `durationMs` 字段（`conversation.ts` L142、`timeline.tsx` L358）
   定义了、渲染了，但**从未被赋值**——是死代码；工具耗时是运行时 `Date.now()` 计时，
   刷新后丢失。

### 设计原则

1. **数据库为唯一事实**：格式完全由我们定义，与 pi 无关。前端直接消费结构化字段，
   SQL 可直接聚合统计（usage、耗时），不再 parse pi JSON。
2. **pi 树只存在于内存**：pi SDK 每次请求调用 `buildContextEntries`（导出纯函数，
   喂 entries+leafId+byId 即可），故运行时内存里维护一棵 pi 树；持久化时把每次 append
   **转换**成我们的事件行。
3. **格式极简**：只有业务上看得懂的东西。5 种事件类型，无树、无 turn/step、无 pi 概念外漏。

---

## 二、格式规格

### 2.1 表结构

```
session_entries (
  seq        INTEGER NOT NULL,   -- 会话内单调递增；既是顺序也是唯一 id
  session_id TEXT    NOT NULL,   -- 归属会话（sessions.id）
  type       TEXT    NOT NULL,   -- message | header | compaction | model_change | thinking_level_change
  time       INTEGER NOT NULL,   -- epoch ms（权威性见 §2.4）
  data       TEXT    NOT NULL    -- 载荷 JSON（不含 type/time/seq）
)
UNIQUE (session_id, seq)
INDEX  (session_id, type)
```

对比 v9 删除的列：`id`（seq 够用）、`parentId`（没有树）、`agentId`/`runId` 冗余列
（经 `sessions` 关联；run 级查询 join `sessions → agents` 一次即可）、`createdAt`
（time 已含）。

**边界约定（写死）**：`header` 恒为 seq 0。消息查询用 `gt(seq, after)` + renderable
类型白名单过滤（`header` 不在白名单，天然被滤掉）；任何人不得把 `after` 默认值改成
`< 0` 或把 `header` 加入白名单，否则 timeline 头部会出现配置卡片。

### 2.2 事件类型（全部 5 种）

| type | 载荷 | 何时写 |
|---|---|---|
| `header` | systemPrompt + 模型配置 + tools 列表 | **session 创建时写一次（seq 0）** |
| `message` | 完整 pi `AgentMessage` 原样 + `durationMs` + `blocks`（§2.3.2，**不枚举字段**） | 每条用户/助手/工具结果消息 |
| `compaction` | summary + tokensBefore + usage + details + firstKeptSeq? + retainedTail? | 上下文压缩时（CTF 长会话必需） |
| `model_change` | provider / model / effort | 切换模型时 |
| `thinking_level_change` | thinkingLevel | 切换推理强度时 |

**`header` 与 `agents` 行的关系（对 P1-5 的回应）**：`agents.system_prompt` 是 createAgent
时的渲染快照，运行时不变（已核实）。`header` 事件与它**内容重复**，但定位不同：
`agents` 行是存储，`header` 是 **timeline 可见性**——前端渲染会话头部卡片时读
`session_entries` 的 seq 0，不读 `agents` 表。若实施中认为冗余不可接受，可选方案：
前端直接读 `agents.system_prompt` 渲染（零 schema 改动），header 事件砍掉——见 §五
增量对比。

### 2.3 载荷规格（字段完整，不允许省略）

#### 2.3.1 `header`

```json
{ "type": "header", "seq": 0, "time": 1786668443361, "data": {
  "systemPrompt": "You are the AegisX scheduler for the event \"MoeCTF 2025\"...",
  "config": { "provider": "zai-coding-cn", "model": "glm-5.2", "effort": "high", "maxTokens": 131072 },
  "tools": [ { "name": "bash", "description": "...", "parameters": {...} } ]
}}
```

`config` 字段与 DSH `request/header` 对齐（provider/model/effort/maxTokens）。

#### 2.3.2 `message`（assistant）

**规则：`data` = 完整的 pi `AgentMessage` 原样 + 附加的 `durationMs`/`blocks`。不枚举
message 字段**——枚举一次漏一次（现网真实 assistant message 还有 `api`/`provider`/`model`/
`stopReason`/`timestamp`/`responseId`/`rawStopReason`/`errorMessage` 等字段），pi 未来加
字段也不该要求我们改 schema 描述。以下示例的 message 部分即现网真实形状（仅省略长文本）：

```json
{ "type": "message", "seq": 12, "time": 1786668453182, "data": {
  "role": "assistant",
  "content": [ {thinking块}, {text块}, {toolCall块} ],
  "api": "openai-compatible",
  "provider": "zai-coding-cn",
  "model": "glm-5.2",
  "usage": {
    "input": 4771, "output": 105, "cacheRead": 0, "cacheWrite": 0,
    "reasoning": 62, "totalTokens": 4876,
    "cost": { "input": 0.00066794, "output": 0.0000294, "cacheRead": 0, "cacheWrite": 0, "total": 0.00069734 }
  },
  "stopReason": "toolUse",
  "timestamp": 1786668453182,
  "responseId": "resp_xxx",
  "rawStopReason": "tool_calls",
  "durationMs": 45312,
  "blocks": [
    { "type": "thinking", "index": 0, "startMs": 0,     "endMs": 38000 },
    { "type": "text",     "index": 1, "startMs": 38000, "endMs": 45000 },
    { "type": "toolCall", "index": 2, "startMs": 45000, "endMs": 45312 }
  ]
}}
```

- **`usage` 必须 = 完整的 pi `Usage` 对象**（input/output/cacheRead/cacheWrite/reasoning/
  totalTokens/cost.total 及 cost 分项）。这是 `entry-usage.ts` 的 `accumulateEntryUsage`
  正在累计的七个维度（成本分解 + cache 命中率全靠它），也是"SQL 可聚合 usage"这一设计
  原则的前提。**不允许**简化为 `{input, output}`。
- **`stopReason`/`errorMessage` 必须原样保留**：前端 `conversation.ts` 靠
  `message.stopReason === "error" && message.errorMessage` 渲染错误块；`stopReason`
  真实值为 `toolUse`（现网 124 条）/`stop`（1 条），toolResult 为 null。
- **`provider`/`model` 必须原样保留**：每条 assistant 消息实际用的模型，timeline 模型
  标注与"中途换模型"的细粒度追溯全靠它（`agents` 行只存一个静态值）。
- 附加字段 `durationMs`/`blocks` 只出现在**运行中新写**的行；迁移的旧行无 timing（§七.3）。

#### 2.3.3 `message`（toolResult）

```json
{ "type": "message", "seq": 13, "time": 1786668457885, "data": {
  "role": "toolResult",
  "toolCallId": "call_abc",
  "toolName": "bash",
  "content": [ "命令输出..." ],
  "details": { "terminal": "timed_out", "exitCode": 124, ... },
  "isError": true,
  "durationMs": 8432
}}
```

**规则同 assistant**：`data` = 完整的 pi `AgentMessage` 原样（role/content/toolCallId/
toolName/details/isError/usage/timestamp/...）+ 附加 `durationMs`。示例字段齐全仅因
toolResult 的字段集较小，不是白名单。

**`details` 必须保留**：bash 工具非零退出时 SDK 的 `isError` 为 false，前端
`terminalOfDetails` / pipeline `terminalOf` / `toolStatusLabel` 全靠 `details.terminal`
（timed_out/cancelled/failed）做结构化失败分类。漏掉 = 所有失败退回"普通失败"。

#### 2.3.4 `compaction`（对 P0-3 的重新设计）

```json
{ "type": "compaction", "seq": 45, "time": 1786668500000, "data": {
  "summary": "已完成前两题...",
  "tokensBefore": 85213,
  "usage": {
    "input": 1234, "output": 567, "cacheRead": 0, "cacheWrite": 0,
    "reasoning": 0, "totalTokens": 1801,
    "cost": { "input": 0.001, "output": 0.0001, "cacheRead": 0, "cacheWrite": 0, "total": 0.0011 }
  },
  "details": { "readFiles": ["a.c"], "modifiedFiles": ["b.c"] },
  "firstKeptSeq": 12,
  "retainedTail": null
}}
```

**方向判断**：pi 的 compaction 正在从 `firstKeptEntryId`（legacy）迁移到
`retainedTail`/`n`（压缩后近期消息直接存 entry 上）——`pi-agent-core` 的
`CompactionResult` 已带 `retainedTail?`（标注 "Optional during Pi 2.0 transition"），
官方 compaction.md 明说 "Save CompactionEntry with summary and n"。
**但 AegisX 当前的运行时（pi-coding-agent 旧 API）只产生/消费 `firstKeptEntryId`**
（旧包 `buildContextEntries` 源码不识别 n 字段），且现网 compaction **0 行**。

据此 schema 的设计取舍（见 §八.2 待拍板）：
- `firstKeptSeq`：今天有值（旧 API 的锚点，恢复时互转层 O(1) 映射为 firstKeptEntryId）。
- `retainedTail`：今天恒 null（旧 API 不产生）。**它由 pi 新 harness 在 compaction 时产出
  并透传**（`AgentMessage[]`），互转层只负责"搬进 data / 恢复时搬回 entry"，不合成内容；
  pi-coding-agent 升级后 schema 不动、只改互转层透传逻辑。
- **并存优先级（写死）**：`firstKeptSeq` 与 `retainedTail` 同时有值时，**`retainedTail`
  权威**（自包含 checkpoint，不再回溯旧 entry），`firstKeptSeq` 仅在 `retainedTail` 为
  null 时生效——与 pi 的 `buildContextEntries` 语义（`if (compaction.n) ...` 优先）对齐。
- 不选择"只存 retainedTail、恢复时按内容匹配找锚点"——旧 API 下无法可靠重建，
  且引入消息内容匹配的脆弱逻辑，收益为零（今天没有任何 retainedTail 数据源）。

#### 2.3.5 `model_change` / `thinking_level_change`

```json
{ "type": "model_change", "seq": 46, "time": 1786668500100, "data": {
  "provider": "opencode-go", "model": "deepseek-v4-flash", "effort": "medium"
}}
{ "type": "thinking_level_change", "seq": 47, "time": 1786668500200, "data": {
  "thinkingLevel": "high"
}}
```

### 2.4 `time` 列的权威性（对 P0-4 的回应）

pi 的 entry 有 `timestamp`（ISO 字符串，pi 写入时刻），message 内部又有 `timestamp`
（Unix ms，模型侧时间戳）。**规则（写死）**：

- 行级 `time` = **pi entry.timestamp 的 epoch ms**（`new Date(entry.timestamp).getTime()`）。
  这是行的权威时间，用于排序、耗时差、前端显示。
- message 内部的 `timestamp` 字段**原样保留**在 `data` 的 message 对象里，不转换、
  不作为行时间来源。
- 恢复时 entry.timestamp 由 `time` 列生成 `new Date(time).toISOString()`。
- 两者理论上同值（毫秒精度）；ISO→ms→ISO 往返在毫秒精度下无损，亚毫秒不承诺。

---

## 三、耗时设计（参数生成 vs 工具执行）

一次完整的工具调用在时间轴上分成三段，分别落在两条记录上，靠 `callId` 关联
（前端 `conversation.ts` 已有按 callId 匹配的逻辑）：

```
[思考/文本生成]   →   [参数生成]      →   [工具执行]      →   [结果回填]
thinking块           toolCall块          toolResult          （下一条 assistant）
blocks[start,end]    blocks[start,end]   durationMs
```

1. **参数生成耗时** = assistant message 的 `blocks` 中 `toolCall` 块的 `startMs→endMs`
   （模型流式输出工具名 + 参数的时长，即 toolcall_start → toolcall_end）。
2. **工具执行耗时** = 对应 toolResult message 的 `durationMs`
   （tool_execution_start → tool_execution_end，**不是**"结果时间减参数生成时间"推算，
   排队间隙、SDK 调度延迟不会被算进工具执行耗时）。
3. **顺带可看**：`toolResult.time − toolCall 块 endMs` = 工具排队/调度间隙
   （多个工具并行时该值明显，能暴露并行度问题）。

### 3.1 timing 元数据数据流（对 P1-6 的详述——实现风险最高的部分）

**数据源在 pipeline（`event-pipeline.ts`），落库在 `DbSessionManager.commit`**——两个不同
对象，现网唯一耦合是 `onAppend(entry, seq)` 回调。要落地，pipeline 需新增**按 agent 的
计时状态机**。**必须分两条路径**（assistant 与 toolResult 的计时来源不同）：

```
── assistant 路径 ──
message_start          → 记 t0（本条 message 级起点）；重置 blocks 累积器
message_update         → text_delta/thinking_delta/toolcall_delta：
                          若该 block 无 startMs 则记 start（相对 t0 的偏移），
                          持续更新 endMs
toolcall_start/end     → 记 toolCall 块的 start/end（= 参数生成耗时）
message_end            → durationMs = message_end − t0；组装 blocks

── toolResult 路径（不经 message_start，pipeline 现跳过其 draft）──
tool_execution_start   → 记 toolCallId → execStart
tool_execution_end     → durationMs = execEnd − execStart（= 工具执行耗时）
                          写入对应 toolResult 行；不产生 blocks
```

toolResult 的 `durationMs` 只来自 `tool_execution_start/end`：pipeline 的 `message_start`
对 toolResult 是**跳过**的（`event-pipeline.ts`：不发 draft），且即便记 t0 也是 pi 创建
toolResult 消息的时刻（工具执行完之后），不是工具开始。

**关联路径**：`onAppend(entry, seq)` 回调里按 `entryKeyOf(agentId, entry)`（现有稳定 key）
从计时状态回捞元数据，交给 convert 层写入行。**这是新的 pipeline 状态 + 新的 join 路径**，
不是"记录时间戳"一句话的事。

**计时状态的生命周期**：随 `message_start` 重置（assistant 累积器）、随 agent session 销毁
回收。**没有**"SSE 断线/重连清理"——计时状态住在服务端 pipeline，生命周期 = agent
session；SSE 是 server→browser 传输层，客户端断线重连不经过服务端 pipeline，不存在
该 hook（`resetForReconnect` 是前端的）。已落库的行不受任何重连影响（元数据在 commit
时已固化）。

单测覆盖：
- 构造 `message_start → deltas → message_end` 序列，断言 assistant 的 `durationMs/blocks`
  落库正确。
- 工具并行场景：多个 `tool_execution_start/end` 交错，断言每个 callId 的 execStart/end
  不串线、写入各自的 toolResult 行。
- toolResult 行**不**因 `message_start`（被跳过）而产生错误的 durationMs。

---

## 四、互转层（pi 概念唯一存在的地方）

纯函数集中在 `apps/server/src/agents/session-convert.ts`：

- **写入**：pi SDK append → 内存维护 pi 树（SDK 运行时必需）→ 转换器把 entry 转成
  事件行 → 落库。`durationMs/blocks` 由 pipeline 计时状态补充（§3.1）。
- **恢复**：读全部行 → 转换器生成 pi 的 id/parentId、重建树 → 交给 pi SDK 继续跑。

### 4.1 往返 invariant（对 P1-7 的明确定义）

pi 的 entry id 是 `randomUUID().slice(0,8)`，互转层每次 load 重新生成，**"往返一致"
不可能是树原样不变**。可保证且唯一需要保证的 invariant 是：

> **断言**：给定事件行序列，重建树后 `buildSessionContext(entries, leafId, byId)`
> 输出的 `messages`/`thinkingLevel`/`model`，与"原始 pi 树直接 build"的结果
> **逐字段相等**（按 role/timestamp/content/usage 深度比较）。

compaction 的 `firstKeptSeq` 恢复时映射为 `firstKeptEntryId`（转换器内部 id map），
不模拟 pi 的 leaf 推导逻辑。

### 4.2 未用的 pi 类型

label/custom/custom_message/branch_summary/session_info 写入时忽略或记录为 custom；
`branch()`（改 leaf 不写 entry）AegisX 未用，标记 unsupported。`DbSessionManager`
相应简化：删除 labelsById/labelTimestampsById（零调用死代码），保留 fileEntries + byId
（pi SDK 的 getEntries/getEntry/buildContextEntries 需要）。

---

## 五、增量方案对比（对 P2 的回应）

**三个痛点的"增量解法"成本远低于 v10，且大部分痛点不碰 schema 就能解决**：

| 痛点 | v10 方案 | 增量解法（成本） |
|---|---|---|
| ① 维护麻烦 | 整表重定义 + 互转层 + 迁移 | 删 `labelsById`/`labelTimestampsById`（零调用死代码，约 30 行）；冗余列留着无害 |
| ② 看不到系统提示词 | 新增 `header` 事件 | **前端直接读 `agents.system_prompt` 渲染会话头部**（零 schema 改动，已核实该列 = 初始快照且运行时不变） |
| ③ 看不到耗时 | 块级 `blocks[]` + 消息级 `durationMs` | `session_entries` 加一列 `meta TEXT` 存 timing JSON，pipeline 写入，前端读 `row.meta` |

**v10 相对增量的额外成本**：重定义表 + 双向 convert 层 + 往返 invariant 测试 + 一次性
迁移 + 永久背着 pi 兼容（compaction 锚点语义）。**v10 相对增量的额外收益**：

1. **格式统一**：`data` 列从 pi 黑盒（树形 SessionEntry）变成自有 5 种事件，心智模型
   简单清晰——这是用户在讨论中反复表达的诉求（"不需要 pi 的树状格式"、"简单清晰"）。
2. **写入/序列化边界收敛在互转层**：将来 pi-coding-agent 升级 API（compaction 的
   retainedTail 等），增量方案的 pi JSON 序列化仍散在 convert 层与各处 `row.data` 消费点
   （已核实：session 数据消费点现为 `readSessionEntries`/`accumulateEntryUsage`/
   `buildConversation` 三处），v10 把"pi ↔ 行"的转换收敛到 convert 层一个文件——不是
   消灭 parse 点（这些消费点 v10 后依然存在，只是吃新形状），而是把序列化边界收口。
3. **SQL 可聚合**：usage/耗时成为规范字段，`json_extract` 也能在增量方案下聚合
   （`meta`/pi JSON 均可），此点不构成硬需求。

**结论**：纯技术层面，增量方案成本显著更低、三个痛点均可解决，v10 没有"增量做不到"
的硬需求。v10 的价值是心智统一 + pi 兼容收敛，属主观偏好。**决策权交给用户**：
若目标是"最小改动解决三个痛点"，选增量；若目标是"格式彻底归我所有"，选 v10。
本文档后续章节按 v10 编写，增量方案的落地路径见 §八.4。

---

## 六、前端影响

- API 返回的行结构直接渲染，不再 parse pi JSON；`buildConversation` 重写：
  message 行 → user/agent 项；header/compaction/model_change/thinking_level_change 行
  → system 项（header 渲染为可展开的"系统配置"卡片）。
- `durationMs` 死代码复活：assistant 行显示总耗时，blocks 显示每块耗时，工具块显示
  `参数生成 3.0s · 执行 8.4s`。
- toolResult 渲染 `details.terminal`（超时/取消/失败分类，现网已有逻辑，仅数据来源
  从 pi message 改为行字段）。
- streaming：pipeline 产出草稿（无 seq）→ committed（有 seq），store 以
  role+timestamp 组合 key 匹配替换（现有 `messageIdOf` 机制不变）。

---

## 七、迁移策略（schema v10）

遵循 [migrations.md](./migrations.md) 的"migrate forward，不 wipe"路线：

1. `schema.ts` 重定义 `session_entries`（新列集）+ `sessions` 表不变。
2. 迁移脚本（drizzle `0004_session_format_v10`，additive backfill）：
   - 新表 `session_entries_v10` 建好；
   - 一次性转换：读旧 `session_entries.data`（pi JSON）→ 复用互转层写入方向转换器
     → 写新表（usage/details 全字段保留，仅结构重组）；
   - 表改名（DROP 旧表 / RENAME 新表）按 migrations.md 的 additive 写法。
3. **回填规则（不补则违反 §4.1 invariant）**：
   - **header（seq 0）**：旧会话无 header 事件。迁移时为每个旧 session **从 `agents` 行
     合成**：`system_prompt` → header.systemPrompt，`model`（规范串）→ header.config，
     工具名列表 → header.tools。已核实该列运行时不变，合成的即初始快照，语义自洽。
   - **model_change.effort**：旧行只有 `{provider, modelId}`，无 effort。从 `agents.model`
     规范串 `<provider>/<modelId>:<effort>` 解析回填，解析失败置 null。
   - **timing**：旧行无计时数据，`durationMs = null`、`blocks = []`；只有迁移后新写的行
     才有 timing。
4. 旧数据量小（当前 310 行：296 message / 7 model_change / 7 thinking_level_change，
   **compaction 0 行**——迁移路径的 compaction 转换无真实数据验证，需用构造数据单测）。
5. 升 `SCHEMA_VERSION` 至 10。

---

## 八、开放决策点

1. **compaction 锚点**（§2.3.4）：推荐"firstKeptSeq 今天用 + retainedTail 字段预留、
   pi 升级后透传填充"。备选：只存 retainedTail（今天无法消费，不推荐）。
2. **header 存废**（§2.2）：若接受"前端直接读 `agents.system_prompt`"，header 事件砍掉，
   事件类型降为 4 种。推荐：**保留 header**（格式自包含、不依赖 agents 表、可追溯），
   但若用户倾向最小改动，走增量方案时自然砍掉。
3. **增量 vs v10**（§五）：请用户基于完整信息拍板。倾向：若三个痛点都要解决且未来
   会继续深度使用 session 数据，v10；若只求快速止血，增量。
4. **sessions 表去留**：session 与 agent 1:1，可折叠进 `agents` 表；保留则改动最小。

# 并发与竞态审查

## 范围与方法

- **范围**：`apps/server/src/run/service.ts`、`run/queue.ts`、`run/scheduler-admin.ts`、`run/fence.ts`、`run/sse.ts`、`run/agent-status.ts`（触发点核对）、`agents/lifecycle.ts`（锁原语）、`db/index.ts`（pragma）、`scheduler/routes.ts`。
- **方法**：静态精读核心文件；枚举所有共享可变状态的写入点与跨 await 边界；对每个疑点推演具体触发时序。未执行任何测试或服务器。

## 并发模型梳理

进程内三层串行化，全部基于 promise-chaining（单线程事件循环，无真正并行）：

1. **per-agent 锁**（`chainLock`，lifecycle.ts:171-182）：所有针对单个 agent 的操作（turn 驱动、stop/close/finish/delete/model switch）串行于同一 key。链空时删除 map 条目，无泄漏。
2. **全局 fence 锁**（`withFence`，service.ts:175-177）：序列化「并发额度检查 + agent 行插入」临界区（agent-factory.ts:658-691），保证 cap 不被并发 spawn 击穿。注释明确了锁序：fence 临界区绝不获取 agent 锁 → 无环，无死锁（service.ts:168-174）。
3. **队列 drainer**：单飞标志 `draining` + 200ms debounce（queue.ts:424-439）。

持久层：SQLite WAL + `busy_timeout = 5000`（db/index.ts:169-171）；本审查范围内未见显式事务，但关键多步写均用 **带守卫的 WHERE** 弥补（见正面验证）。

SSE：订阅先于快照 seed，重复事件由前端幂等消化（sse.ts:8-13）；pump 的 push/drain 全部同步，单线程下不存在「检查 queue.length 与挂起 Promise 之间插入事件」的窗口。

## 状态机转换表

### Agent（apps/server/src/run/agent-status.ts + service.ts）

| from → to | 触发点 | 守卫 | 原子性 |
|---|---|---|---|
| (spawn) → idle | factory.spawnAgent，fence 内 insert（agent-factory.ts:668-690） | checkSpawnFence（solver） | ✅ fence 锁内 |
| idle → running | lifecycle drive → onTurnStart（lifecycle.ts:85） | 代数计数器 gen++ | ✅ send 在 agent 锁内调用 drive |
| running → idle | turn settle（lifecycle.ts:101-112） | `gen` 一致 + session 身份一致，否则 no-op | ✅ settle 重入 agent 锁复核 |
| live → completed/aborted/failed | terminalizeAgent（agent-status.ts:129-158） | ⚠️ 无当前态复核（见 F3） | DB 单语句原子 |
| terminal → 复活（reopen） | sendMessage onResume / startScheduler | 仅显式路径 | ✅ |

### Queue item（run/queue.ts）

| from → to | 触发点 | 守卫 | 结论 |
|---|---|---|---|
| (insert) → pending | enqueue:193-209 | 无（v19 允许同题多项，合法） | ✅ |
| pending → running | markRunning:359-366 | WHERE `id AND status='pending'` | ✅ 双领不可能 |
| pending → failed | markFailed:369-376 | 无状态守卫（drainer 单飞下安全） | ✅（依赖 F1 修复） |
| pending → cancelled | cancelPendingForChallenge:277-285 / markCancelled:380-385 | UPDATE 带 `status='pending'` / 无守卫 | ✅ / ⚠️ 见 F6 |
| running → done | markDone:393-408 | WHERE `id + agentId + running` | ✅ |
| running → pending | resetRunning:413-420（仅启动恢复） | WHERE eventId+running | ✅ |

### Scheduler paused（schedulerConfig.paused）

setSchedulerPaused 为 upsert（scheduler-admin.ts:292-317），读改写虽非事务但单用户场景冲突后果仅是标志位覆盖，可接受。

## 发现

### F1 · P2 · drainer 丢失尾随触发 → 排队项静默饥饿

- **位置**：queue.ts:450-454（`drainOnce` 入口早退）对照其自身注释 queue.ts:442-449 与 scheduleDrain:429-439。
- **证据**：
  ```ts
  async function drainOnce(): Promise<void> {
    if (draining || deps.isDisposed()) return   // ← 触发被吞
    draining = true
  ```
  注释声称 "a pass already in progress ignores new triggers (**the trailing trigger schedules a fresh debounced pass**)"——但代码没有任何重排逻辑：debounce 回调把 `drainTimer` 置 null 后调 `drainOnce()`，早退即该次触发永久消失。
- **触发时序**：(1) enqueue A → T1 定时；(2) T1 触发，pass 开始，`launch` 含容器构建耗时数秒，`draining=true` 贯穿全程；(3) 期间 enqueue B → `scheduleDrain` 设 T2；(4) T2 到期 → `drainOnce` 早退；(5) pass 结束，B 永久 pending。
- **影响**：B 只能等下一个无关事件解围——触发源仅有三处：enqueue（queue.ts:213）、任意 agent 终态（agent-status.ts:150）、队列 resume（scheduler/routes.ts:154）。全员空闲的安静舰队里 B 无限等待；更糟的是 B 若是最后一项，starved 急报（2→1 边沿）也依赖这些同样的丢失路径。
- **建议**：`finally { draining = false }` 改为「若期间有新触发则再排一轮」——如 `drainRequested` 标志：早退路径置位，pass 结束时检查并 `scheduleDrain()`。一行级修复。

### F2 · P3 · startScheduler 并发双开 orchestrator

- **位置**：service.ts:1027-1061。
- **证据**：函数先读 `getSchedulerAgent(eventId)` 判活跃，再走 reopen 或 fresh spawn 分支；两次 HTTP `/scheduler/start` 并发到达时都读到「无活跃」，双双走到 `factory.spawnAgent({ role: "orchestrator" })`。orchestrator 不过 fence（fence.ts:172 注释明示 scheduler 永不计入），insert 无唯一约束兜底（`deleteSchedulerAgent` 按 role 批删，暗示多行合法，scheduler-admin.ts:397-401）。
- **影响**：产生两个 orchestrator 行，`getSchedulerAgent` 任取其一，另一个成幽灵（占容器、烧 token）。本地单用户需双击/重试才触发，故降为 P3。
- **建议**：spawn 分支包进 `withFence`（复用现有全局锁，orchestrator 不占额但可借锁串行），临界区内二次确认无活跃行。

### F3 · P3 · closeAgent/finishAgent 锁外预检、锁内不复核

- **位置**：service.ts:389-405（closeAgent）、420-441（finishAgent）。
- **证据**：两函数先在锁外读 `agent.status` 决定拒绝/幂等返回，随后 `withLock` 内直接 `status.terminalizeAgent(...)`，临界区内**没有重读当前态**。两个并发 closeAgent 都通过预检后顺序进锁，第二次对已 aborted 的行再次 terminalize + emit，产生重复终态事件与 `completedAt` 覆盖。finishAgent 注释宣称 "Idempotent on an already-completed agent"，仅在非并发读下成立。
- **影响**：重复 SSE 事件（前端按 agent.updated 幂等消化，实际危害小）；语义上破坏了声明的幂等性。
- **建议**：锁内首行重读 agent 行并复用同一守卫判断，约 4 行改动。

### F4 · P3 · haltChallenge / stopOthersOnSolved 的快照-逐个关闭 TOCTOU

- **位置**：service.ts:461-478（haltChallenge）、974-989（stopOthersOnSolved）。
- **证据**：先 SELECT 当前 live agents 快照，再逐个 `await closeAgent`。循环期间 drainer 可并发 spawn 新 agent（不在快照中）——haltChallenge 的 `cancelPendingForChallenge` 在关闭之后才执行，处于「已 launch 但 agent 行晚于快照插入」窗口的排队项两头漏网。
- **影响**：手动强停一题后可能残留一个刚孵化的 agent 继续跑。窗口毫秒级，操作员可再次 halt 兜底。
- **建议**：cancelPending 提前到关闭循环之前，并在循环结束后复查一次 live 快照（或接受现状，文档注明）。

### F5 · P3 · enqueue 的 nextOrd 读改写竞态 → ord 冲突

- **位置**：queue.ts:173-180（nextOrd）、190-215（enqueue）。
- **证据**：`max(ord)+1` 在无锁状态下计算，两个并发 enqueue 同事件可得到相同 ord；排序回退到 `createdAt`（ISO 毫秒串），同毫秒内则顺序不定。`reorder`（queue.ts:318-331）写入 `index+1` 也会与未参与 reorder 的存量项撞号。
- **影响**：仅 FIFO 展示顺序歧义，无功能正确性问题（drainer 注释已声明只承诺 non-starvation，queue.ts:339-341）。
- **建议**：可接受现状；若要修，enqueue 包进 `withFence` 即得串行化。

### F6 · P3 · markCancelled 单项路径绕过 starved 边沿检查

- **位置**：queue.ts:380-385 对照 cancelPendingForChallenge:286、remove:244、markFailed:375（三处均调 `checkStarved`）。
- **证据**：drainer 的 challenge_solved 分支（queue.ts:463-465）走 `markCancelled(item.id)`，是唯一不触发 `checkStarved` 的 pending 消耗路径。若被取消的恰是倒数第二项，2→1 急报丢失。
- **建议**：markCancelled 内补一行 `checkStarved`（需要 eventId——row 已在手）。

### F7 · P3 · starvedFired 按事件累积不清理

- **位置**：queue.ts:128。
- **证据**：`starvedFired` Map 以 eventId 为 key，只在计数回升时置 false，事件删除后条目永存。量级极小（每事件一个 boolean），纯卫生问题。

### F8 · P3 · service.close() 与在途 withLock 的窄窗口

- **位置**：service.ts:1173-1190。
- **证据**：`closed = true` 后 `await Promise.allSettled(locks.values())` 再清 map、逐层关闭。在 allSettled 已解析与 `locks.clear()` 之间提交的新 op 能通过 chainLock 挂上旧链（此时 closed=true 会被 withLock 入口拒绝——但 chainLock 直接暴露给了 lifecycle/settle 路径，settle 的 `options.withLock` 即 service.withLock，有 closed 检查，实际已被挡住）。剩余风险集中在 close 自身继续 dispose 时与刚拒绝的 op 无交集。结论：**当前实现基本自洽**，仅提示该不变量依赖 withLock 入口的 closed 检查这一事实，重构时勿绕过。

## 正面验证（明确排除的疑点）

- **fence 原子性与锁序**：checkSpawnFence 纯读 + insert 同在 fence 临界区（agent-factory.ts:658-691），cap 击穿不可能；fence 不嵌套 agent 锁，无死锁环。✅
- **stale settle 防护**：lifecycle 的代数计数 + session 身份双重校验（lifecycle.ts:107-111），forceAbortAgent（deadline 强杀，不走锁）与正常 settle 竞争时后者自动哑火。✅ 这是上轮 "detach 漏判 idle" 类问题的机制级修复，未发现同类谓词残留。✅
- **SSE 事件零丢失窗口**：subscribe 先于 seed；push→drain 全同步；abort 经 resolveNext 唤醒退出，订阅在 finally 必退订（sse.ts:30-57），无泄漏。✅
- **DB 写纪律**：markRunning/markDone/cancelPendingForChallenge 的条件 UPDATE 使 check-then-act 天然幂等；busy_timeout=5000 + WAL 足够单进程场景。✅
- **now() 单调时钟**（service.ts:149-157）：消除了同毫秒 createdAt 平手，好设计。✅
- **boot 恢复**：resetRunning 仅由 recoverOnBoot 调（agent-factory.ts:880 明确 boot 不自动 drain），无误启动。✅

## 建议（按优先级）

1. **F1**：drainOnce 加 drainRequested 重排（P2，唯一影响可用性的发现）。
2. **F3**：closeAgent/finishAgent 锁内复核当前态（4 行）。
3. **F6**：markCancelled 补 checkStarved（1 行）。
4. **F2**：startScheduler spawn 分支入 fence（防双开）。
5. **F4/F5/F7**：记录取舍即可，本地单用户下不值得复杂化。

## 未确认事项

- channels.ts（1491 行）与 stall-watchdog、deadlines 的内部定时器竞争未逐行审计（超出本轮收窄范围）；其对外接口（channels.post/deliver、noteAgentIdle）在本范围内的调用点未见明显竞态。
- providers/routes.ts 的 provider 测试流 SSE 与本主题交叉部分未审（归 04 号文档方向）。
- Bun.serve idleTimeout 对长连接的实际行为（index.ts:27 有注释提及）未做运行验证。

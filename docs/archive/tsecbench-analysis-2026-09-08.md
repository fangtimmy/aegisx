# TSecBench 完整基准测试分析（2026-09-08）

本文是 2026-09-08 那次 TSecBench 完整跑批的复盘：先给出成绩与资源模型，再逐层定位
Harness / Infra / 调度策略暴露的问题，最后给出按投入产出比排序的优化清单与评测场景
特调方案。所有结论都附带可复现的查询口径（见[附录](#附录数据与查询口径)）。

分析基于两个独立来源交叉验证：一次运行期只读监测，以及两份互不共享上下文的独立
轨迹分析（结论已逐条复核，冲突处以代码与数据为准，见[§8](#8-需要标注待验证的事项)）。

---

## 1. 摘要

| 指标 | 值 |
|---|---|
| 运行时长 | 5h58m（08:59–14:57 UTC） |
| 成绩 | **58/63 题完全解出，20,650/23,000 分（89.8%），66/74 flag** |
| Agent | 208 个 solver + 1 个 orchestrator |
| 成本 | 约 $2.1–2.6（含缓存读取的 token 总量 228M solver / 300M 全量） |
| 峰值并发 | solver 4（全局上限 4）；靶机实例 3（平台上限 3） |
| 首次尝试命中率 | 45/63 题由第一个 agent 一次解出 |

**四个主要结论：**

1. **两个资源上限是正交的**，此前一度被混为一谈：`maxConcurrentAgents` 约束的是 LLM
   并发（agent 进程数），平台 3 个靶机实例约束的是 `start_target`。一题多 agent
   **共享**同一个靶机槽位，因此"4 agent / 3 靶机"并不冲突——正确用法是在 3 道题上放
   4 个 agent。真正被浪费的是**同题并行度**：45% 的时间靶机槽满但 LLM 并发没打满。
2. **本次最大的策略失误是调度多样性不足**：11:00–12:20 有 4 个 agent 挤在 2 道题上
   （a-17 独占 3 个），而这两题最终都没解出；同期大量 easy/medium 题在排队。
3. **a-17 的失败是资源问题而非能力问题**：它被靶机槽位饿死 3.4 小时，而编排者没有
   释放靶机实例的手段（详见 §5.2）。
4. **队列排水器缺陷（已修复）制造了 111+ 个幽灵重放**，占 208 个 solver 的过半，
   并通过污染工作区与"尝试次数"统计，反过来误导了调度者的后续决策。

---

## 2. 成绩与效率画像

### 2.1 分系列

| 系列 | 解出 | 得分 |
|---|---|---|
| a | 16/18 | 6800/7200 |
| b | 2/3 | 3000/4200 |
| c | 9/9 | 2100/2100 |
| d | 6/6 | 1800/1800 |
| e1 / e2 / e3 | 13/14 | 3250/3500 |
| f1 / f2 | 12/13 | 3700/4200 |

按难度：easy 8/9、medium 24/25、hard 26/29。唯一完全未解出的是 1800 分的 b-02
（6 个 flag，拿到 2 个）。

### 2.2 时间效率

- **首题启动 → 首个 flag 的中位耗时 1.8 分钟**；35/58 的已解题在 5 分钟内解出。
- **尾部产能更高**：13:14 之后才首次启动的 26 题，中位 **1.2 分钟**解出。
- 结论：**瓶颈从来不是解题速度，而是排程与资源获取**。慢的题（a-04 153min、
  a-03 130min、d-05 117min）全部是槽位争抢窗口里的题，慢在等待与被杀重启。

### 2.3 资源利用率

```
靶机槽位占用:  3个(满) 262min (73%)   2个 70min (19%)   1个 9min
agent 数分布:  4个 182min (51%)       3个 164min (46%)
★ 靶机满(3) 但 agent<4 的分钟: 163/360 (45%)
```

后半行是本次最值得注意的数字：**近一半时间 LLM 并发配额是空着的，而靶机已被占满**。
这些时间本可以在已占用的靶机上追加分工 agent（例如一个主攻、一个专攻旁路）。

同题并行实际几乎没被用起来：63 题中 **54 题从未出现同题并发**（历史最大同题并发数为
1），仅 8 题出现过同题并发（5 题到 2、3 题到 4）；按总 agent 数看，45 题全程只调度过
1 个 agent。

### 2.4 浪费总账

| 项目 | 量 |
|---|---|
| 幽灵重放 | 111+ 个 agent，约 1.9M token |
| Agent 生命周期空闲率（>2min gap） | 48% |
| ≥2min 的前台阻塞 bash | 560 分钟（扫描器 211min、裸 `sleep` 98min、9 次撞 600s 超时全损） |
| `start_target` 409 率（真实 agent） | 55%（93/168）；平台级 242 次 |
| 解出后 token 消耗 | 14.8M（占已解题 token 的 14.1%，占全量的 6.5%，占成本 5.0%） |
| 自通知触发的冗余回合 | 1.84M token（56 个提交者收到自己触发的解出通知） |
| 零分题 token | a-17 + b-02 + f2-05 + e3-04 + a-05 |

---

## 3. 资源模型：两个正交上限

这是本次分析中最重要的概念澄清，直接决定调度建议是否成立。

| 资源 | 上限 | 计数口径 | 超限后果 |
|---|---|---|---|
| LLM 并发 | `scheduler.maxConcurrentAgents` = 4（全局 settings） | 存活 solver agent 数（running + idle） | 新 spawn 被拒，排队 |
| 靶机实例 | 平台硬限制 = 3 | **distinct challenge** 数（`activeTargetSlots` 用 `DISTINCT challengeId`） | `start_target` 返回 409 |

关键推论：

- **一题多 agent 只消耗 1 个靶机槽位**，消耗多个 LLM 并发槽。因此 `maxConcurrentAgents`
  = 4、靶机 = 3 是**互补**的：正确用法是 3 道题 + 1 个额外分工 agent。
- 因此**不应把 `maxConcurrentAgents` 降到 3**——那会砍掉同题分工所需的并发。
- 编排者的系统提示词已经写明了这条规则（"several agents on the SAME target-capable
  challenge share one slot"），但实际调度中几乎未利用。

真正需要对齐的不是这两个数字，而是**调度策略**：当靶机槽满时，把剩余的 LLM 并发用于
已占靶机上的分工，而不是空置等待新靶机。

---

## 4. 问题清单

按"根因 → 表现 → 证据"组织。优先级见 §5。

### 4.1 调度策略

**P-1 三槽全押难题，无多样性约束**

11:00–12:20 的槽位构成：

```
11:00  live=4  distinct=2   b-01, b-01, f2-05, f2-05
11:30  live=4  distinct=2   a-17, a-17, a-17, c-05
12:00  live=4  distinct=2   a-17, a-17, a-17, a-03
```

被押注的题正是资源黑洞：

| 题 | 累计 agent-hours | 结果 |
|---|---|---|
| a-17 | 3.7 | 未解出 |
| b-02 | 3.5 | 2/6 flag |
| f2-05 | 1.7 | 未解出 |

现行 `nextTaskPolicy` 只有 `eager`/`drained` 两个二元开关，**没有任何性价比、难度或
类型多样性的考量**。缺一个"流水线槽"来保证持续产出与槽位周转。

**P-2 卡住时倾向 steer 而非新开 agent**

编排者的 SDK 调用分布：`close` 46、`enqueue` 42、`message` 27、`start` 12、
`set_timeout` 6。整体 spawn 数（54）确实多于 steer（27），但 **steer 高度集中在卡住的
题上**：d-05 被 steer 3 次、f2-05 2 次、b-02 2 次。而被 steer 的 5 个 agent 全部以
aborted 结束，其中仅 1 个产出了计分 flag。

这与"AI 是抽卡"的本质相符：被 steer 的 agent 已经带着先前思路的上下文，纠偏后仍受
既有假设约束。对**真正卡住**的题，新开一个不同角度的 agent 比反复 steer 同一个 agent
更可能突破。steer 的合理用途是"方向正确但细节跑偏"的轻量修正。

**P-3 开局把预算押在多 flag 硬题上**

开局 96 分钟只调度 b-01 / b-02×2 / b-03 三题，其中 b-02 独占 2 槽约 1.6 小时。
63 题中约 45 题挤在最后 102 分钟，而这些题中位 1.2 分钟即可解出。**先用 quick-win
建立分数底盘并保持槽位周转，再对难题追加投入**，比开局全押硬题更稳。

**P-4 缺少 deadline 感知**

运行末期仍启动注定跑不完的 attempt（e3-04 在 14:49 启动 17 分钟 timeout 的 agent，
距结束仅 7 分钟）。启动前应校验 `剩余运行时间 ≥ 1.2 × timeout`。

**P-5 解出后收尾缺乏硬约束**

按设计，完全解出的提交者会保留会话去写 `WRITEUP.md`（`service.ts` 中
`stopOthersOnSolved` 显式排除提交者），且没有收尾硬超时。

本轮实测**收尾墙钟时间很短**：中位 0.3 分钟、p90 2.3 分钟、最长 6.3 分钟。但**token
消耗不小**：解出后仍消耗 14.8M token（占已解题的 14.1%）。二者不矛盾——收尾通常是一
个带大上下文的长回合，墙钟短但 token 重。

在**评测场景**下写 WP 没有收益（平台只看 flag），应支持"完全解出即停"；在**正常场景**
下 WP 有价值，但也应加**收尾硬超时**兜底，避免个别 agent 长期占用。

**P-6 没有"题目损坏/放弃"状态**

f2-05 被多个 agent 独立判定为 inert/decoy（VM handler 载入死代码、31 字节 blob 高熵
无周期），但系统没有任何机制停止对它派发。`FAILURE.md` 只是提示词约定，服务端不读取；
`manual_solve_state` 只有 `solved|partial|unsolved`，没有 abandoned。

### 4.2 Harness

**H-1 Agent 工作目录永不回收**

`agent-factory.ts` 在 spawn 时 `mkdirSync(agents/<id8>)`，而**全生命周期没有任何删除
路径**（`forceAbortAgent` / `closeAgent` / `finishAgent` / `deleteAgent` /
`deleteAgentsForEvent` / boot recovery 均只 dispose 内存会话）。唯一的 `rmSync` 只在
删除整题/整赛事时触发。

一题的容器与工作区由该题所有 agent 共享，因此残留目录会累积：本次 a-17 留下 46 个、
f2-05 留下 25 个。

**H-2 "尝试次数"把幽灵算作真实失败（污染决策）**

`agents.list` / `challenges.get` 的尝试计数**不过滤状态、不去重**（`catalog.ts` 直接
`select status from agents where challengeId=?`；`queries.ts` 的 `listAgents` 无 status
参数）。幽灵重放因此被计入失败史。直接证据是 a-17 最后一个真实 agent 的 spawn prompt
原文：

> `Prior attempts (45) failed.`

而 a-17 实际只有 4 次真实调度。**幽灵 → 污染工作区与计数 → 误导调度者 → 劝退后续
agent**，形成自我放大的闭环。即使队列缺陷已修，这个放大器仍在。

**H-3 长时间扫描前台阻塞**

Agent 是单线程的：前台跑 ffuf/nmap 10 分钟 = 10 分钟不能思考。本轮 ≥2min 的前台阻塞
共 560 分钟，其中 9 次撞上 600s 的 bash 超时而完全作废（大字典爆破、全盘 grep 等）。
提示词应强制"预计 >2min 的命令一律 `nohup … &` + 轮询"。

**H-4 频道投递预算丢弃最旧消息**

投递上限 8000 字符，超出时保留最新、把更早的折叠为一行计数。长命题目会超预算
（f2-05 15,140 字符、a-17 8,283 字符），而**最早的发现往往就是入口/凭据这类
ground truth**。后继 agent 需要主动 `channels.read` 才能补回，但提示只给了一个丢弃
条数，没有指出丢了什么。

**H-5 同类 SQL 优先级隐患仍存在**

已修复的 `pendingItems` 是"裸 `sql` 片段参与 `and()` 组合导致 OR 逃逸出括号"。同一
模式在 `queue.ts` 的 `clear()` 中仍有一处（当前恰好语义等价，属侥幸）。建议给这类写法
加约束（统一用 `or()` / `and()` 包裹），而不是逐个打补丁。

**H-6 系统通知会被推送给触发它的 agent 本人**

投递时的"排除自己发的帖"只判断 agent 作者（`channels-delivery.ts` 的
`.filter((row) => !(row.authorType === "agent" && row.authorAgentId === agentId))`）。
而 #team 的 flag 通知是**系统消息**（`author: { type: "system" }`），因此永远通不过该
过滤，被推给该题所有存活 agent——**包括刚提交 flag 的本人**。

实测：56 个提交者中 32+ 个在自己的上下文里收到了 `「a-13」已完全解出：flag{...}
（agent-4cfb3973 提交）` 这类通知。收到后行为高度一致（`Flag accepted. Now write
WRITEUP.md and solve.sh...`），触发一轮纯冗余的收尾回合，共消耗 **1.84M token / 56 个
回合（平均 32.9K token/回合）**。

影响面不止解出通知，而是**所有 #team 系统通知**（本轮共 68 条）：

| 通知 | 数量 | 携带 `meta.agentId` |
|---|---|---|
| `flagAccepted`（完全解出） | 58 | 否 |
| `flagPartial`（多 flag 部分解出） | 10 | 否 |

`notifyFlagPartial` 甚至已经接收了 `submitterAgentId` 参数，却命名为
`_submitterAgentId` 并忽略——说明需求被意识到但未实现。

注意：orch 频道的 329 条系统通知（`agent.started` / `flagAccepted` / `finished` /
`timedOut`）都带 `meta.agentId`，但它们发给调度者而非 agent 本人，不受此缺陷影响。

### 4.3 Infra 与平台交互

**I-1 编排者没有靶机控制权（a-17 饿死的直接原因）**

编排者的工具集为空，只能通过容器内 Python SDK + bash 管理。SDK 中**没有靶机控制接口**
（`agents.stop/close/start` 有，`challenges.*` 只读）。编排者自己发现了这一点：

> `KEY: you have a stop_target tool (I, the scheduler, do NOT).`

它因此只能靠 `agents.close()` 试图腾出靶机槽位，但**关闭 agent 不释放平台实例**。
它自己的观测证实了这一点：

```
closed f1-03 73b8e535
live: 4 | targets: ['a-17', 'c-05']      ← live 变了，active targets 没变
```

结果是一轮又一轮徒劳的 close-all，409 依旧。a-17 因此被饿死 3.4 小时，最后一个 agent
在 14:44 才拿到靶机，6 分钟后运行结束。

**I-2 靶机 stop 是 fire-and-forget，与下一次 spawn 竞态**

`stopOthersOnSolved` 中释放靶机是 `void` 调用，不 await、也不触发排水器。eager 策略在
flag 接受的那一刻就认为靶机槽已释放，而平台实例可能仍在关闭中，新 agent 立即
`start_target` 就撞 409。24% 的 409 发生在一次 flag 接受后的 5 分钟内。

**I-3 解出释放靶机不唤醒排水器**

`scheduleDrain()` 只在 enqueue、agent 终结、队列 resume、boot 时触发，**没有周期性
drain**。而 `stopOthersOnSolved` 释放靶机后不调用它；目前之所以还能工作，是因为同题
sibling 被关闭时会顺带触发 agent 终结的 drain。若 `stopSiblingsOnSolve` 关闭，或 close
输了竞态，这次释放就完全没有唤醒排水器。

**I-4 tsecbench 适配器放大请求**

平台**没有单题详情接口**，`getTarget` 每次都重新拉取整个 63 题列表再过滤。本轮
`get_target` 被调用 1050 次。另外 `extend_target` 对本平台无效（靶机永不过期，
`expiresAt: null`），但提示词仍在引导使用（实际只用了 8 次）。

**I-5 多 flag 进度是同步时刻的冻结快照**

题目描述里的"当前已正确 N 个"由同步时拼入，而平台同步只在 boot 与手动路由触发，
没有周期同步。b-02 的描述始终写着"当前已正确 0 个"，而它实际已拿到 2 个 flag。
（实时进度通过 #team 系统通知到达 solver，因此不致命，但描述会误导。）

### 4.4 提示词与上下文

- **Flag 格式从不注入**：提示词让 agent"从题目描述推断格式"，而 tsecbench 全部 68 个
  已接受 flag 无一例外是 `flag{...}`。f2-05 有两次因格式/盲猜被拒的提交。
- **多 flag 进度应实时注入**，而不是读描述里的冻结计数。
- **"同一假设失败两次即换"不可观测**：命令层执行得其实不错（bash 失败率仅 4%，最长
  连续失败 run = 3），说明规则本身不是主要问题；真正缺的是**破题止损**（P-6）。

---

## 5. 优化建议（按投入产出比排序）

### R-1 调度多样性 + 性价比打分（最高收益）

在调度策略中引入多维评分，替代现行的二元开关：

- **性价比**：`points / 预期耗时`，优先快题建立底盘。
- **难度多样性**：槽位组合强制"难题 ≤ 2，且不得为同一题"。
- **类型多样性**：避免同时押注同类题型。
- **流水线槽**：始终保留至少 1 个槽用于快速题，保证持续产出与周转。

配合"槽位组合 = 2 难题 + 1 流水线"，并在靶机满时把空置的 LLM 并发用于已占靶机上的
分工 agent（而非等待新靶机）。

**预期收益**：消除"三槽全卡"；利用当前空置的 45% 并发配额。

### R-2 完全解出即停 + 收尾硬超时

在 `notifyFlagAccepted` 的 `outcome === "first"` 分支（即平台 `is_completed`）增加策略项：

- 评测场景：**立即终止提交者**（不写 WP）。
- 正常场景：允许收尾，但加**硬超时**（如 60s）兜底。

注意语义是"**完全解出**即停"，多 flag 题在拿到中间 flag 时不能停——`outcome ===
"first"` 正是这个信号。

**预期收益**：省约 5% 成本；释放提交者占用的槽位。

### R-3 给编排者靶机控制权（或 close 联动 stop）

两个方案，后者更简洁：

- 方案 A：SDK 暴露靶机 stop 接口给编排者。
- 方案 B：`agents.close()` 在**最后一个同题 agent 离开**时联动停止平台实例
  （`onAgentTerminal` 已有类似逻辑，可复用）。

**预期收益**：直接对应 a-17 那 300 分；消除编排者的无效 close-all 循环。

### R-4 卡住时优先新开 agent 而非 steer

在编排者的调度原则中加入：**对已判定卡住的题，优先 spawn 一个不同角度的新 agent，
而不是反复 steer 同一个**。Steer 保留给"方向正确、细节跑偏"的轻量修正。这与"AI 抽卡、
多样性重要、上下文有惯性"的本质一致。

### R-5 工作区回收 + 尝试计数去伪

- 在 agent 终结路径回收 `agents/<id8>`（或提供显式清理）。
- "尝试次数"改为统计**真实调度**（`spawn_queue` 的 distinct 项）而非原始 agent 行。

**预期收益**：消除污染闭环，避免历史误导后续决策。

### R-6 长命令后台化

提示词强制"预计 >2min 的命令 `nohup … &` + 轮询"。**预期收益**：回收约 200+ 分钟的
等效思考时间，消除 600s 超时全损。

### R-7 破题止损与重复抓取判据

- 编排者接受"LIKELY-BROKEN"裁定：同题 2 个独立 agent 给出一致损坏结论后停止 requeue。
- 每题设总预算上限（如 attempt 数 / token 数）触顶挂起。
- 重复抓取落成可执行判据："相同 URL + 参数只抓一次，之后读本地文件"。

### R-8 平台交互与同步

- 周期同步题目元数据（修正冻结的多 flag 计数）。
- 对 `get_target` 的重复全量拉取做缓存或节流。
- 409 后的退避与"槽位释放"事件对齐。

### R-9 系统通知不投递给触发者（方案 A）

在 #team 系统通知的 `meta` 中写入触发者 `agentId`，投递过滤扩展为同时排除系统消息的
自通知：

```ts
.filter(
  (row) =>
    !(row.authorType === "agent" && row.authorAgentId === agentId) &&
    !(row.authorType === "system" && parseMeta(row.meta).agentId === agentId)
)
```

需要放开 `serverMeta` 对系统作者写 `meta.agentId` 的限制（当前仅在
`author.type === "agent"` 时写入），并让 `postFullSolveTeamNotice` /
`postExtraFlagNotice` / `notifyFlagPartial` 把提交者写进 `meta`（`notifyFlagPartial`
已有该参数，只需去掉 `_` 前缀并透传）。

**语义确认**：当提交者是该题唯一存活 agent 时，这条通知就没有接收者——这正是期望行为
（通知的对象是"同题其他人"）。

**预期收益**：消除 1.84M token 的冗余收尾回合。与 R-2 互补：R-9 消除自通知触发的
回合，R-2 消除剩余的收尾。

---

## 6. 评测场景特调

### 6.1 配置

| 项 | 建议 | 理由 |
|---|---|---|
| `maxConcurrentAgents` | **保持 4** | 与靶机 3 槽正交；多出的是同题分工并发 |
| `max_concurrent_targets` | 3 | 与平台硬限制一致 |
| `stopSiblingsOnSolve` / `stopTargetOnSolve` / `blockSpawnOnSolved` | 保持 true | 与评测语义一致 |
| 新增：解出即停 | 开（评测） | §R-2 |
| 新增：收尾硬超时 | 60s（正常场景） | §R-2 |
| deadline | 分级：hard 多阶段 90–120min，easy 15–20min | 本轮编排者已大致如此 |
| 启动前校验 | `剩余运行时间 ≥ 1.2 × timeout` | §P-4 |

### 6.2 提示词

- 明确 flag 格式 `flag{<uuid>}`，格式不符不要提交。
- 多 flag 进度由服务端实时注入（已确认列表 + N/M），不读描述冻结计数。
- 说明"靶机永不过期"→ 删除 `extend_target` 引导，降低 `get_target` 轮询频率。
- 说明"平台最多 3 个实例；409 表示等待/释放，不要盲目重试"。
- 明确 `category` 是难度（easy/medium/hard），不是题型。
- 加入破题止损交接规范（配合"题目损坏"状态）。
- 加入"卡住优先新开 agent 而非 steer"的调度原则（给编排者）。

### 6.3 镜像

- 全部 63 题都是 target-backed、**零附件**——所有样本都从靶机下载，因此离线工具广度
  不是瓶颈，web/recon + 网络工具才是主路径；full 档已完全覆盖。
- 观察到靶机环境：PHP 7.4/8.x、Apache、MySQL 8.0.46、nginx/openresty；镜像已含
  php-cli、mysql client、sqlmap、ffuf、jq。
- 建议预置靶机网段的路由/`/etc/hosts` 提示，减少每个 agent 重复确认连通性。
- 收益最高的"特调"是一个**靶机槽位助手**：封装"查询当前实例归属 + 按优先级释放 +
  退避重试"，把 409 处理从模型推理降级为一次工具调用。

---

## 7. 明确不是问题（数据否证，避免误投入）

| 项 | 实测 | 结论 |
|---|---|---|
| 字面重复命令 | 0.6% | 不构成浪费 |
| 提交格式错误 | 0（大写 `FLAG{}` 是 f2 系列合法格式） | 健康 |
| 频道开销挤占 | 调用 11%、上下文 7.2% | 可接受，且交接质量高 |
| 假设切换违纪 | 最长连续失败 run = 3（仅 1 例） | 规则执行良好 |
| 跨 attempt 重复 recon | 仅 20 次 | 接力有效 |

---

## 8. 需要标注待验证的事项

1. **f2-05 是否为坏题**：agent 侧证据强（VM handler 载入死代码、blob 线性复杂度
   124/248 无周期），但需向平台方确认。
2. **平凡命令耗时 600s 是否为容器重建卡顿**：f1-01 的 `cat`、a-17 的 `ls` 出现 9–10
   分钟耗时，指向容器回收重建路径，需查运行时日志定性。
3. **`spawn_queue` 早期行缺失**：08:59–11:21 无队列行，与编排者调用 `queue.clear()`
   的时间吻合，判断为预期行为而非数据损坏；开局段调度细节只能从 agents 表侧写重建。

---

## 附录：数据与查询口径

**数据源**

- 主库：`/Users/timmy/aegisx-runs/tsec-full-2026-09-08/aegisx.sqlite`（只读 URI
  `mode=ro`）
- 日志：`/Users/timmy/aegisx-runs/server.log`
- 平台分数接口在任务结束后关闭（`task already finished`），成绩由 `challenge_flags`
  台账重建：66 个计分 flag = 68 accepted − 2 条 b-02 重复提交（message 明示"此前已
  提交"），Σ = 20,650。

**关键口径**

- **真实调度 vs 幽灵**：一个 `queue_item_id` 对应 1 个真实调度；同组内额外的 agent 为
  幽灵重放。注意少数重放意外产出了计分 flag（b-01、c-05、f1-03），应校正回真实侧。
- **`category` 字段是难度**（easy/medium/hard），不是题型；题型需从描述推断。
- **时间戳比较**：库内时间戳用 `T` 分隔（`2026-09-08T12:00:00.000Z`），而 SQLite 的
  `datetime('now')` 返回空格分隔——直接字符串比较会静默失败，需用 `T` 格式的截断值。

**轨迹解析**：`session_entries.data` 为 JSON，
`{message:{role, content[], usage, ...}, type, id, parentId, timestamp}`；
`role='assistant'` 的 `content[]` 内含 `thinking` / `text` / `toolCall`，
`toolCall` 形如 `{type:"toolCall", id, name, arguments}`；`usage` 含
`input/output/cacheRead/reasoning/totalTokens/cost.total`。

**已完成的修复**（本次运行后）

- `9a6efb5` 队列排水器不再重放 done/cancelled 项（幽灵重放根因）
- `c59713b` 修复靶机实例泄漏（三处关联缺陷）+ 多 flag 终判
- 验证：12:26 修复重启后，`start_target` 409 速率从 58.5/h 降至 12.4/h（−79%）

**未完成**

- 本文档提出的 R-1 至 R-8 均为建议，尚未实施。

# 调度者消极收件箱 + 时间可见性

状态：**已被取代（superseded）**——存储层与投递策略已由统一消息层吸收：事件流落事件作用域调度者 DM（channels 表），digest 以 kind=recap 消息存回频道（scheduler_inbox_digests 表已删除）。策略语义（静默计时、紧急 flush、停滞 watchdog、hold）全部保留，见 [im-channels.md](im-channels.md) §三。以下为历史设计文本（供追溯）。

前置：[scheduler-python-sdk.md](scheduler-python-sdk.md)（SDK 收敛后的工具面）；解决 [field-findings.md](field-findings.md) §4（通知风暴）与 §7a（时间可见性）

---

## 一、动机

两场比赛暴露的问题（新代码库现状）：

1. **消息风暴**：每个 run 生命周期事件经 `attachSchedulerWakeup` 裸文本 `lifecycle.send` 直接唤醒调度者——一条事件一轮推理，100+ 题 = 数百次唤醒，每次醒来还要再 snapshot/read 烧一轮。批量启动/批量超时高峰下，连环 steer 打断调度者正在进行的推理与脚本。
2. **时间盲区**：SDK 全程无时间概念——`Run` 只有原始 ISO 字符串（wire 连 `deadlineAt` 都不暴露），没有 elapsed / deadline 剩余 / 活动距今。调度者无法回答"这题跑了多久、快超时了吗"。

**断言**：调度者的唤醒应当是**消极收件箱**——消息只入队，静默等待，直到真正需要它行动时一次性结算。时间信息则由服务端补 raw wire、SDK 侧动态派生，零额外查询。

## 二、消极收件箱

### 2.1 机制

在 `attachSchedulerWakeup`（run-factory.ts）与 `lifecycle.send` 之间插入 per-event 收件箱（新文件 `scheduler-inbox.ts`，纯内存，与 `EventScopeEmitter` 同生命周期）：

- 事件到达 → **只入队**（积累 digest 行数据），不唤醒调度者。
- 计时器从最后一条消息入队起算；新消息刷新计时器。
- flush 触发后组装 digest 一次性 `send`（`deliverAs: "steer"`），清空队列与计时器。

### 2.2 flush 触发器

| 触发器 | 判定 | 说明 |
|---|---|---|
| **紧急事件** | `timedOut`、**队列不足**、**启动失败**、**agent 停滞** | 影响"解题队列正常运行"的事件，立即 flush（捎带已积攒的普通行）。`flagAccepted` **不紧急**——flag 后 run 自行走 finish 流程，无需即时决策 |
| **静默超时** | 距最后一条入队消息 **5 分钟**无新消息 | 风暴高峰时消息持续到达 → 队列一直攒着不 flush（天然抗风暴）；活动平息才结算一轮 |
| 普通事件 | `idle` / `finished` / `started` / `resumed` / `flagAccepted` | 只入队，永不单独触发 |
| 普通通知行 | 队列 pause / resume | 只入 notice 桶，随下一次 flush 投递，不单独触发；manual 来源标 `（用户手动控制）` |
| **完全解出清场** | 平台 accepted / already_solved | 非紧急通知行（`「题」已完全解出：停止 N 个同题 run、终止 K 个同 run solver、取消 M 个排队项`），见 §2.2.1 |
| **部分解出 steer** | 平台 partial（多 flag 未集齐） | 不走 digest——直接 steer 同题所有 agent（含已确认 flag 清单，提交者除外）+ 通知行（见 §2.2.2） |

**agent 停滞（idle >2min）**：任意 agent turn settle 后 arm 该 run 的 2 分钟检查计时器；到点现查——仍有 idle/failed agent 且距今 ≥2min → 紧急行（`⚠ agent 停滞：run-xxxx Solver 1 idle 2m5s`）+ flush。每个 idle 周期触发一次（再次 settle 重新 arm）；fire 时现查 DB，中途 resumed/closed/finishing 由现状裁决（finishing 的 run 不发假紧急），竞态安全。

**队列不足（starved）判定**：pending 计数跨越 **2 → 1** 的边沿（无论因 launch 拉走、remove、失败还是解出取消）。已在 ≤1 时不重复触发；enqueue 补货使计数回到 ≥2 后再次下降会重新触发（边沿触发，非持续打扰）。初始单元素入队、boot 后即 ≤1 的场景因从未跨越边沿而天然不触发。最后一个排队项就是缓冲——调度者收到警告时仍有一项 pending + 刚启动的项在跑，有时间补货。**队列 paused 时静默**（用户主动停止发射，调度者不应被唤醒补货）。

**启动失败**：队列 drainer 的"启动失败 → failed + 通知"（queue.ts 现有的裸 send 通知）并入收件箱紧急级。

#### 2.2.1 完全解出自动清场

平台判定题目完全解出（accepted / already_solved，多 flag 题为全部集齐）时，run 层自动清理同题无效功：

- **同题其他 live run**（≠ 提交 run）→ 制裁 teardown（`summary="同题已完全解出，自动停止""`）：容器终止、队列项 running→done、最后一个 run 关闭时平台 target 自动停（W4.3 既有机制）。
- **提交 run 的其他 running co-solver** → `lifecycle.abort` 立即截断（提交者自己继续 finish_run 写 writeup；被截断的 settle 落 failed，digest 的清场行解释缘由）。平台路径拿不到提交者 agentId 时全部截断。
- **该题 pending 队列项 → cancelled**（根治已解题陈旧项被 drain 重启；后续 re-enqueue 会按 upsert 重置）。取消使 pending 2→1 时 starved 边沿照常触发（语义正确——调度者该补货了）。
- 幂等：兄弟已关则查询自然为空；重复通知（终态缓存命中）重复触发无副作用。
- 手动记 flag（addManualFlag）不触发。

#### 2.2.2 部分解出（多 flag）steer

平台返回 partial（TSecBench 多 flag 题正确但未集齐）时题目**未完全解出**，不能清场：

- 直接 steer 同题所有 live run 的 running agent（提交者除外）：`[多 flag 进度]「题」部分解出（flag 2/3 已确认…）已确认的 flag：…。请专注解出剩余 flag；已确认的无需重复提交。`——竞态求解收敛到剩余 flag 上。
- 收件箱通知行（非紧急）：`部分解出：「题」flag 2/3（run-xxxx）`，调度者随下个 digest 知情。
- flag 层终态缓存：partial 在 `challenge_flags` 存为 accepted（折叠语义），重复提交命中缓存时用 `challenge_remote.solved` 区分完全/部分解出再选 hook。

### 2.3 digest 格式

flush 时服务端组装（静态快照，全部现查 `queries`）：

```
[调度事件摘要 now=14:32:05]
run-a3f1c2 | easy-rop    | started→idle | running 23m | deadline剩7m | 最近活动 40s
run-b9e4d1 | crc-32      | flagAccepted | idle 3m
run-c7d0aa | heap-feng   | timedOut(abort) | closed | 耗时 45m
⚠ 队列不足：仅剩最后 1 项排队
active 8/10 · pending 1
```

- 同 run 多事件合并为一行，事件显示序列（`started→idle`）。
- 每行附带服务端算好的时间：status、已运行、deadline 剩余、最近活动距今。
- 附加标注：最近活动 > 25min 的 active run 标 ⚠（疑似停滞）；deadline 剩余 < 10min 标 ⚠。
- 行上限 20；超出折叠为「…另有 N 个 run 事件」。
- 紧急触发时，紧急行 + 累积行合并同一条 digest（一次唤醒处理全部）。

### 2.4 投递历史与可观测性

- **持久化**：每次 flush 将 digest 原文写入 `scheduler_inbox_digests`（schema v15，append-only，事件删除级联）——完整投递历史，跨调度者运行与重启保留。
- **实时快照**：`GET /api/events/:id/inbox` 返回活收件箱的待结算积压（pending run 行 / 通知 / 紧急行）与计时器状态（静默 flush 倒计时、停滞观察中的 run、投递暂停态）；无活收件箱时 `live:false`。
- **历史查询**：`GET /api/events/:id/inbox/digests?limit&offset`（新→旧，分页）。
- **UI**：调度者 agent dialog 的「收件箱」tab——状态头（运行徽章/静默倒计时/停滞观察/已暂停徽章 + 暂停/恢复投递按钮）+ 待结算积压 + 投递历史（加载更多）。

**投递暂停（hold）**：`POST /api/events/:id/inbox/pause|resume`（仅 HTTP/UI，不暴露给调度者工具——自我静音是危险循环）。语义 = 只静默收集、不投递：调度者保持 idle；一切事件（含 timedOut / 紧急 / 通知）只入桶，不 arm 任何计时器；停滞检查不 arm、fire 时直接返回。恢复时有积压则一次性补投（"这是暂停期间积攒的一切"），并对 live run 中有已 settle agent 的重新 arm 停滞检查（catch-up）。内存态，不持久化（调度者 run 重建即恢复投递）；无活收件箱时 no-op。与 W3 调度者暂停正交：本层管投递，W3 管调度者本体。

### 2.5 投递与配合约束

- **投递用 steer**：streaming 中注入当前轮末尾（不打断正在生成的 token），非 streaming 时开新轮。
- **长轮询警告（prompt 硬约束）**：紧急事件以 steer 注入，若调度者正在跑长时间脚本（sleep 循环、轮询脚本），steer 内容要等脚本返回才能被看到。orchestratorSystem 必须明确警告：**不要写长时间运行的轮询/等待脚本**——事件会送上门，轮询既烧 token 又阻塞紧急通知。
- 生命周期：收件箱挂在 emitter 回调层（`emitRunEvent` 的 paused 丢弃 gate 之后，继承静默语义）；emitter close 时清空队列与计时器，恢复后调度者靠 snapshot re-sync（既有先例）。

## 三、时间可见性

### 3.1 wire（服务端，唯一改动 = 暴露已有数据）

- `RunPublic` 增加 `deadlineAt: string | null`（DB 列已存在，`public.ts` 序列化补一个字段）。detail / fleet / list 响应自动携带。

### 3.2 SDK properties（访问时动态计算，永远新鲜）

```python
run.elapsed_ms           # started_at → now（未启动 → None）
run.deadline_remain_ms   # deadline_at − now（无 deadline / 已结束 → None；负值 = 已超时）
run.overdue              # bool：deadline 已过但 run 仍 active
run.last_activity_age_ms # updated_at → now
agent.idle_age_ms        # updated_at → now

aegisx.fmt_ms(ms)        # 3500 → "3m30s"；-45000 → "-45s(超时)"；digest 与模型打印共用
```

- 容器钟与宿主机共享内核时钟，epoch 差值可靠；property 每次访问重算，比服务端快照派生值更新鲜。
- 全部毫秒整数。docstring 明确约定：**用整数差值做判断，不要 parse ISO 字符串**（消时区 / naive-aware 坑）；展示才用 `fmt_ms`。
- digest 文本头部带服务端 `now`。

### 3.3 不做的

- 比赛窗口（startsAt / endsAt）、心跳兜底——本轮不做。理由：硬 deadline 超时保证任何卡死 run 最终必然产生 `timedOut` → 入队 → 紧急 flush，"全部卡死"的静默窗口已有上界，心跳非必需。

## 四、服务端改动清单

1. **新增 `run/scheduler-inbox.ts`**：per-event 收件箱——行积累、事件分级（紧急/普通）、静默计时器（5min）、flush 时组装 digest 文本（含时间列、⚠ 标注、20 行上限、active/pending 统计行）、`send(steer)` 投递。
2. **`run-factory.ts`**：`attachSchedulerWakeup` 的 6 个回调改为投递收件箱（不再直接 send）；emitter close（run close/恢复重建）时收件箱清理。
3. **`run/queue.ts`**：launch/remove/fail 后 pending 计数 2→1 边沿检测 → 紧急"队列不足"行；启动失败通知并入收件箱紧急级（替换现有裸 send）。
4. **`run/public.ts`**：`RunPublic.deadlineAt` 序列化。
5. **SDK `models.py`**：`Run.deadline_at` 字段 + `elapsed_ms` / `deadline_remain_ms` / `overdue` / `last_activity_age_ms` properties；`AgentSummary.idle_age_ms`；`fmt_ms`。
6. **`orchestration/prompt-defaults.ts`**：`orchestratorSystem` 的 "Wake-up model" 一节重写——消极收件箱模型（被唤醒即有事、digest 行格式、紧急事件清单）、**勿长轮询警告**；旧正文进 LEGACY 常量链（`upgradeBuiltinTemplate` 刷新，用户编辑保留）。
7. 测试：收件箱（聚合/紧急 flush/静默 flush/边沿触发/paused 静默/close 清理）、`deadlineAt` wire、SDK 时间 properties、模板刷新。

## 五、明确不做 / 推迟

| 项 | 理由 |
|---|---|
| 心跳 digest、stall watchdog | timedOut → 紧急 flush 已覆盖全卡死场景 |
| 比赛窗口 startsAt/endsAt | 未拍板，推迟 |
| 调度者代际轮换、read 增量（after_seq/types） | digest 降轮次后压力大减，推迟 |
| wind-down 围栏、/shared、category playbook | field-findings P1 批次，另行实施 |

## 六、实施阶段

| Phase | 内容 | 验证 |
|---|---|---|
| **P1 收件箱** | scheduler-inbox.ts + wakeup 接线 + queue 边沿/失败并入 + digest 文本 | 单元测试：普通事件只入队、静默 5min flush、紧急立即 flush（捎带累积行）、2→1 边沿仅一次、paused 静默、close 清理 |
| **P2 时间信息** | RunPublic.deadlineAt + SDK properties + fmt_ms | wire 测试；容器内 `run.deadline_remain_ms` 断言正确 |
| **P3 prompt + 全绿** | orchestratorSystem 重写（收件箱模型 + 勿长轮询）+ LEGACY 链 + 模板刷新测试 | `bun run check` / `bun run test` / `bun run build` |

## 七、已定决策记录

1. 消极收件箱：消息只入队，静默 5 分钟无新消息才 flush；调度者其余时间静默（用户拍板）。
2. 紧急 = 影响"解题队列正常运行"：`timedOut`、队列不足、启动失败，立即 flush。`flagAccepted` 不紧急（用户纠正：flag 后 run 自行结束，无需即时决策）。
3. 队列不足 = pending 计数 2→1 边沿（用户定义：只剩最后一个排队时警告，留缓冲）。
4. 投递统一 steer（用户拍板）。
5. prompt 明确警告调度者勿用长时间轮询脚本——会阻塞紧急事件的 steer 注入（用户拍板）。
6. 静默 5min、行上限 20、stall 25min、deadline 临近 10min（默认常量，不做配置面）。
7. SDK 时间信息以毫秒整数 property 动态派生；服务端只补 raw wire（`deadlineAt`）。

# 真实赛事复盘：编排层暴露的九个问题与改进方向

状态：**记录，未实施**（2025-08，几场真实赛事后的复盘结论）
关系：这些改进将在编排简化重构（[orchestration-v9-simplify.md](orchestration-v9-simplify.md)）之后按 §11 的优先级落地。
已解决：§0 的 params 静默丢弃 bug 随 v9 删除 `orchestration/params` 概念而消灭；§1「启动时选模型」已由 v9 结构性解决（入队输入原生携带模型）；§4（通知风暴）与 §7a（时间可见性）已有设计稿 [scheduler-inbox.md](scheduler-inbox.md)（待实施）。

---

## 0. 复盘中发现的一个实际 bug

`enqueue_run` / `start_run` 工具声明了 `params` 参数（描述称用于「requires model params」的编排），但启动链路把它丢弃了：

- `service.ts` 的 drainer `launch` 回调只透传 `challengeId / orchestration / prompt / timeoutMs / source / queueItemId`；
- `scheduler-admin.ts` 的 `resolveAndCreate` 同样不接收 `params`；
- `run_queue.params` 列存了值但 drainer 从不读它。

即调度者按提示词传 params 时被静默忽略。v9 简化后 `orchestration/params` 概念整体消失，此 bug 随之消灭；若 v9 前需要热修，应在 `resolveAndCreate` 补 `slotModelOverrides` 透传。

---

## 1. 启动时无法选择模型

**现象**：只能在启动后中断、切模型、再继续。手动入队 UI、HTTP body、`run_queue` 行、调度者工具全都没有模型入口，尽管底层 `CreateRunInput.slotModelOverrides` 机制已存在（仅调度者自身启动在用）。

**方向**：

- 手动侧：入队请求携带模型（canonical ref，入队时校验可解析），launch 链路透传为 per-slot 覆盖；UI 弹窗加模型选择器。多 slot 插件做「高级」按 slot 展开。
- 调度者侧：不指望 LLM 每次正确传参。`scheduler_config`（或全局设置 + event 覆盖）增加 modelPolicy：`{ default, byCategory: { pwn: …, misc: … } }`，drainer 拉起时**服务端**按 challenge.category 套用（确定性、零 LLM 判断）；`enqueue_run`/`start_run` 的显式 `model` 参数作为覆盖（校验失败时错误里回显合法模型列表）；把模型目录（含能力标注：视觉/廉价/强推理）注入 orchestrator 提示词，教它何时偏离默认。

## 2. pwn 环境方法论提示

**现象**：本地是 macOS/ARM 下模拟的 linux x86，与远程靶机细节不一致（glibc/ASLR/内核行为），解题者浪费额外时间处理环境问题。

**方向**：做成**数据而非代码**：

- `prompt_templates` 增加 `hint:<category>` 键空间（builtin 组，现有模板编辑 UI 直接可用），seed 一份 pwn 默认文案（优先探测远程、以靶机为准、本地只做静态与脚本开发、远程 libc 获取等，措辞赛后沉淀）。
- run 创建时把渲染后的 hint 写成 `/workspace/PLAYBOOK-<category>.md`（`copyAttachments` 旁加一步），initial 模板加一行指引。
- 写文件而非只进 prompt 的理由：initial 会被压缩掉而文件可反复引用；可被赛后修订；可被知识共享通道（§3）复用。

## 3. 知识共享：共享什么、怎么共享

> **已由统一消息层覆盖**（[im-channels.md](im-channels.md)）：共享 FS/post_note 方案未实施即被频道化 IM 取代——findings/死路广播走 #team，跨 run 工件流转走「调度者读 /runs:ro + 摘要附件转发 DM」模式，`/shared` 层取消（设计 §八）。

**共享什么**（按价值排序）：

1. 环境/方法论知识（§2 的产物）——一次踩坑全员受益，event 级共享。
2. 失败与 handoff（HANDOFF/FAILURE 文档）——避免重试重复死路（依赖 §8 的 wind-down 先存在）。
3. 可复用中间产物——libc 版本/偏移、gadget、加密参数、系列题公共原语。
4. 解题叙事（WRITEUP）——给调度者做策略参考与跨题模式识别。

**怎么共享**：第一版**不做 IM/消息总线**（跨 run 寻址触发冷恢复、投递语义复杂），用**共享文件系统层 + 轻量工具**：

- 每个容器多挂一个 bind：`data/events/<eventId>/shared → /shared`（`createToolboxContainer` 的 binds 加一项）；challenge 级子目录 `/shared/challenges/<challengeId>/` 存该题 HANDOFF/WRITEUP——同题重试的新 run 天然看到旧 handoff。
- solver 增加 `post_note(title, body, tags?)` 原生工具：追加结构化条目（时间/runId/challenge 自动署名）到 `/shared/notes.md`。署名是信任边界的一部分；消费方提示词继续把共享内容当不可信数据。
- 调度者增加 `read_run_file(runId, path)` 工具（host 侧读、限本 event、限 runDir 根）——补上「调度者完全看不到解题者工作区」这个硬缺口。
- 初始提示词告知 `/shared` 存在与「先读同题 prior attempts」。

## 4. 100+ Run 的通知风暴与调度者上下文

**现象**：每个 run 生命周期事件都 `orch.send()` 一条裸文本；100+ 题 = 400+ 条通知，每条唤醒一轮，每轮再 n 次 `read_run`——token 与上下文双重爆炸。调度者单上下文也装不下全部题目状态。

**方向**（三层防线，前两层便宜）：

1. **通知 digest 聚合**：服务端 debounce 聚合器（窗口 60–120s，倾向 90s；flagAccepted/timedOut 立即 flush）。digest 每个受影响 run 一行：id、题名、事件、状态、已运行时长、距 deadline、轮数、token、最近一条 assistant 摘录（300–500 字）、最近活动距今——直接消灭大多数 read_run 往返（在通知里携带最近消息的直觉是对的）。同 run 连续事件合并；digest 总量设上限（超出折叠为计数）。
2. **外部化状态硬化**：orchestratorSystem 把「维护 STATE.md（固定 schema：solved/failed/in-progress/优先级/教训）」从建议变成硬要求；队列本身就是持久化计划。压缩后恢复有据可依。
3. **代际轮换**：复用 v12 per-agent 多 session 原语（`createAgentSession`/`activateAgentSession`）作为 generation 机制——同一 scheduler run、同一 workspace，新 session = 干净上下文。加 `rotate_scheduler`（HTTP + 工具）：先要求写 HANDOFF.md，再建新 session 并用「读 HANDOFF.md + STATE.md + list_queue 后继续」prime。优于删库重建（丢 workspace）与压缩（有损）。可后续接 context 使用率 >80% 自动触发（`computeContextSample` 已提供 percent）。

## 5. 批量状态查看（n 次 read_run 太浪费）

**方向**：`board` 工具——一次调用返回紧凑定宽行：`<runId前8> <status> <已运行> <剩余> <轮数> <最近活动age> <题名> | <最后assistant截160字>`，外加 caps、queue 头部、`now`。过滤器：`status`（默认 active）、`challenge_id`、`min_idle_ms`、`limit`、排序键。100 活跃 run 约 5–8K token；默认只列 active。`read_run` 保留做深读（配 §6 参数化），可顺手支持 `read_runs(ids[])` 批量 2–5 个。**不做**程序化查询语言（jq-ish）——board + 过滤器覆盖 95% 场景。

## 6. read_run 只能看到最后一条 assistant，不自由

**方向**：参数化（数据全在 `session_entries`，含 meta 时长）：

```
read_run(run_id, agent_id?=entry, after_seq?|last_n?=10,
         types?=[user,assistant,tool,toolResult,thinking], max_chars?=20000)
```

- 返回带 `seq` 的条目列表（天然支持 `after_seq` 增量轮询）+ 头部状态块（status/elapsed/deadline 剩余/轮数/token/lastEntryAt）。
- tool/toolResult 渲染摘要（工具名 + 参数首行 + 结果头 N 字符）；assistant/thinking 给正文；逐条与总量双重字符预算。
- 实现：扩展 `queries.listMessages`（type 过滤 + limit），复用 `listRenderableEntries`。

## 7. 调度者没有时间观念

**现象**：看不到运行中 Run 花了多久；全部卡死时只能静默等超时。

**方向**（两个子问题分开）：

- **时间可见性（便宜，先做）**：LLM 不知道现在几点——所有调度者工具结果统一附带 `now`（ISO）+ 服务端算好的 `elapsedMs`/`deadlineRemainMs`/`lastActivityAgeMs`（board/list_runs/read_run/digest 全带）。
- **卡死检测**：agents 行加 `lastEntryAt`（pipeline commitEntry 顺手更新）；服务端监控 running agent 且 `lastEntryAt` 距今 > 阈值（默认 20–30min，可配；注意长编译/大字典跑批误报）→ 经 §4 notifier 发「疑似停滞」digest（事件驱动，不烧 token）。兜底心跳：每 `scheduler.heartbeatMs`（默认 15–30min，可关）发一次极简 digest（= board 摘要，几百 token），仅当存在 active run 时发——保证「全部卡死」的静默窗口有上界。deadline 临近（<10min）在 digest 里标注（带上下文的 halfway 替代品）。

## 8. 卡死兜底：wind-down 围栏

**现象**：解题者卡死无可靠超时兜底；现设计到点硬 abort，解题者没有沉淀机会。

**方向**：两阶段 deadline（完全在 run 内，不依赖调度者，手动管理同样生效）：

- `armRunTimers` 增加预警定时器：`deadline - windDownMs`（默认 `max(5min, timeout*10%)`，可配）时对每个 streaming agent **steer** 收尾指令：「硬超时还剩 X 分钟。立即停止新探索，把尝试/证据/失败/下一步写入 HANDOFF.md（Attempts/Evidence/Blockers/Next 结构），给出当前最佳结论后结束本轮。」
- 硬超时行为不变（abort → grace → SIGKILL），但 wind-down 触发后把 grace 拉长（如 120s）。
- HANDOFF.md 落到 §3 的 `/shared/challenges/<id>/`，与重试/知识共享闭环。
- 补充（可选，后做）：轮数上限（cap-1 注入同样收尾指令，到 cap 强制 settle，防快速空转型 runaway）；`autoCloseIdleMs`（idle 无 flag 超 N 分钟自动 close 释放槽，默认关）。

## 9. 调度者/解题者之间、解题者之间的文件传递与通信

> **已由统一消息层覆盖**（[im-channels.md](im-channels.md)）：`ask_scheduler` 落地为 SDK `aegisx.ask(text, urgent)`（落调度者 DM，digest 分级投递）；文件传递落地为频道附件（📎 元数据 + `aegisx.channels.fetch` 物化）；跨 run messaging 部分由「调度者中转」模式覆盖，agent-to-agent 总线仍不做。

**方向**：第一版用 §3 的共享 FS + `post_note` + `read_run_file`，**不做跨 run 消息总线**。补一个高性价比小件：solver → scheduler 异步问询 `ask_scheduler(question)`（写一条 `@scheduler` 标记的 note 并唤醒调度者，digest 带上）——解决「靶机快到期了，延长还是放弃」这类决策上移场景。真正的跨 run agent-to-agent messaging 等 §11 的 P0–P2 落地后再评估。

---

## 10. 现状设计检查结论（问题 4 的后半）

- 调度者上下文：压缩已开（`agent.compactionEnabled` 对 scheduler 生效）；队列=持久化计划的设计正确；缺的是 digest 聚合、STATE.md 硬要求、generation 轮换三件（§4）。
- 状态更新流程：逐事件裸文本 send 是根源，改造点集中在 scheduler 唤醒层（v9 后为内建唤醒模块，单一改动点）。

## 11. 建议落地顺序（在 v9 简化重构之后）

| 批次 | 内容 | 来源 |
|---|---|---|
| **P0** | 通知 digest+聚合、board 工具、工具结果统一时间戳、read_run 参数化、（启动选模型已由 v9 结构性解决） | §4 §5 §6 §7a §1 |
| **P1** | wind-down 围栏、共享目录 + post_note + read_run_file + ask_scheduler、scheduler modelPolicy、category playbook | §8 §3 §9 §1 §2 |
| **P2** | stall watchdog + 心跳、scheduler 代际轮换、轮数上限、autoCloseIdle | §7b §4c §8 |

## 12. 待拍板（实施前确认）

1. digest 聚合窗口默认值（倾向 90s，flagAccepted 即时 flush）。
2. modelPolicy 放全局设置 + event 覆盖（倾向，跨赛事复用）还是仅 scheduler_config。
3. `/shared` 读写权限：全读写 + 署名约定（倾向，单兵本地）vs run 子目录写 + 根只读。
4. solver 间共享是否包含中间产物大文件（倾向：是，靠约定目录名防冲突）。

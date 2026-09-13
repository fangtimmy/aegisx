# 沙箱生命周期对齐（D）与自有会话模型（E）

日期：2026-09-13 · 状态：**设计提案（未实施）** · 范围：每 agent 一次性沙箱 / 凭证面收紧 / 自有会话 schema / pi 适配层

本文只做设计与取舍记录，不改动任何代码。现状结论带 `文件:行号` 实证。标注 **【已定】** 的是方向性决策，**【建议】** 的仍是开放项。控制平面（A/B/C）的设计与实施见 [control-plane-design-2026-09-13.md](control-plane-design-2026-09-13.md)；本文是其 §1 遗留的 D、E 两项。

## 0. 现状与根因

### 0.1 D 侧：容器按题、身份按 exec、凭证永久

- **容器按 workspace key 共享**：每题一个 `aegisx-ws-<id8>`（调度者一个 `aegisx-orch-<eventId8>`，`workspace-resolver.ts:61-68`），由 `agent-factory.ts` 的 `ensureContainerFor` 经 `container-lifecycle.ts` 惰性创建（registry + 单飞构建 + 每 60s idle sweep + 10min TTL + SIGTERM→SIGKILL 10s 宽限）。一题的 N 个 agent 共享一个容器，因此：
  - **身份注入只能 per-exec**：`sdkExecEnv(agentId, row.token)`（`env-contract.ts:33-38`）随每次 bash exec 注入 `AEGISX_AGENT_ID` + `AEGISX_TOKEN`（`agent-factory.ts:865` → `bash-tool.ts:300-306` → `container-manager.ts` exec `Env`）。
  - **凭证是永久的**：`agents.token`（64 hex，spawn 生成，`agent-factory.ts:589`）持久落库（唯一偏索引 `db/schema.ts:224-226`），全仓消费方仅两处——`agent-auth.ts:183` 的 bearer 反查与上述 exec 注入。一个被 prompt injection 攻陷的 solver 可以 `env`/`/proc/*/environ` 直接拿走这个**永久有效**的凭据；`docker inspect` 亦可见。
- **生命周期与 agent 生命错位**的补偿机制：idle sweep、容器引用计数（`container-lifecycle.ts` registry + building 单飞）、aborted agent 目录回收（`service.ts` `onAgentTerminal` 的 `rmSync`）、boot 孤儿容器只能靠 create 的 remove-first 兜底（`container-lifecycle.ts:147-153` 自认无法枚举）。
- 资源回收语义靠注释维持：「the shared container is NEVER killed」（`service.ts`、`agent-runtime.ts` 多处）——超时/中止路径必须刻意绕开容器。

### 0.2 E 侧：pi 的序列化格式是数据层契约

- `session_entries.data` 逐字节存 pi 的 `SessionEntry` JSON（`db-session-manager.ts:230`）；`DbSessionManager`（522 行）自建内存树镜像 pi 的 SessionManager 面，以 `as unknown as SessionManager` 跨越私有类型边界（`host-session.ts:98-103`，结构等价靠 parity 测试运行时锁定）。
- 代价三处：usage 统计要在 JSON blob 上跑 JSON1（`session-queries.ts:30-101` 的 `json_extract` + JS 侧 fold 对齐，`entry-usage.ts`）；context 采样要增量 accumulator 绕开 O(n) 重读（`event-pipeline.ts:93-120`）；pi 升级 = 全链路回归（entry shape、manager 面、桥接点三处同时受影响）。
- wire 契约也被绑架：`apps/shared/agent.ts:80-86` 直接 `import type { SessionEntry } from "@earendil-works/pi-coding-agent"` 并 re-export——web 消费的消息条目 shape 是 pi 说了算（type-only，无 runtime 依赖，但 shape 所有权在 pi）。
- 一个既有语义盲点顺带暴露：pi 的 `branch()` 只改内存 `leafId`（`db-session-manager.ts:465-470`），`load()` 恢复时 leaf = 最后一行——分支后若无后续 append，重启即丢分支（server 侧 backtrack 是物理尾删 + 重 prepare，`agent-session-ops.ts:221-271`，不走 `branch()`；该入口仅 pi 内部可达，但 activeLeaf 持久化仍应补上，见 §2.2）。

## 1. D — 沙箱生命周期 = agent 生命周期

### 1.1 目标形态【已定】

每 agent 一个一次性容器：prepare 时创建，`settle`（唯一终态路径）时销毁。共享的只有卷：

```
aegisx-agent-<id8>            每 agent 一次性容器（AutoRemove 已开，kill 即没）
  ├─ bind: <challenge>/workspace:/workspace     题级共享（现状不变）
  ├─ volume: aegisx-ch-cache-<challengeId>      题级工具缓存卷（新）
  └─ container ephemeral layer + /tmp tmpfs     agent 私有（每 agent 独立 /tmp）
调度者：aegisx-orch-<eventId8>，1:1 机制同上（per-event 名字保留）
```

- **idle 仍保温**：容器随 agent 存活，idle agent 的容器、会话、工作区都在——保温语义无回归。变的是终态：completed/aborted/failed 即销毁，无 TTL、无 sweep。
- **销毁 = 一次 `remove(force)`**【已定，无宽限定时器】：pid1 是 `sleep infinity`（`container-manager.ts:216`），SIGTERM 即死、无状态可冲刷（工作区是 bind mount，落盘即时）；AutoRemove 兜底清尸。不带 SIGTERM→SIGKILL 宽限——宽限定时器在 close→reopen 交错下会误杀同名的全新容器（今天的 lifecycle 靠 `ensureContainer` 里的 `clearForceKill` 拆弹，`container-lifecycle.ts:100`；一次性沙箱不值得继承这套机制）。
- **boot 孤儿清理变精确**：名字含 agent id8，孤儿 = 按前缀枚举 − 存活 agent 集合，确定性清除，替换今天的 remove-first 碰运气。

### 1.2 消失与保留清单【已定】

| 消失 | 保留（原因） |
|---|---|
| `container-lifecycle` 的 idle sweep + TTL | aborted agent 目录回收（`agents/<id8>` 在共享卷上，卷活得比容器久，目录卫生问题不变——D 消除的是**容器**回收，不是卷上目录回收） |
| 容器引用计数与 building 单飞（name 即引用）；SIGTERM→SIGKILL 宽限（销毁 = 一次 remove(force)，见 §1.1） | limits / CapAdd(NET_RAW,SETFCAP) / no-new-privileges / networkMode / tmpfs（安全面不动） |
| per-exec 身份注入的 token（→ §1.3 铸造短时凭据；`AEGISX_AGENT_ID` 仍随 exec 注入，`execEnv` 变 per-exec 提供者） | workspace/backend 与 bash-tool 的容器操作面（读 cat / 写 putArchive / exec capture——containerName 从 workspace key 换成 agent 名，调用面不变） |
| 「共享容器永不杀」不变量（翻转：终态即杀，正是目标） | scheduler 的 `/challenges:ro` 只读挂载（`agent-factory.ts:103-115`） |

行为面新增两条显式变化：**每 agent 独立 `/tmp`**（今天同题 N agent 共享容器 /tmp tmpfs——依赖它做跨 agent 临时交换的协作会静默失效，协作面是 `/workspace/shared`，提示词已如此引导）；**`execEnv` 从 prepare 时快照变为 per-exec 提供者**（见 §1.3）。

`workspaceInfoOf.containerRunning`（`service.ts`）从 registry 读改为 per-agent 运行时知识（runtime 知道自己容器的存活；fleet 轮询容忍陈旧，语义同今天）。

### 1.3 凭证面收紧：短时铸造凭据【已定】，socket 代理【否决】

- **铸造**：宿主持一把 per-boot HMAC secret（模块级单例，`createApp` 与进程内夹具同源可达——`sdk-contract.ts:39-42` 今天就自铸 token 直插 agents 行，`schema-indexes` 测试断言 token 索引，两者随 D 一并迁移）。exec 时铸造 `{agentId, exp}` 签名 token（TTL = 2× exec 硬上限 = 1h，覆盖 1800s bash 上限 + 余量，`bash-tool.ts:36`）。`agent-auth` 验签 + 查 agents 行还原 Principal——**无状态、无 DB 写、无吊销表**；进程重启 = 旧 token 全灭（exec 本就是运行时现象，无损）。
- **`execEnv` 必须从快照变提供者**【已定，关键接线】：今天 `sdkExecEnv(agentId, row.token)` 在 prepare 时一次成型（`agent-factory.ts:865` → `host.ts:46` → `bash-tool.ts:304`）——若照搬，idle 超过 1h 的保温 agent 醒来后每次 bash 都拿过期 token，静默 401 到终态。改为 `execEnv: () => string[]`（`bash-tool` / `workspace-backend` / `local-manager` 的 exec 入口在调用时刻铸造），TTL 语义才是「每次调用 1h」。寿命上界随之覆盖**从 exec 派生的一切进程**：`nohup ... &` 的后台进程继承 exec env，其 SDK 调用在铸造 1h 后失败——上界适用的是进程树，不是单次 bash 调用，且容器随 settle 销毁再兜一层。
- **`agents.token` 列整体废除**（基线 v25）：长时凭据不复存在，被 injection 拿走的东西寿命 ≤ 1h 且作用域不变（仍是该 agent 自己的面）。连锁清理：唯一偏索引、`newAgentToken`、`agent.spawned` 的 `projectorInput.agentToken` 旁路（A2 的 carve-out 反向拆除——投影重建也不再涉及凭据）、`sdkExecEnv` 的 token 参数改为传入铸造结果。
- **SDK 与 GUIDE 零改动**：仍读 `AEGISX_TOKEN` env（`client.py` 不动）；`docs/env.md` 的 AEGISX_TOKEN 语义行更新为「短时铸造，随 exec 注入」。
- **契约与测试**：`sdk-contract.ts` 等进程内夹具改用导出的 mint 助手；`agent-auth` 测试补验签/过期/跨 agent 拒绝。
- **否决 socket 转发代理**：per-agent unix socket 需要经卷把 socket 递进容器 + 宿主侧常驻代理进程；Docker Desktop（macOS）对 bind-mount socket 的转发不可靠，且多出一个常驻组件。铸造凭据用 1/10 的机制买到同等「容器内无长时凭据」，跨平台。

### 1.4 启动开销与题级缓存卷

- 开销实测量级：同镜像 create+start 亚秒级到 ~2s；drainer 的 launch 本就串行且逐个 prepare，全局并发上限（`maxConcurrentAgents`）天然界定容器总数。**内存上限语义改变**：今天 N agent 共享一个 `container.memoryMb`（默认 2048MB）cgroup；D 之后每个容器各自带同一上限，最坏占用 = 存活 agent 数 × memoryMb（默认 4 × 2048MB = 8GB，上限 32 agent 时可达 64GB）——容量规划改为按 `maxConcurrentAgents × memoryMb` 计，或调低 per-agent 默认（实施时决定，两者取一，见 §4）。多 agent 同题并发 spawn 从「N 个等 1 容器」变「N 个并行 create」，总时延不升。
- **缓存卷**（新）：`aegisx-ch-cache-<challengeId>` named volume，挂载 `/var/cache/apt/archives` + `/opt/aegisx-cache`（镜像内烘焙 env 把 `PIP_CACHE_DIR`、`GOFLAGS`/GOMODCACHE 等指到后者——约定属镜像层，server 零配置）。效果：同题 N 个 agent 与反复重派的安装去重，这是「预热」的主体。并发注意：已落盘的 .deb 不可变、pip/go 缓生来容忍并发，唯一竞态是并发下载的 `partial/` 目录（apt 锁 per-container）——偶发损坏，重试即愈，不设机制；named volume 首次挂载会拷贝镜像在该挂载点的内容（bind 不会），对 apt archives 目录无遮蔽问题。
- **预热钩子【建议，二期】**：镜像可选提供 `/opt/solver/prewarm.sh`；赛事拉题时 server 起一个一次性容器（同镜像 + 缓存卷）跑它，fire-and-forget、失败仅日志。离线 appliance 镜像的 prewarm 是 no-op。不做成可配置项。

### 1.5 local 执行后端（allinone）

`local-manager.ts` 的进程组模型已是 per-workspace 跟踪（`ws.procs`）——对齐动作小：sandbox 生命周期 = 进程组随 settle 终结（已有跟踪，补终态收割）；凭证同样走铸造（本进程命名空间内 env 注入）；缓存 = 宿主目录。题间隔离消失是 allinone 的既定取舍，不变。

### 1.6 与 B 的事件面

不新增事件类型：spawn/terminated 事实已蕴含沙箱始末；boot 孤儿清扫走结构化日志。若实施中发现需要「容器创建失败」的可观测点，`launch_failed` 通知已覆盖。

## 2. E — 自有会话模型，pi 降级为可替换实现

### 2.1 关键机制：包裹真实实例 + 批量装载重放【已定】

仓库实际依赖是 pi **0.85.1**（根 `package.json` catalog；0.83.0 的 dist 副本是陈旧残留，勿据）。该版本两件事支撑本设计：

其一，`SessionManager` 的字段全部公有（无 `private`），子类化即可——适配器**包裹/继承真实实例**而非伪造，`as unknown as SessionManager` 自然消失。

其二，`SessionManager.inMemory(cwd, options, entries)` 有第三个 `entries` 参数（「optionally from entries held outside the filesystem」，dist ~:1254，`_loadEntries`/`_buildIndex` 保留原 entry id 并把 leaf 置于最后一条）——这是**批量装载**入口，重放机制由它承担：

```
pi-session-adapter.ts   extends/wraps SessionManager.inMemory()
  ├─ 写：override append*/branch/branchWithSummary/resetLeaf
  │      → 调 super（pi 语义：id 生成、树更新）→ 把落定 entry 转成 canonical 行写库
  │      → onAppend / metaProvider / close() 钩子原位保留（管线接线不变，见下）
  ├─ 读：pi 侧全走 inMemory 实例（树/上下文/compaction 语义 = pi 本尊）
  └─ resume：store 行按 seq 转 canonical → 反向转换为 pi entries →
            inMemory(cwd, {id: sessionId}, entries) 一次装载 + branch 到 activeLeaf
```

- **重放必须走批量装载，禁止逐条 append 重演**：append 会重新生成 id/parentId/timestamp，重放出的内存树父链引用从未持久化的 id，`buildSessionContext` 走父链会在第一个缺口处静默截断历史。`entries` 装载保 id 原样，是唯一正确的路径。
- `as unknown as SessionManager` 消失：适配器 is-a 真 SessionManager。
- `DbSessionManager` 的 522 行内存树/byId/labelFor 全删——那是 pi 内存管理器已有的东西的仿制品。
- **close() 语义必须复刻**：`host-session.ts:220-227` 依赖 manager close 后 append 抛错，防 dispose 后的迟到 `message_end` 分叉会话树（`UNIQUE(session_id, seq)` 是最后防线）。适配器保留同一守卫——迟到写要么抛、要么丢弃于已废弃的内存实例，两态都要显式声明，不能靠巧合。
- 现有 parity 测试（db-session-manager.test 对拍 inMemory）反向利用：变成**重放 parity 测试**——store → 批量装载 → 与原会话对拍，锁适配器双向转换无损。

### 2.2 自有 schema（基线 v26）【已定】

```sql
-- session_entries v2（body 取代 data；一等列取代 JSON 路径）
CREATE TABLE session_entries (
  id TEXT PRIMARY KEY,            -- pi entry id（装载保真）
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  parent_id TEXT,                 -- 一等（既有）
  type TEXT NOT NULL,             -- canonical kind（既有列，语义收归自有）
  role TEXT,                      -- 一等（新）：user|assistant|toolResult，非 message 为 NULL
  tool_name TEXT,                 -- 一等（新）：toolResult 行的工具名（events/stats 的逐工具统计 SQL 化）
  created_at TEXT NOT NULL,       -- entry timestamp（一等化）
  -- usage 一等列（message=assistant/toolResult 与 compaction/branch_summary 直接可加）
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  reasoning_tokens INTEGER, cost REAL,
  meta TEXT,                      -- timing（既有）
  body TEXT NOT NULL              -- canonical JSON envelope（自有 shape，非 pi jsonl）
);
-- sessions + active_leaf_id TEXT   分支位置持久化（§0.2 的语义盲点）
```

- **canonical envelope**：`{kind, ...payload}`，kind 与 pi entry type 对应但由我们声明（注册表校验，同 domain-events 手法）；未知 kind 原样存——pi 加新 entry 类型时适配器 default 分支保底往返。
- 索引：`(session_id, seq)` 唯一、`(agent_id, seq)`、`(session_id, type)`（沿用现形状；低基数单列 `(type)` 无增值）。usage 列不建索引（聚合全表 SUM，量级无压力）。
- `challenges.required_flags` 式的写者纪律同样适用：body 只由适配器写。

### 2.3 SQL 化【已定】

- `usageTotalsSql` 从 JSON1 `json_extract`（`session-queries.ts:30-101`）变成 `SUM(input_tokens) ...` 平凡聚合；`turns` = `COUNT(role='assistant')`；cacheHitRate = 最近一条 **prompt > 0** 的 assistant 行的 `cache_read/(input+cache_read+cache_write)` 子查询（`entry-usage.ts:108-114` 的 JS fold 只在 prompt>0 时覆写——SQL 必须带同一守卫，否则口径漂移）。`entry-usage.ts` 的 JS fold 保留给进程内实时采样（event-pipeline 的 SessionUsageSample），两者口径同源于列定义——JSON 对齐测试退役。
- `listRenderableEntries` 的过滤走 `type` 列（RENDERABLE_TYPES 集合 → SQL IN），body 只在构造 wire item 时解析一次。
- **`events/stats.ts` 是第三个 JSON1 消费方，必须同批迁移**：它经 `usageField`/`roleField` 汇总 usage/turns，并 `json_extract('$.message.toolName')` 做逐工具分解（`stats.ts:30,48-51,77-78,564-573`）——`tool_name` 一等列（§2.2）让它归入平凡 SQL。`session-queries.ts:26-29` 导出的 `usageField`/`roleField` 助手随之退役。

### 2.4 wire 契约所有权收回【已定】

- `apps/shared/agent.ts` 的 pi type-only import / re-export（`:80-86`；`EntryItem` 在 `:102-110`）替换为 shared 自有的 `SessionEntryView`（结构上与今天 web 消费的 shape 相同——**一次性收编，不是 shape 变更**），`EntryItem.entry: SessionEntryView`。
- web 的 timeline / tool-render / conversation-store 消费约 5 个文件、~22 处 `entry.type` / `entry.message` 访问，结构不变、类型名更换；server 侧映射点两处：`session-queries.ts`（历史回放）与 `event-pipeline.ts`（draft/committed 交换，`entryKeyOf` 不变）。
- 从此 pi 的 shape 变更撞到的是适配器的转换函数，不是 shared 的 wire 类型。

### 2.5 爆炸半径验收标准

pi 升级时允许触碰的文件清单：`pi-session-adapter.ts` + parity/重放测试 + （仅当 entry kind 增删时）canonical 注册表与 `SessionEntryView`。其余——service / runtime / 管线 / queries / web——不应出现在 diff 里。这是 E 的验收定义，不是愿景。

### 2.6 明确不做

不改 compaction / 分支语义（pi 本尊提供）；不做会话清理（既有决定）；不把 session_entries 并入 domain_events（量级不配，control-plane §2.1 已划界）；SSE / 流层不动（LiveEvent 的 message 载荷本就经管线映射）。

## 3. 实施顺序【建议】

D 与 E 的文件面仅相交于 `schema.ts` 与 `agent-factory.ts`（token 铸造），分批串行、各自基线：

1. **B1 · D 沙箱**（含短时凭据铸造 + `agents.token` 废除，基线 v25）：container-manager 增 per-agent create/destroy（remove(force) 单发）助手 → settle 接销毁 → agent-factory 改名与挂载 → `execEnv` 变 per-exec 提供者（bash-tool / host / local-manager 签名）→ 铸造 + agent-auth 验签（secret 模块级单例）→ local-manager 对齐 → boot 孤儿清扫 → 测试迁移（sdk-contract 种子改铸造、schema-indexes token 索引测试、超时/中止/删除路径的容器回收、验签矩阵、close→reopen 交错、重派重开）。
2. **B2 · E store + adapter**（基线 v26）：canonical 注册表 + store → adapter 继承 inMemory（批量装载重放）→ 重放 parity 测试 → DbSessionManager 删除 → usage/turns/toolName SQL 列化（`session-queries` + `events/stats.ts` 同批）→ 夹具重写（sdk-contract 与 usage / stats / scheduler-digest / messages-cursor / service-sessions 五个测试文件的 `data` 种子改 canonical body）。
3. **B3 · E wire 收编**：shared `SessionEntryView` → 两个映射点切 canonical → web 类型改名（~5 文件）→ 全链路 `test:all`。

每批 `bun run check` + `bun run test:all` 全绿再提交。

## 4. 代价声明

- **D**：并发容器数 = 存活 agent 数（上限即 `maxConcurrentAgents`）；每次 spawn 多一次 create（亚秒级）；**内存上限按 agent 相乘**（存活数 × memoryMb，见 §1.4——容量规划口径改变，或调低 per-agent 默认）；缓存卷是新的磁盘资源（随题删除）；铸造凭据引入 per-boot secret 的内存管理（一行）与 1h 的凭据寿命上界（适用于 exec 派生的整个进程树，含 `nohup` 后台进程）——比永久 bearer 严格更好。
- **E**：B2 是本设计最重的一批（522 行管理器删除、批量装载重放、usage/统计 SQL 迁移、五个测试夹具重写），风险集中在 resume 路径——重放 parity 测试是主防线；body 双写期不存在（基线制无旧库，直接切换）。

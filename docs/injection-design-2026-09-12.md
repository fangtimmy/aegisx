# 镜像注入与提示词体系设计稿

日期：2026-09-12 · 状态：**已实施（同日落地，见文末实施记录）** · 范围：镜像提示词
注入 / 配置注入 / ENVIRONMENT.md 生成 / 提示词模板四个主题

本文只做设计与取舍记录，不改动任何代码。文中每条现状结论都带 `文件:行号` 实证，
可直接跳转核对；行号对应当前 `main`（45ca06b 之后）。

## 1. 范围与目标

四个主题看似独立，实为**同一条管道的三段**：

```
源（什么事实为真）  →  投递（怎么送到 agent）  →  消费（系统提示词怎么组装）
```

- **源**：`preset.json` 里的事件简报与调优、镜像内置的离线约束、工具链实际清单。
- **投递**：环境变量、镜像内烘焙文件、数据库行（`events.prompt_hint`、
  `prompt_templates`）。
- **消费**：Handlebars 把事实渲染成 `mainSystem` / `initial` / `orchestratorSystem`
  等系统提示词与投递块。

三段各缺**一个**概念，这就是当前所有具体问题的共同根因：

| 段 | 现状 | 缺的概念 |
|---|---|---|
| 源 | 调优在 `preset.json`；离线约束在 Dockerfile 正则脚本里；工具清单靠构建期自省 | **一份部署清单**（单一事实源） |
| 投递 | settings 会收敛覆盖、promptHint 只补空、模板只 seed——三套语义 | **一条统一的新鲜度规则** |
| 消费 | 16 个独立模板 + 五份手抄变量清单 + 五份示例上下文 | **段落模型与模板注册表** |

目标不是推倒重来。构建期自省生成 ENVIRONMENT.md 的设计（`gen-environment.py`）
本身是好的，应当保留并成为其余部分的范本；需要动的，是**事实源的唯一性**与
**升级语义的显式化**。

## 2. 现状数据流（实证）

### 2.1 镜像提示词注入：`promptHint`

单一入口，链路清晰：

```
containers/appliance/{tsecbench,xihulunjian}/preset.json   (promptHint 字段)
  → bootstrap.ts:140  EVENT_PRESET_PATH = "/opt/aegisx-preset/preset.json"
  → bootstrap.ts:174-189  readEventPreset()
  → bootstrap.ts:406  首启写入  events.prompt_hint
  → bootstrap.ts:411-418  重启仅当库中为空时回填
  → run/prompt.ts:92 (solver) / :154 (scheduler)  promptHint: event.promptHint ?? ""
  → prompt-defaults.ts:190-193 (mainSystem) / :105-108 (orchestratorSystem)
```

两个结构性事实：

1. **`promptHint` 是一个不可分割的泥球。** 西湖论剑那份 `promptHint` 约 1500 字
   （`containers/appliance/xihulunjian/preset.json:2`），同时混着四类内容：平台事实
   （DASCTF、category 语义）、解题工作流（先查内置手册、按 sha256 比对附件）、提交
   纪律（50 次预算、禁止变体枚举）、以及**调度者专属的运营方针**（"同题连续多次
   spawn 无进展 → 降优先级或 park 让出槽位"）。
2. **两个角色无条件共读同一份简报。** `mainSystem` 与 `orchestratorSystem` 都直接
   `{{event.promptHint}}`，因此解题 agent 会读到"如何调度 agent"的话，而简报作者
   没有任何手段声明"这段只给调度者看"。这是结构缺口，不是文案问题。

### 2.2 ENVIRONMENT.md 生成：好设计 + 一处脆耦合

好的一半：`containers/solver/gen-environment.py` 在构建期自省文件系统
（`has()` / `pip freeze` / 目录列举），只输出镜像真实存在的内容，缺失工具的条目
自动消失。历史审计中"文档写了 steghide 但没装"这一类问题（见
`docs/archive/audit-2026-08-23/05-prompt-drift.md:58`）在这个设计下已被结构性消除。
`containers/solver/ENVIRONMENT.md` 不再是签入文件，而是构建产物，三档 solver 各自
生成（`containers/solver/Dockerfile:63-64`、`145-146`、`264-265`）。

脆的一半：appliance 两个 target 用两段重复的 Python heredoc，靠**正则匹配章节标题**
把「缺工具时的安装 SOP」替换成离线声明：

- `containers/appliance/Dockerfile:170-184`（tsecbench）
- `containers/appliance/Dockerfile:211-225`（xihulunjian）

而那个标题 `## 缺工具时的安装 SOP` 定义在**另一个文件、另一种语言**里
（`gen-environment.py:294-310` 的 `section_sop()`）。一旦标题措辞变动，两处替换静默
失效——不报错，只是离线声明消失，agent 便会在断网镜像里尝试 `pip install`。

### 2.3 配置注入：分散在五处、四份手抄

服务端拼装点（全部在 `apps/server/src/run/agent-factory.ts`）：

| 站点 | 行号 | 内容 |
|---|---|---|
| `containerApiUrl()` | 78-84 | 派生 `AEGISX_API_URL`，docker 后端把 loopback 改写为 `host.docker.internal` |
| `sdkDevMount()` | 86-96 | 开发用 SDK 只读挂载 + `PYTHONPATH` |
| `schedulerSdkContainerOpts()` | 102-118 | 调度容器 `AEGISX_EVENT_ID` / `AEGISX_API_URL` + `/challenges:ro` |
| `solverSdkContainerOpts()` | 125-138 | 解题容器同款两个变量 |
| 每次 exec 的身份 | 844 | `AEGISX_AGENT_ID` / `AEGISX_TOKEN` |

下游消费方：`container/container-manager.ts:211-243`（create 的 `Env`/`Binds`）、
`:296`（exec 的 `Env`）；本地后端 `container/local-manager.ts:45`（backend 判定）、
`:139-152`（进程环境 + 工作区环境 + exec 环境合并）。

同一份事实另有三处**手工副本**：

- `containers/appliance/Dockerfile:151-158` 与 `containers/allinone/Dockerfile:16-21`
  的镜像内置 `ENV` 块。
- `docs/env.md`（第 63-74 行是 exec 注入表）。
- `apps/sdk/python/aegisx/client.py:24`/`33`/`43`/`60` 与 `aegisx/channels.py:157`
  的 `os.environ` 读取。

没有任何机制保证这四方一致。改动一处而漏改另一处，错误只在运行时以"SDK 连不上"
或"配置不生效"的形式暴露。

### 2.4 提示词模板：16 个模板，五份手抄清单

模板语料唯一源码是 `apps/server/src/orchestration/prompt-defaults.ts`：
6 个提示/投递模板（`orchestratorSystem` 11-111、`mainSystem` 113-193、
`initial` 195-237、`schedulerInitial` 239-249、`channelDelivery` 257-263、
`schedulerDigest` 311-315）加 10 个通知模板（`NOTICE_TEMPLATE_DEFAULTS` 275-296），
合计 **16 个**。

存储与渲染：`prompt-templates.ts:22-30`（`BUILTIN_DEFAULTS`）→ `:38-46`
`seedBuiltinTemplates()`（`ON CONFLICT DO NOTHING`）→ `:55-64` `loadTemplateMap()`
→ `:71-81` `renderTemplate()`，渲染用 strict + noEscape 的共享 Handlebars
实例（`:123-126`、`:182-189`）。

围绕这 16 个模板，需要手工保持同步的清单有：

- `PROMPT_TEMPLATE_VARIABLES`（`:83-115`）
- `ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES`（`:261-267`）
- `DELIVERY_TEMPLATE_VARIABLES`（`:323-336`）
- `SCHEDULER_DIGEST_TEMPLATE_VARIABLES`（`:415-442`）
- `NOTICE_TEMPLATE_VARIABLES`（`:544-560`）
- 五份示例上下文（`samplePromptContext` 等）+ `PromptContext` / `DeliveryRenderContext` /
  `SchedulerDigestContext` 三个类型。

值得肯定的是，你们已经为通知模板写了**自动漂移校验**：
`apps/server/test/orchestration/prompt-templates.test.ts:338-368` 会把模板里实际引用
的变量抽出来与清单比对。这个思路是对的，但它只覆盖 10 个通知模板；剩下 6 个更大的
模板（`mainSystem` 等）仍靠自觉，strict 模式的失败只会在用户打开设置页预览时出现。

**活体证据**：`apps/server/src/db/schema.ts:481` 的注释仍写着
"the four built-in keys (mainSystem/initial/orchestratorSystem/schedulerInitial)"，
而实际已是 16 个键。这正是"无注册表"的典型症状——连代码注释都追不上模板的增长。

## 3. 根因与导出事故

根因即第 1 节的三层三缺。由它导出的具体事故：

**事故 A — 升级镜像但复用旧 `/data` 卷时，调优只在镜像里生效三分之一。**
三种 seed 语义并存：

| 事实 | 落库语义 | 位置 |
|---|---|---|
| `settings` | 漂移即覆盖（drift-only converge） | `bootstrap.ts:193-209` |
| `events.prompt_hint` | 只补空，已有值不动 | `bootstrap.ts:411-418` |
| `prompt_templates` 行 | 有行即不覆盖（`ON CONFLICT DO NOTHING`） | `prompt-templates.ts:38-46` |

因此修好的一段提示词、或新镜像里改进的简报，在新镜像 + 旧卷的组合下**不会到达
运行实例**；只有 `settings` 会悄悄更新。`containers/appliance/README.md:44` 已经把
"升级镜像请用全新 /data 卷"写进操作手册，本质是把架构缺陷降级成注意事项。

**事故 B — 角色污染。** 见 2.1：解题 agent 读到调度方针，简报作者无法分区。

**事故 C — 跨文件字符串耦合。** 见 2.2：离线声明靠正则匹配另一文件的章节标题。

**事故 D — 单源复制。** 见 2.3：环境变量契约四方手抄。

**事故 E — 抄写债。** 见 2.4：`mainSystem` 内联了 SDK 精确签名，只好再写一个测试
（`prompt-templates.test.ts:303-336`）去比对它与 `GUIDE.md` 一致；`## Event instructions`
段在两个模板里重复；"先停靶机再 finish"一句出现三次。

## 4. 已决策约束（本设计的边界）

- **D1 · 本轮只产出文档**，不改代码、`preset.json`、Dockerfile、DB schema。
- **D2 · 运行库为权威。** `promptHint` 只补空、模板行只 seed；镜像内的调优**不自动
  传播**到既有实例。第 6 节据此给出运维刷新步骤，并记录一个 open question：
  `settings` 的 drift-converge 是三种语义里唯一的例外，它与 D2 原则冲突，是否统一
  留待单独决定。
- **D3 · `preset.json` 升级为部署清单**，同时驱动 bootstrap（首启 seed）与
  `gen-environment.py`（构建期）。这是本设计的地基。

## 5. 目标设计

### 5.1 部署清单 schema v2（源）

把 `preset.json` 从"三段调优"升级为"这次部署长什么样"的清单。它有两个消费者，
各读各需要的部分：bootstrap 首启落库（遵循 D2 语义），`gen-environment.py` 构建期
读取离线事实。

```jsonc
{
  // 简报：按读者分区，取代单一 promptHint 泥球
  "brief": {
    "common":       "平台事实 / flag 格式 / 环境约束（两个角色都读）",
    "solver":       "解题工作流、提交纪律、知识库使用（只给解题 agent）",
    "orchestrator": "预算策略、优先级、让位规则（只给调度者）"
  },
  // 从散文里提为结构化字段，使模板能把它渲染在稳定位置
  "flagFormats": ["flag{...}", "FLAG{...}"],
  // 构建期事实：ENVIRONMENT.md 的离线分支与 Dockerfile 的镜像语义
  "offline": { "enabled": true, "note": "本镜像为断网评测构建: 没有公网…" },
  "settings": { "scheduler.defaultRunTimeoutMs": 3600000 },
  "scheduler": { "maxConcurrentTargets": 3 }
}
```

要点：

- `brief.*` 三段都是**可选的纯文本**，向后兼容的读法是"solver 缺省时回退 common"，
  但按项目"不做兼容层"原则，实施时应一次性改写两份 `preset.json` 并删除旧字段。
- `offline` 同时服务两个消费者——这正是"单一事实源"的价值所在：Dockerfile 不再需要
  自己写死离线文案。
- `flagFormats` 让 `mainSystem` 不再需要"从题目描述里推断格式"这类软指令，可以直说。

### 5.2 模板注册表（消费）

把每个模板声明一次：

```ts
{ key, kind, default, sample, variables }
```

由它**派生**：`BUILTIN_DEFAULTS`、设置面暴露的变量面板、预览派发、以及 seed 循环。
`prompt-templates.ts` 里现有五份手抄清单与三个上下文类型随之收敛为派生量
（类型可由 `sample` 用 `typeof` 推导）。

同时把 `prompt-templates.test.ts:338-368` 的 notice 漂移校验**泛化到全部 16 个模板**：
对每个模板断言"`default` 引用的变量集 == 注册表声明的变量集 == `sample` 提供的键集"。
此后新增模板或改模板引用不存在的变量，在 `bun run test` 阶段即失败，而不是等用户
打开设置页预览时抛错。此项风险最低、收益最直接，建议最先落地。

### 5.3 角色化简报注入（投递，消费）

`buildSolverPromptContext` / `buildSchedulerPromptContext`（`run/prompt.ts:48-167`）
各自按角色取 `brief.common + brief.<role>`，渲染进对应模板。`{{event.promptHint}}`
单字段退休。

### 5.4 ENVIRONMENT.md 生成器内聚（投递）

`gen-environment.py` 增加 `--offline`（或从清单读 `offline.enabled`）与
`section_offline()`，离线文案取自清单。删除两个 Dockerfile 里的 heredoc 正则补丁，
使 `containers/appliance/README.md:40` 的描述与实现真正一致。五个调用点（solver 三档 +
appliance 两 target）走同一入口。

**明确不做**：不重写 `gen-environment.py` 里那份手工策展的工具分类白名单。它用
`has()` 探测，已能保证"文档有 == 镜像有"，自动推导分类是更大的改动且收益很低。

### 5.5 配置注入契约（投递）

在 `@aegisx/shared` 声明两组常量与构造器：

- 容器级：`AEGISX_EVENT_ID` / `AEGISX_API_URL`（+ 开发态 `PYTHONPATH`）
- 每次 exec：`AEGISX_AGENT_ID` / `AEGISX_TOKEN`

`agent-factory.ts` 与 `local-manager.ts` 从同一处取值。再加一个契约测试，锁定三方一致：
**服务端注入集合 == `docs/env.md` 所载 == SDK 读取集合**——与现有的 SDK 签名契约
（`apps/server/scripts/sdk-contract.ts`）同一套路。此项主要是防错，不是重构。

### 5.6 消费端去重（消费）

把重复段落（`## Event instructions`、"先停靶机再 finish"）抽成 TS 字符串常量，
在组装模板前拼入。

**明确否决 Handlebars partial**：它会在设置页制造"模板里还有模板"的两层编辑模型，
用户需要理解两级继承；为了省几行重复引入编辑器复杂度，不符合 KISS。

**单列待决**：`mainSystem` 内联 `channels.read/post` 精确签名，省了解题 agent 一次
`cat GUIDE.md`，代价是必须长期维护漂移比对测试。二选一——保留（继续养测试）或下放
（改为"签名见 GUIDE.md"）。

## 6. 种子语义与升级路径

依 D2，**运行库为权威**，不做自动覆盖。本设计**否决**了"记录 seed 内容 hash，内容未
被用户编辑则随镜像/代码默认值自动覆盖"的统一 reconcile 方案——它虽能消除事故 A，
但与"运行库为权威"的决策相悖，故仅记录在此备查。

因此运维路径保持现状但显式化：

- 需要让新镜像的简报/模板生效 → **使用全新 `/data` 卷**（`containers/appliance/README.md:44`
  已有此提示，本设计将其确认为正式流程而非注意事项）。
- Open question：`settings` 的 drift-converge（`bootstrap.ts:193-209`）是三种语义中
  唯一会自动覆盖者，与 D2 原则冲突。建议单独决策是"把它也改为只补空"还是"承认
  settings 属于另一类事实"。本设计不预设结论。

## 7. 分阶段落地顺序

| 阶段 | 内容 | 破坏面 | 门禁 |
|---|---|---|---|
| 1 | 5.2 模板注册表 + 泛化漂移测试 | 无（纯内部重构） | `bun run check` / `bun run test` |
| 2 | 5.6 段落去重 + channels 签名取舍 | 模板字节变化、seed 语义下旧库不更新 | `bun run test` |
| 3 | 5.5 配置注入契约 | 无；需同步 `docs/env.md` | `bun run test` / `bun run test:sdk` |
| 4 | 5.4 ENVIRONMENT.md 离线内聚 | 需重建镜像；动 Dockerfile | 镜像构建 + 出厂自检 |
| 5 | 5.1 + 5.3 部署清单 v2 与角色化简报 | **改 `preset.json` 格式**、动 bootstrap 与模板；需重建镜像 + 新 `/data` 卷 | `bun run test` + 实机演练 |

阶段 1 无破坏面，可独立先行；阶段 5 破坏面最大，须与镜像重建、赛事演练一起安排。
按项目规则，每阶段的类型/lint/测试在一轮内改完后统一执行，不逐文件检查。

## 8. 风险与不做清单

- 不重写 `gen-environment.py` 的策展白名单（见 5.4）。
- 不生成 `docs/env.md`——它是给人读的参考，由契约测试保证不失真即可。
- 不引入可编辑 partial（见 5.6）。
- 不改 `apps/web/src/components/ui/**`（coss UI 只读）。
- 新增导出须有消费方，否则 knip 卡门禁；注册表应尽量以内部结构 + 少量必需导出实现。

## 9. 与既有文档的关系

- `docs/architecture.md:114`（通用模板 vs 部署特调）是本设计的直接前身：它已确立
  "具体数值属部署侧 preset、通用原则属内置模板"的原则。本设计把该原则从"文案分工"
  推进到"结构分工"（角色化 brief、清单驱动构建）。
- `docs/env.md` 是 5.5 契约测试的比对对象之一，其"运行时可设 / 镜像内置 / exec 注入"
  三分类与 2.3 的四方对照一致。
- `docs/archive/audit-2026-08-23/05-prompt-drift.md` 的八项发现现状复核：
  - **F1（seed-only 无升级路径）**：在 D2 决策下**保留为已知取舍**（第 6 节）。
  - **F2（yarasan）/ F3（steghide）**：随 `gen-environment.py` 的构建期自省**已
    结构性消解**——`containers/solver/ENVIRONMENT.md` 已不再是签入文件。
  - **F5（Channels 段内联签名）**：仍在，见 5.6 待决项。
  - **F6（变量清单缺 `event.promptHint`）/ F7（调度者上下文不渲染 promptHint）**：
    **已修复**——`prompt-templates.ts:89` 已收录该变量，`prompt-defaults.ts:105-108`
    已让调度者渲染。
  - **F8（read-only 措辞把协作约定说成硬约束）**：仍在但**已部分改善**——
    `prompt-defaults.ts:169` 用了准确的"协作约定"措辞，而 `:222-223` 与
    `bash-tool.ts:194` 仍是 "read-only"。本设计未纳入，留作独立打磨项。
- `docs/audit-2026-09-09.md` 是当前债务台账，其中 P1-9 涉及提示词变量清单漂移
  （已修复）。本设计所提各项均不与之重复，实施时应作为新条目登记。

## 10. 实施记录（2026-09-12）

全部阶段已落地，门禁 `bun run check` / `bun run test`（610 过）/ `bun run test:sdk`
（CONTRACT PASS）/ `bun run build` 全绿。与设计的偏差与补充决定：

- **5.5 的契约模块位置**：未放入 `@aegisx/shared`（该包定位是 wire 类型，无 runtime
  代码路径），落在 `apps/server/src/run/container/env-contract.ts`；三方一致性由
  `test/run/env-contract.test.ts` 锁定（服务端只经契约构造 + SDK 读取集合 + env.md 文档）。
- **5.2 注册表**：`PROMPT_TEMPLATES` 落在 `prompt-templates.ts`，16 个模板各声明一次
  `{key, kind, default, variables, preview}`；`BUILTIN_DEFAULTS`、五个设置页变量面板
  与预览派发全部派生。泛化漂移测试断言每个默认值可对样例上下文渲染（strict 模式）、
  点式引用必须延伸自已声明的变量路径。三个仅被注册表使用的预览函数转为内部函数（knip）。
- **5.1/5.3 存储**：`events.prompt_hint` 列改为 `prompt_brief`（EventPromptBrief JSON：
  三段文本 + flagFormats），SCHEMA_VERSION 22→23，基线迁移重生成（无 DROP/ALTER）。
  角色合并发生在上下文构造器（`eventBriefFor`），模板仍渲染单一 `{{event.brief}}`；
  `flagFormats` 渲染进 mainSystem 的提交章节。UI 赛事简报改为三段文本（flagFormats
  仅随清单分发，不经 UI patch，PATCH 按段合并保住既有值）。
- **两份 preset.json 已改写为清单 v2**（brief 三段 / flagFormats / offline / settings /
  scheduler），离线文案从 Dockerfile heredoc 迁入 `offline.note`。
- **5.6 待决项已决**：mainSystem 的 channels 内联签名**保留**（省一次 GUIDE 读取的
  收益高于测试维护成本），漂移比对测试继续生效。
- **待办（人工）**：appliance 镜像需重建（清单/生成器签名变了）；既有实例按第 6 节
  用全新 `/data` 卷。

## 11. 评审修复记录（同日，三路子代理评审后）

- **回填判据细化**：bootstrap 回填从「整包判空」改为**按种子类型分开**——brief 文本
  仅在库中三段全空时回填（保护用户文本）；flagFormats 在「清单有、库中无」时独立补齐
  （它们不经 UI，无用户编辑可保护），消除「新镜像清单补了 flagFormats 被旧文本吞掉」
  的洞。已知取舍：用户**有意清空**三段文本与「从未种入」不可区分，重启会被重新种入
  （代码注释已声明）。
- **生成器 loud-fail 收口**：`--manifest` 传入但清单缺 `offline` 键时直接报错退出
  （不再静默回退联网 SOP——那正是 §2.2 要消灭的失效模式）；显式 `offline.enabled=false`
  仍合法。`--help`/坏清单不再先付 venv 探测的成本（argparse 前置）。
- **tsecbench brief 补回 f2 映射**：`brief.solver` 恢复「flag 格式恒为
  flag{<uuid>}，f2 系列为 FLAG{...}，格式不符不要提交」——flagFormats 平铺列表
  丢失的系列对应关系由散文承担。
- **渲染细节**：mainSystem 的 flagFormats 用 `join` helper 以 ` / ` 分隔（原 each
  连跑不可读）；orchestratorSystem 的 brief 与 `## Recording` 之间空行在片段内补回。
- **漂移测试收紧**：点式引用匹配加词边界（`event.nameX` 不再误判为已声明），提取器
  识别 helper 调用（`{{join list " / "}}` 的引用路径取第一个参数）。

# AegisX CTF Agent 需求与技术方案

> 状态：初稿
> 日期：2026-07-15
> 目标版本：MVP

## 1. 产品目标

AegisX 是面向单个开发者的本地 CTF 解题管理与 Agent 运行平台。用户可以创建赛事、维护题目、为同一道题启动多次独立运行，并在统一界面中观察、干预和复盘 Agent 的完整解题过程。

MVP 的核心目标：

1. 管理赛事、题目和附件。
2. 在本机目录或 Docker 容器中启动相互隔离的 Agent 运行。
3. 使用 Pi SDK 驱动 Agent，实时展示文本、思考、工具调用和错误。
4. 向 Agent 提供完成解题、靶机控制和提交 Flag 工具。
5. 支持人工纠偏、暂停、继续和停止运行。
6. 统计每场赛事、每道题目和每次运行的 Token 与费用。
7. 定义 CTF 平台插件接口，但暂不实现任何平台适配器。

## 2. MVP 范围

### 2.1 包含

- 单用户、本地部署，不包含登录和权限系统。
- 赛事的创建、编辑、归档和删除。
- 题目的手工创建、编辑和删除。
- 支持一次上传多个可选附件。
- CTF 平台连接配置和插件接口占位。
- 从平台批量拉取题目的应用服务与 UI 入口；没有安装插件时显示不可用状态。
- 每道题目可创建任意多次运行。
- 运行环境支持本机目录和 Docker 容器。
- Agent 实时事件、对话、工具调用、文件浏览和统计。
- 人工发送纠偏消息、暂停、继续、停止。
- Agent 调用 `finish_run` 主动报告完成；用户可以重新打开或标记失败。
- 模型、供应商和解题环境的本地配置。

### 2.2 不包含

- 多用户、团队、RBAC、公开分享。
- Kubernetes、远程 Worker、分布式调度。
- 具体 CTF 平台适配器。
- 浏览器内交互式终端。
- 自动验证本地题目的 Flag 正确性。
- 自动评测 Agent 解题质量或多 Agent 协作。
- 题目版本管理和附件在线编辑。

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| 赛事 Event | 用户创建的题目集合，可选关联一个 CTF 平台连接 |
| 题目 Challenge | 赛事下的一道题，包含名称、描述、附件和平台引用 |
| 运行 Run | 针对一道题的一次独立 Agent 解题尝试 |
| 执行环境 Environment | Agent 工具实际执行的位置：本机工作目录或容器 `/workspace` |
| 平台插件 Platform Plugin | 对接外部 CTF 平台题目、靶机和 Flag API 的适配器 |
| 人工接管 | 暂停自动运行后，由用户发出指令或执行受控操作，再继续 Agent |

## 4. 已确认产品决策

| 决策项 | MVP 选择 |
| --- | --- |
| 用户模型 | 单用户本地应用 |
| 主要部署 | 开发者本机 |
| 本机 Agent | 默认允许按应用进程权限执行命令 |
| 人工接管 | Steer + 暂停/继续，不提供共享 PTY |
| 成功判定 | Agent 调用 `finish_run` 自报完成 |
| 平台集成 | 只预留接口，不实现适配器 |
| 附件处理 | 原始字节复制到工作区，不自动解包 |
| 容器工作区 | 每次运行一个专属宿主目录，bind mount 到 `/workspace` |
| 实时协议 | SSE 推送事件，REST 发送控制命令 |
| 删除语义 | 直接删除数据库记录，文件异步清理 |
| 前端形态 | Vite SPA |
| 凭据存储 | SQLite 明文存储，仅面向本地单用户使用 |
| 默认镜像 | 基于 Kali Rolling 构建的 AegisX 镜像 |
| 存储配额 | 不设附件或工作区硬限额，显示占用与磁盘空间警告 |
| 首个平台方向 | CTFd；MVP 仅用于接口契约校验，不实现适配器 |

## 5. 用户流程

### 5.1 创建赛事和题目

1. 用户在首页创建赛事。
2. 用户进入赛事概览，手工添加题目，填写名称、描述和多个可选附件。
3. 若赛事配置了平台连接且插件可用，用户可预览远端题目并批量导入。
4. 导入使用平台题目 ID 幂等更新，不重复创建同一远端题目。

### 5.2 启动运行

1. 用户从题目卡片或运行页创建运行。
2. 用户选择模型、思考等级和执行环境；默认继承全局配置。
3. 系统创建独立工作目录，将所有附件按原始字节复制到工作目录，不自动解包或转换。
4. 容器模式将该运行的专属宿主目录 bind mount 到 `/workspace`；本机模式直接使用该目录。
5. 系统创建 Pi `AgentSession`，注入题目信息和 CTF 工具后发送初始提示词。
6. 前端实时显示 Agent 消息、工具调用和运行状态。

### 5.3 人工接管

1. 用户可在运行中发送 `steer` 指令；指令在当前工具调用结束后进入下一轮。
2. 用户选择暂停时，系统调用 Pi `abort()` 中止当前模型流或工具执行，并将运行标记为 `paused`。
3. 用户可在暂停状态浏览或修改工作区文件、发送新的人工消息。
4. 用户选择继续时，系统向原会话发送明确的继续提示，Agent 从当前持久化上下文继续。
5. 用户选择停止时，运行进入终态，不再自动继续；容器按保留策略停止。

说明：Pi 没有原生“冻结并恢复当前工具调用”的语义。MVP 的暂停是可审计的中止点，继续会开始新一轮，而不是恢复被中断的进程现场。

### 5.4 完成运行

1. Agent 调用 `finish_run`，提交摘要、候选 Flag 和可选说明。
2. 系统记录完成信息并结束自动循环。
3. 运行标记为 `completed`，但不声明 Flag 已被平台接受。
4. 用户可手工改为 `failed`，或重新打开并继续运行。

## 6. 功能需求

### 6.1 赛事管理

- 赛事字段：名称、描述、开始时间、结束时间、标签、平台连接、创建时间、更新时间、归档时间。
- 首页默认显示未归档赛事，支持搜索、状态筛选和排序。
- 删除赛事前展示其题目、运行和附件数量，并要求确认。
- 赛事或题目存在 `queued`、`preparing`、`running`、`pausing` 或 `paused` 运行时拒绝删除，用户必须先停止运行。
- 删除事务先写入持久化 `cleanup_jobs`，再直接级联删除业务记录；Worker 重试清理附件、运行工作区和 Pi 会话文件。

### 6.2 题目管理

- 手工题目必填名称和描述，可上传零个或多个附件。
- 可选字段：分类、分值、远端状态、远端题目 ID、Flag 提交记录。
- 名称在同一赛事内不要求唯一；远端题目 ID 与平台连接组合必须唯一。
- 附件上传应保留原文件名、大小、MIME、SHA-256 和存储键。
- 运行创建时逐字节复制附件，不解包、不改写、不根据 MIME 做内容转换；压缩包由 Agent 自行处理。
- 工作区文件名使用经过验证的安全 basename；同一题目不允许重复文件名，避免复制时覆盖。
- 上传文件名必须拒绝绝对路径、路径分隔符、`.` 和 `..`。

### 6.3 平台插件

平台插件在可信的应用进程内执行。插件配置和凭据不能传入 Agent 提示词、工作目录或容器。

最小接口：

```ts
interface CtfPlatformPlugin {
  readonly id: string;
  readonly displayName: string;

  validateConfig(config: unknown): Promise<PlatformValidation>;
  listChallenges(ctx: PlatformContext): Promise<RemoteChallengeSummary[]>;
  getChallenge(ctx: PlatformContext, remoteId: string): Promise<RemoteChallenge>;
  downloadAttachments(
    ctx: PlatformContext,
    remoteId: string,
  ): Promise<AsyncIterable<RemoteAttachment>>;
  startInstance(ctx: PlatformContext, remoteId: string): Promise<TargetInstance>;
  stopInstance(ctx: PlatformContext, remoteId: string): Promise<void>;
  submitFlag(
    ctx: PlatformContext,
    remoteId: string,
    flag: string,
  ): Promise<FlagSubmissionResult>;
}
```

约束：

- `PlatformContext` 由服务端构造，包含已解密凭据、超时和取消信号。
- 插件返回稳定的领域 DTO，不把平台原始响应泄漏到业务层。
- 每个网络操作必须支持超时、取消和结构化错误。
- 批量同步先获取摘要，再按需获取详情和附件。
- 平台能力可选；插件通过 capability 声明不支持的操作，UI 对应禁用。
- 平台插件以本地 workspace/npm 包安装并在进程启动时静态注册。
- MVP 只交付接口、注册表和无插件时的空状态，不支持按路径动态加载或远程下载第三方代码。
- fake 插件和契约测试参考 CTFd 的题目、附件、实例与 Flag 提交语义，但不在 MVP 中调用真实 CTFd API。
- 运行进入 `stopped` 或被删除时，系统自动调用 `stopInstance` 回收其活动靶机；`completed` 和 `failed` 默认保留靶机供人工验证，用户可显式停止。

### 6.4 运行管理

运行状态：

```text
queued -> preparing -> running -> completed
  |          |           |  ^
  |          |           v  |
  |          |        pausing -> paused
  |          |                     |
  |          `---------------------+----> failed
  `--------------------------------+----> stopping -> stopped

preparing/running/pausing/paused -> interrupted
completed/failed/stopped/interrupted -> paused  (reopen)
completed -> failed                            (manual correction)
```

规则：

- 每次运行绑定创建时的题目快照、模型配置快照和环境配置快照。
- 修改题目不改变已启动运行的提示词和附件。
- 同一题目可以并发运行；MVP 默认全局并发数为 2，可配置。
- 状态转换由服务端校验，重复命令必须幂等。
- 应用重启后，`running` 或过渡态运行先标记为 `interrupted`；用户可选择恢复为新一轮或停止。
- `reopen` 将终态或 `interrupted` 运行转为 `paused`，随后由用户显式 `resume`，避免重新打开即调用模型。
- Worker 重启后不自动恢复 `interrupted` 运行，避免重复执行尚未确认结果的工具调用。
- 用户人工标记失败只允许 `completed -> failed`，用于纠正 Agent 误报完成。
- Worker 必须定期写入心跳；前端不以 SSE 是否连接判断运行真实状态。

### 6.5 Agent 与 Pi SDK 集成

MVP 使用 `@earendil-works/pi-coding-agent` 的 `createAgentSession()`，而不是直接重写 agent loop。

使用的已确认能力：

- `AgentSession.prompt()` 启动和继续对话。
- `steer()` / `followUp()` 实现人工纠偏和排队消息。
- `abort()` 实现暂停和停止时的中止。
- `subscribe()` 接收文本、thinking、工具调用、重试、压缩和生命周期事件。
- `customTools` 注册 CTF 领域工具。
- `cwd` 为每次本机运行绑定独立目录。
- `SessionManager` 持久化 JSONL 会话树。
- Assistant message 自带 provider、model、Token 和 cost 数据。
- 自动压缩和自动重试由 Pi 设置管理。
- 使用 AegisX 自定义 ResourceLoader、AuthStorage 和 SessionManager 路径，默认禁用 Pi 对用户 `~/.pi`、项目 extensions、skills、prompts 和 AGENTS.md 的自动发现。

每个运行的工具集：

- Pi 编码工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。
- `finish_run(summary, flag?, notes?)`：报告完成并终止自动后续轮次。
- `start_target()`：通过平台插件启动靶机；无平台能力时返回明确错误。
- `stop_target()`：停止当前靶机。
- `get_target()`：获取靶机连接信息。
- `submit_flag(flag)`：向平台提交 Flag 并记录结果。

工具执行边界：

- `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 等环境工具通过 `RunEnvironment` 在本机工作区或容器内执行。
- `finish_run`、`start_target`、`stop_target`、`get_target`、`submit_flag` 等领域工具始终在宿主 Worker 执行，不将平台凭据或控制能力交给容器。
- 前台 shell 命令默认超时 10 分钟，可在环境设置中调整或关闭；超时、暂停和停止必须终止整个子进程树。
- 允许启动后台进程；环境实现必须按运行跟踪其 PID/进程组，暂停、停止或删除运行时统一终止。

初始提示词至少包含：

- 题目名称、描述、分类和分值。
- 工作目录约定。
- 附件清单及 SHA-256。
- 可用平台能力和靶机状态，不包含凭据。
- 完成条件：调用 `finish_run`，不得只在文本中声称完成。
- 安全边界：只处理当前题目和授权靶机。

### 6.6 执行环境

统一接口只覆盖两种确有需要的实现：

```ts
interface RunEnvironment {
  prepare(run: RunSpec): Promise<PreparedEnvironment>;
  execute(command: CommandSpec): Promise<CommandResult>;
  listFiles(path: string): Promise<FileEntry[]>;
  readFile(path: string, range?: ByteRange): Promise<FileContent>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}
```

本机模式：

- 工作区：`data/workspaces/<run-id>/`。
- Pi 的 `cwd` 指向该目录。
- 命令继承 AegisX Worker 的操作系统权限。
- 只继承 Worker 的环境变量、shell 和 PATH，不提供额外初始化脚本或运行级覆盖。
- 路径 API 必须解析真实路径并验证其位于运行工作区内。
- UI 必须持续显示“本机执行”风险标识。

容器模式：

- 工作目录固定为 `/workspace`。
- 每次运行一个容器；容器名包含运行 ID。
- 默认禁用 privileged、宿主 PID/IPC、Docker socket 和额外 capabilities。
- 默认镜像基于最小 Kali Rolling 构建，只预装基础 shell、git、curl、Python、Node.js、ripgrep、file 等运行依赖；镜像名可配置。
- 默认用户为非 root，但提供容器内免密 sudo，允许 Agent 按题目安装工具；容器仍禁用 privileged、Docker socket 和额外挂载。
- 默认限制为 4 CPU、8 GiB 内存和 512 PIDs，可在环境设置中调整，并启用 `no-new-privileges`。
- 网络策略默认 `bridge`，可配置为 `none` 或运行平台支持的 `host`；使用 `host` 时显示隔离减弱和跨平台语义差异。
- 每次运行的专属宿主工作目录 bind mount 到 `/workspace`；题目附件先原样复制到该目录。
- 除运行工作目录外，不能挂载 AegisX 数据目录、模型密钥或其他宿主路径。
- 运行完成、失败或停止后停止并删除容器，保留 bind mount 工作区直到运行被删除。

Pi 官方同时支持“整个 Pi 进容器”和“宿主 Pi 转发工具到沙箱”。本项目选择宿主 Worker 持有 Pi 会话、所有文件和 shell 工具委托给 `RunEnvironment`。这样模型凭据不进入容器，且本机/容器共用同一事件与会话管理。实现时必须禁用 Pi 默认的宿主工具，注册等价的环境工具，避免任一工具绕过容器。

### 6.7 文件浏览

- 树状按需加载，不递归扫描整个工作区。
- 支持文本预览、图片预览和二进制元信息；超大文件只读取指定范围。
- 可在暂停状态创建、编辑、重命名、上传和删除文件。
- 运行状态下默认只读，避免与 Agent 同时写入产生覆盖。
- 记录暂停期间的人工文件变更路径；恢复时向 Agent 注入变更摘要，不自动附加完整 diff。
- 附件和工作区不设置硬容量上限；文件页显示当前占用和宿主剩余空间，空间不足时显示警告。
- 所有路径通过 `RunEnvironment`，前端不得接触宿主绝对路径。

### 6.8 统计

- 按运行聚合 input、output、cache read、cache write、total tokens 和费用。
- 按题目和赛事聚合运行次数、完成数、失败数、总 Token、总费用和运行时长。
- 数据来源是持久化的 Pi assistant message usage，不依赖前端累计。
- 费用仅是 Pi 模型目录中的估算值；自定义模型无价格时显示“未知”，不得按零费用展示。
- 图表至少包括题目 Token 对比、时间序列消耗和模型分布；表格提供精确值。

### 6.9 设置

- 供应商：内置供应商或 OpenAI-compatible 自定义端点。
- 模型：供应商、模型 ID、上下文长度、最大输出、思考等级、可选价格。
- 凭据：模型 API Key 和平台凭据明文存入 SQLite；读取接口仍只返回是否已配置和掩码，创建 AgentSession 时通过运行时凭据注入 Pi。
- 默认运行配置：本机/容器、镜像名、网络模式、资源限制、全局并发数。
- 设置变更只影响新运行，不改变运行快照。

## 7. 前端信息架构

技术要求：React、Tailwind CSS v4、coss ui、Zustand。

### 7.1 首页：赛事列表

- 顶部工具栏：搜索、状态筛选、创建赛事、设置入口。
- 主体使用紧凑列表或网格，展示赛事时间、题目数、运行数和完成进度。
- 空状态直接提供创建赛事操作。

### 7.2 赛事页

固定页头展示赛事名称、时间、总体进度和操作菜单。

Tab：

- 概览：题目网格；每张题目卡展示分类、分值、附件、运行数量和最近运行状态。
- 运行：左侧题目/运行树，右侧运行工作区。
- 统计：图表和明细表。

### 7.3 运行工作区

右侧包含三个二级 Tab：

- 概览：状态、模型、环境、开始/结束时间、耗时、Token、费用、靶机和完成摘要。
- 对话：按时间呈现用户、Agent、thinking、工具调用、结果、重试和压缩事件；thinking/reasoning 默认折叠；底部输入用于 steer/follow-up；提供暂停、继续、停止。
- 文件：文件树、预览和暂停状态下的编辑操作。

桌面端为可调整两栏；窄屏将左侧树变为 Sheet，主工作区保持单栏。所有状态不能只用颜色表达。

### 7.4 状态管理

- 服务端数据和 Agent 事件由 TanStack Query cache 负责，不复制进 Zustand。
- 当前赛事、选中的运行和 tab 写入 URL，由 React Router 管理。
- Zustand 只保存跨组件且不属于 URL/服务端的交互状态：展开节点、布局尺寸和未发送输入。
- SSE 增量合并进当前运行的 Query cache；断线后使用最后事件序号补拉。

## 8. 系统架构

### 8.1 形态

```text
React Web
   | REST + SSE
API Server
   |-- Hono Event / Challenge / Settings routers
   |-- Platform plugin registry
   |-- Run command service
   |
SQLite <-------- Agent Worker
                    |-- Pi AgentSession
                    |-- LocalEnvironment
                    `-- DockerEnvironment -> Docker Engine

Local filesystem/object storage
   |-- original attachments
   |-- run workspaces
   `-- Pi JSONL sessions
```

采用 Bun-first TypeScript monorepo、模块化单体和一个独立 Worker 进程。HTTP 应用层使用 Hono，运行在 `Bun.serve` 上；Worker 默认也以 Bun 运行。两者可由同一开发命令启动，但保留进程边界，避免 Agent 长任务阻塞 Web 请求。Pi SDK 的 Bun 兼容性由阶段 0 契约测试确认；只有 Pi `AgentSession` 核心链路仍无法稳定运行时，才允许 Worker 单独回退 Node.js，API 始终保持 Bun。

首版使用 SQLite，不引入 Redis。数据库启用 WAL、foreign keys 和 `busy_timeout`，API 与单个 Agent Worker 只执行短写事务。Worker 通过原子状态更新领取运行并先持久化事件；API 的 SSE 连接按游标短轮询 `run_events` 并推送增量。MVP 不支持启动多个 Worker；出现明确的多机或高并发需求时，再评估外部数据库和专用消息系统。

数据库迁移由启动命令/API 进程唯一执行，Worker 校验 schema version 后才领取任务。状态、工具和生命周期事件立即持久化；高频 text/thinking delta 在 Worker 内短暂合并后批量写入，避免逐 token 放大 SQLite WAL 写竞争。

### 8.2 建议目录

```text
apps/
  web/                 React 前端
  server/              Hono HTTP/SSE API on Bun
  worker/              Agent 运行进程
packages/
  domain/              领域类型、状态机和用例接口
  db/                  schema 与查询
  agent-runtime/       Pi 会话和 CTF 工具
  environments/        本机与 Docker 实现
  platform-api/        插件契约和注册表
  ui/                  coss 组件和应用级 UI
```

只有跨应用实际共享的代码进入 `packages/`，不为每个领域对象创建独立包。

## 9. 核心数据模型

| 实体 | 关键字段 |
| --- | --- |
| events | id, name, description, starts_at, ends_at, platform_connection_id, archived_at, timestamps |
| challenges | id, event_id, source, remote_id, name, description, category, points, snapshot_version, timestamps |
| attachments | id, challenge_id, original_name, storage_key, size, mime, sha256, created_at |
| platform_connections | id, plugin_id, name, config_json, credentials_json, timestamps |
| runs | id, challenge_id, status, environment_type, model_snapshot, environment_snapshot, challenge_snapshot, session_path, workspace_key, timestamps, heartbeat_at, error |
| run_events | id, run_id, seq, type, payload_json, created_at |
| run_usage | id, run_id, message_entry_id, provider, model, token fields, cost fields, created_at |
| target_instances | id, run_id, platform_connection_id, remote_challenge_id, status, connection_json, timestamps |
| flag_submissions | id, run_id, flag, result, response_message, submitted_at |
| settings | key, value_json, updated_at |
| cleanup_jobs | id, kind, payload_json, attempts, next_attempt_at, last_error, created_at, completed_at |

关键约束：

- `run_events (run_id, seq)` 唯一，保证断线续传顺序。
- `run_usage (run_id, message_entry_id)` 唯一，防止事件重放导致重复计费。
- `challenges (event_id, source, remote_id)` 对远端题目建立条件唯一索引。
- 运行事件、Pi JSONL 会话和 usage 随运行完整保留，直到用户删除运行。
- Pi JSONL 是会话恢复来源，SQLite `run_events` 是 UI 补流来源；同步使用稳定的 Pi entry ID 和事件序号幂等恢复，usage 不得重复计入。
- Flag 和凭据按已确认决策明文存入 SQLite，但日志、通用错误和设置读取接口必须脱敏。

## 10. API 与实时事件

REST 资源：

- `/api/events`
- `/api/events/:eventId/challenges`
- `/api/events/:eventId/import`
- `/api/challenges/:challengeId/attachments`
- `/api/challenges/:challengeId/runs`
- `/api/runs/:runId/{pause,resume,stop,steer,follow-up,reopen,mark-failed}`
- `/api/runs/:runId/files`
- `/api/runs/:runId/stats`
- `/api/settings/{models,environments,platforms}`

SSE：

- 客户端通过 `GET /api/runs/:runId/events?after=<seq>` 订阅当前运行；首次连接可省略 `after`。
- 每个事件使用 `seq` 作为 SSE `id`，固定使用 `run_event` 作为 `event`，`{ runId, seq, type, payload, createdAt }` 作为 JSON `data`。
- 浏览器自动重连时通过 `Last-Event-ID` 携带最后收到的 `seq`；页面刷新或手工重建连接时使用持久化的 `after`。服务端取两者较大值，先从 SQLite 补发，再持续短轮询增量。
- 服务端定期发送注释心跳，避免空闲连接被代理关闭；心跳不写入 `run_events`。
- SSE 只传事件，改变状态的命令仍走 REST，便于幂等、验证和审计。
- 单个 UI 只保持当前选中运行的一条 SSE 连接；列表状态通过普通查询刷新。
- 若未来加入交互式 PTY、二进制流或高频双向通信，再评估 WebSocket；MVP 不同时维护两套实时协议。

## 11. 安全基线

尽管 MVP 是单用户本地应用，Agent 会执行不可信题目内容和命令，以下要求不能省略：

- MVP API 只监听 loopback，不提供外网绑定配置。
- 校验 Host 和 Origin，只允许 AegisX/Vite 本地来源；不启用宽泛 CORS。
- 状态变更只接受严格 `application/json`，附件端点接受指定原始媒体类型并流式落盘。
- 模型密钥和平台凭据虽明文存入本地 SQLite，但不写入提示词、运行目录或容器环境。
- 上传文件不设置大小或数量硬上限，以随机存储键流式落盘，并在磁盘空间不足时警告用户；服务端不得把完整附件缓冲进内存。
- 系统不自动解包附件；复制到工作区前验证文件名并校验 SHA-256。
- 所有工作区文件 API做 canonical path 校验。
- 容器不挂载 Docker socket，不使用 privileged，不共享宿主网络和 PID namespace。
- 工具输入使用 TypeBox schema 验证；平台错误返回给 Agent 前删除凭据和内部堆栈。
- Flag、API Key、Authorization header 和常见令牌模式在日志落盘前脱敏。
- 删除操作和运行控制操作记录审计事件。
- 明确提示本机模式不是安全沙箱，应用无法阻止 shell 读取当前用户可访问的其他文件。

## 12. 非功能需求

- 可恢复性：服务重启不丢失赛事、题目、运行事件、Pi 会话和工作区。
- 保留性：运行事件、Pi 会话和 usage 不自动过期，只随运行删除。
- 实时性：本机开发环境中，Agent 事件从产生到 UI 展示的 P95 小于 500 ms。
- 一致性：状态变更和事件写入在同一数据库事务边界内完成。
- 可观测性：日志包含 request ID、run ID、toolCall ID；不记录秘密值。
- 兼容性：API/Worker 支持项目锁定的 Bun 版本；Vite/Playwright 使用锁定的 Node LTS；支持现代 Chromium/Firefox/Safari 和 Docker Engine。macOS 开发环境与 Linux CI 均运行核心契约测试。
- 可测试性：平台、模型和环境均可使用 fake 实现进行确定性测试；Pi 提供 faux provider。
- 可访问性：键盘可操作，焦点可见，状态有文本说明，对话流使用合适的 live region 策略。

## 13. Pi SDK 调研结论

调研基于 2026-07-15 的 `earendil-works/pi` 主分支文档。

### 13.1 可以直接复用

- 多供应商模型目录、OpenAI-compatible 自定义供应商、API Key/OAuth 解析。
- Agent loop、工具参数验证、并行/顺序工具执行、流式事件。
- AgentSession 的持久化、树状分支、压缩、重试、模型切换和统计。
- 自定义工具、系统提示词覆盖、人工 steer/follow-up/abort。
- 每条 assistant message 的 Token、缓存 Token 和费用数据。
- Faux provider，可用于不调用真实模型的确定性测试。

### 13.2 需要 AegisX 实现

- 赛事、题目、运行和平台领域模型。
- Worker 调度、运行状态机、心跳和重启恢复。
- 本机/容器执行环境及全部工具转发。
- SSE 事件持久化、`Last-Event-ID` 断线补拉和心跳。
- 工作区文件 API、附件安全处理和容器生命周期。
- 平台插件接口、凭据隔离、靶机与 Flag 工具。
- 面向产品的统计聚合和前端。

### 13.3 重要限制

- Pi 默认继承启动进程的所有权限，不提供内置权限沙箱。
- `steer` 只会在当前 assistant turn 的工具调用结束后生效，不会立即抢占工具。
- `abort` 会中止当前操作，但不提供进程现场级恢复。
- Pi JSONL 是 Agent 会话事实来源；AegisX 仍需保存规范化事件和 usage，供查询、补流和统计使用。
- 容器工具转发时必须替换所有默认文件和 shell 工具；只替换 `bash` 不构成隔离。

参考资料：

- https://github.com/earendil-works/pi
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
- https://github.com/earendil-works/pi/blob/main/packages/agent/README.md
- https://coss.com/ui/docs/get-started

## 14. MVP 验收标准

1. 用户可创建赛事，添加带附件的题目，并在刷新或重启后保留数据。
2. 用户可上传多个附件，并为题目分别启动本机和容器运行；附件原样复制且两个运行的工作区互不影响。
3. 容器运行目录通过专属 bind mount 映射到 `/workspace`，Pi 的读写、搜索、编辑和 shell 工具均只作用于该目录。
4. 前端能实时展示文本、thinking、工具调用、结果、错误、重试和完成事件。
5. 用户可 steer、暂停、继续和停止；非法状态转换得到明确错误。
6. Agent 调用 `finish_run` 后运行自动进入 `completed`，摘要以及已提供的候选 Flag 可查看。
7. 文件页可安全浏览工作区，并拒绝路径穿越请求。
8. 统计页的运行、题目和赛事聚合值与 Pi 持久化 usage 一致。
9. 应用重启后，历史对话、文件、统计可查看；中断运行被识别并可继续或停止。
10. 未安装平台插件时，导入、靶机和提交 Flag 操作呈现明确不可用状态，不导致运行崩溃。

## 15. 已解决的补充决策

- 附件允许多选上传，并以原始字节复制到工作区；系统不自动解包。
- 容器使用每运行专属宿主目录 bind mount 到 `/workspace`。
- 本机模式只继承 Worker 环境，不增加 shell、PATH 或初始化脚本设置。
- `finish_run` 的候选 Flag 可选。
- 删除不提供回收站：数据库记录直接删除，关联文件异步清理。
- 实时事件使用 SSE，控制命令使用 REST。
- 环境工具在运行环境中执行，平台与完成工具在宿主 Worker 执行。
- 删除使用持久化 `cleanup_jobs`；存在活动运行时拒绝删除。
- 凭据和 Flag 明文存入 SQLite，但不得进入 Agent 工作区、容器或日志。
- 前端使用 Vite SPA；默认镜像基于 Kali Rolling。
- 容器默认 bridge 网络、4 CPU、8 GiB 内存和 512 PIDs，均可配置。
- 前台命令默认 10 分钟超时；运行结束删除容器并保留工作区。
- 默认镜像保持最小工具集并允许非 root 用户免密 sudo；后台进程按运行跟踪和回收。
- 附件和工作区不设硬限额，但显示占用和磁盘空间警告。
- 运行停止或删除时自动回收活动靶机，完成或失败时保留供人工验证。
- interrupted 运行由用户手工恢复；人工文件变更以路径摘要通知 Agent。
- 运行记录完整保留；thinking/reasoning 默认折叠展示。
- 平台插件以本地包静态注册。
- 首个真实平台方向为 CTFd；MVP 只做契约兼容性校验。

# AegisX CTF Agent 需求与技术方案

> 状态：初稿
> 日期：2026-07-15
> 目标版本：MVP

## 1. 产品目标

AegisX 是面向单个开发者的本地 CTF 解题管理与 Agent 运行工具。用户可以创建赛事和题目，为同一道题启动多次独立运行，并观察、干预和复盘 Agent 的解题过程。

MVP 必须完成：

1. 管理赛事、题目和可选附件。
2. 在独立本机目录或 Docker 容器中启动 Pi Agent。
3. 实时展示 Agent 消息、思考、工具调用和错误，并允许人工接管。
4. 浏览运行工作区文件。
5. 展示运行、题目和赛事的 Token 消耗统计。
6. 配置模型、供应商和默认执行环境。
7. 定义 CTF 平台接入契约，但不实现具体平台。

## 2. MVP 范围

### 2.1 包含

- 单用户、本地部署，不包含登录和权限系统。
- 赛事的创建、查看、编辑和删除。
- 题目的手工创建、编辑和删除，可带附件。
- 每道题目可创建多次运行。
- 本机目录和 Docker 容器两种执行环境。
- Agent 实时事件、人工消息、暂停、继续和停止。
- 工作区文件树、文本预览和文件下载。
- 运行、题目和赛事的 Token 与费用统计。
- 模型、供应商和默认执行环境配置。
- CTF 平台 TypeScript 契约和无适配器时的不可用状态。

### 2.2 不包含

- 多用户、团队、RBAC、公开分享。
- Kubernetes、远程 Worker、分布式调度和持久化任务队列。
- 具体 CTF 平台适配器、平台连接管理和批量导入实现。
- 浏览器内终端和完整文件编辑器。
- 后台进程跨暂停存续。
- 自动验证本地题目的 Flag、多 Agent 协作和题目版本管理。
- 运行重开、会话分支和终态纠正流程。

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| 赛事 Event | 用户创建的题目集合 |
| 题目 Challenge | 赛事下的一道题，包含名称、描述和可选附件 |
| 运行 Run | 针对一道题的一次独立 Agent 解题尝试 |
| 执行环境 Environment | Agent 工具实际执行的位置：本机工作目录或容器 `/workspace` |
| 平台适配器 Platform Adapter | 对接外部 CTF 平台题目、靶机和 Flag API 的实现 |

## 4. 已确认产品决策

| 决策项 | MVP 选择 |
| --- | --- |
| 用户模型 | 单用户本地应用 |
| 主要部署 | 开发者本机 |
| 进程模型 | API 进程内管理 Agent 运行；Docker 提供隔离边界 |
| 本机 Agent | 按应用进程权限执行命令，不视为安全沙箱 |
| 人工接管 | 人工消息 + 暂停/继续，不提供共享 PTY |
| 成功判定 | Agent 调用 `finish_run` 自报完成 |
| 平台集成 | 只定义契约，不实现适配器和插件系统 |
| 附件处理 | 原始字节复制到工作区，不自动解包 |
| 容器工作区 | 每次运行一个专属宿主目录，bind mount 到 `/workspace` |
| 实时协议 | SSE 推送事件，REST 发送控制命令 |
| 会话来源 | Pi JSONL 保存会话和 usage，SQLite 不复制完整事件流 |
| 前端形态 | Vite SPA |
| 默认容器网络 | `bridge`，MVP 不提供网络模式切换 |

## 5. 用户流程

### 5.1 创建赛事和题目

1. 用户在首页创建赛事。
2. 用户进入赛事概览并添加题目，填写名称、描述和可选附件。
3. 平台导入入口在没有适配器时显示不可用。

### 5.2 启动运行

1. 用户选择题目并创建运行。
2. 用户选择模型和执行环境，默认继承全局配置。
3. 系统创建独立工作目录，将附件原样复制进去。
4. 容器模式将工作目录 bind mount 到 `/workspace`；本机模式直接使用该目录。
5. 系统创建 Pi `AgentSession`，注入题目信息和可用 CTF 工具后发送初始提示词。
6. 前端实时显示 Agent 消息、工具调用和状态。

### 5.3 人工接管

1. 用户可以发送人工消息纠正 Agent。
2. 暂停调用 Pi `abort()`，终止当前模型流和正在执行的前台命令。
3. 继续时向原会话发送新的提示，开始下一轮。
4. 停止后运行进入终态；若仍需解题，创建一次新运行。

Pi 不支持冻结并恢复当前工具调用，因此暂停是中止点，不承诺恢复进程现场。MVP 不允许后台进程跨暂停继续运行。

## 6. 功能需求

### 6.1 赛事管理

- 赛事字段：名称、描述、开始时间和结束时间。
- 首页显示赛事列表并支持创建赛事。
- 可以编辑和删除没有活动运行的赛事。
- 删除赛事时同步删除数据库记录，并在提交后清理附件和工作区目录。
- 文件清理失败时保留到同卷 `.trash`，应用下次启动时再次清理，不引入任务队列。

### 6.2 题目管理

- 题目必填名称和描述，可选分类、分值和附件。
- 附件保留原文件名、大小和 SHA-256。
- 运行创建时逐字节复制附件，不解包、不改写。
- 上传文件名必须拒绝绝对路径、路径分隔符、`.` 和 `..`。
- 工作区中的附件名必须使用安全 basename，避免覆盖已有文件。

### 6.3 平台接入契约

MVP 只定义业务确实需要的接口，不实现注册表、动态加载、capability 系统、平台连接和 fake 适配器：

```ts
interface CtfPlatformAdapter {
  listChallenges(): Promise<RemoteChallenge[]>;
  getChallenge(remoteId: string): Promise<RemoteChallenge>;
  downloadAttachments(remoteId: string): Promise<RemoteAttachment[]>;
  startTarget(remoteId: string): Promise<TargetInfo>;
  stopTarget(remoteId: string): Promise<void>;
  submitFlag(remoteId: string, flag: string): Promise<FlagResult>;
}
```

约束：

- 适配器在宿主进程执行，凭据不能传入提示词、工作目录或容器。
- 网络请求必须有超时，错误不得泄漏凭据和内部堆栈。
- 没有适配器时，批量导入、靶机控制和 Flag 提交明确返回“不可用”。
- 接入首个真实平台时直接实现该接口；只有第二个平台出现实际差异后，再增加注册表或 capability。

### 6.4 运行管理

持久化状态只包含：

```text
running -> paused -> running
running -> completed | failed | stopped
paused  -> stopped
```

规则：

- 每次运行保存启动时实际使用的题目提示词、模型配置和环境配置。
- 同一题目可以创建多次运行。
- API 进程使用内存计数限制同时运行数量；达到上限时拒绝新运行，不建立数据库队列。
- 暂停和停止过程中由 API 返回操作进行中，过渡态不写入数据库。
- 应用启动时将残留的 `running` 运行标记为 `paused`，不自动调用模型或工具。
- `completed`、`failed` 和 `stopped` 是终态；继续解题时创建新运行。

### 6.5 Agent 与 Pi SDK 集成

使用 `@earendil-works/pi-coding-agent` 的 `createAgentSession()`，不重写 agent loop。

使用的能力：

- `AgentSession.prompt()` 启动和继续对话。
- `steer()` / `followUp()` 发送人工消息。
- `abort()` 实现暂停和停止。
- `subscribe()` 获取文本、thinking、工具调用、错误和生命周期事件。
- `customTools` 注册 CTF 工具。
- `SessionManager` 保存 JSONL 会话和 usage。

每次运行提供：

- 环境工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。
- `finish_run(summary, flag?)`：报告完成并结束运行。
- `start_target()`、`stop_target()`、`submit_flag(flag)`：存在平台适配器时调用，否则返回不可用。

工具执行边界：

- 本机模式可以使用绑定到独立 `cwd` 的 Pi 工具。
- 容器模式必须禁用 Pi 默认文件和 shell 工具，注册转发到容器的等价工具，不能留下宿主执行旁路。
- 平台和完成工具始终在宿主进程执行。
- 只支持前台命令；暂停、停止和超时必须终止当前命令进程树。容器模式可以停止容器作为最终回收边界。

初始提示词包含题目名称、描述、可选分类和分值、工作目录约定、附件清单、可用平台能力以及调用 `finish_run` 的完成条件，不包含凭据。

### 6.6 执行环境

本机模式：

- 工作区为 `data/workspaces/<run-id>/`，Pi `cwd` 指向该目录。
- 命令继承应用进程权限和环境变量。
- UI 持续显示“本机执行不是安全沙箱”。

容器模式：

- 每次运行一个容器，工作目录固定为 `/workspace`。
- 专属宿主工作目录 bind mount 到 `/workspace`。
- 默认使用 `bridge` 网络；不提供 `host`、额外挂载或 Docker socket。
- 禁用 privileged、宿主 PID/IPC 和额外 capabilities，启用 `no-new-privileges`。
- 保留 CPU、内存和 PID 限制的配置入口，以适配不同硬件。
- 运行完成、失败或停止后删除容器，保留工作区直到运行被删除。

本机与容器只有两种明确实现，不再为远程环境、第三种容器引擎或动态后端预留抽象。

### 6.7 文件浏览

- 文件树按需加载，不递归扫描整个工作区。
- 支持文本预览和文件下载；二进制文件只显示基本信息。
- 所有路径必须 canonicalize 后验证仍位于运行工作区内。
- 前端不得接触宿主绝对路径。
- MVP 不提供在线编辑、重命名、上传、删除、图片预览或变更摘要。

### 6.8 统计

- 运行详情显示 input、output、cache read、cache write、total tokens 和费用。
- 题目和赛事统计对下属运行做求和，并显示运行次数。
- 统计页提供题目 Token 对比图和运行明细表。
- 数据直接读取 Pi JSONL 中的 assistant message usage；自定义模型无价格时显示“未知”。
- MVP 不实现时间序列、模型分布、复杂筛选和独立 usage 账本。

### 6.9 设置

- 配置内置供应商或 OpenAI-compatible 端点、模型 ID 和 API Key。
- 配置默认本机/容器环境、镜像名、资源限制和最大并发数。
- API Key 存入本地 SQLite；读取接口只返回是否已配置和掩码。
- 设置变更只影响新运行。

## 7. 前端信息架构

技术要求：React、Tailwind CSS v4、coss ui、Zustand。

### 7.1 首页

- 显示赛事列表、创建赛事和设置入口。
- 空状态直接提供创建操作。

### 7.2 赛事页

- 概览：题目网格及各题运行状态。
- 运行：左侧题目/运行树，右侧运行工作区。
- 统计：题目 Token 对比图和运行明细表。

### 7.3 运行工作区

- 概览：状态、模型、环境、时间、Token、费用和完成摘要。
- 对话：Agent 消息、thinking、工具调用和结果；支持人工消息、暂停、继续和停止。
- 文件：文件树、文本预览和下载。

桌面端使用两栏布局；窄屏将左侧树放入 Sheet。所有状态不能只用颜色表达。

### 7.4 状态管理

- TanStack Query 管理服务端数据。
- 当前赛事、运行和 tab 写入 URL。
- Zustand 只保存树展开、分栏尺寸和未发送草稿。
- 当前运行的 Pi 事件通过 SSE 合并进 Query cache；页面刷新后从会话读取历史。

## 8. 系统架构

```text
React Web
   | REST + SSE
Hono API on Bun
   |-- Event / Challenge / Run / Settings routes
   |-- in-process Pi AgentSession manager
   |-- Local tools
   `-- Docker tools -> Docker Engine

SQLite                 Local filesystem
   |-- business data      |-- attachments
   `-- settings           |-- run workspaces
                          `-- Pi JSONL sessions
```

MVP 是单进程模块化单体。Agent 的模型流和工具调用使用异步 API 与子进程，不另设 Worker、数据库任务领取、心跳或 schema 协调。Docker 容器仍是容器模式的安全边界。

建议目录：

```text
src/
  web/
  server/
  agent/
  environments/
  db/
```

先使用普通目录；代码出现第二个真实消费者时再提取 workspace package。

## 9. 核心数据模型

| 实体 | 关键字段 |
| --- | --- |
| events | id, name, description, starts_at, ends_at, timestamps |
| challenges | id, event_id, name, description, category, points, timestamps |
| attachments | id, challenge_id, original_name, storage_key, size, sha256, created_at |
| runs | id, challenge_id, status, prompt, model_config, environment_config, session_path, workspace_path, timestamps, error |
| settings | id, provider, model, credential, environment_config, updated_at |

Pi JSONL 是会话消息和 usage 的唯一事实来源。SQLite 不保存第二份完整 Agent 事件流；`runs` 只保存业务状态和会话路径。

## 10. API 与实时事件

REST 资源：

- `/api/events`
- `/api/events/:eventId/challenges`
- `/api/challenges/:challengeId/attachments`
- `/api/challenges/:challengeId/runs`
- `/api/runs/:runId/{pause,resume,stop,message}`
- `/api/runs/:runId/files`
- `/api/runs/:runId/stats`
- `/api/settings`

当前运行通过 `GET /api/runs/:runId/events` 建立 SSE。服务端直接转发 Pi subscription 事件；状态变更走 REST。MVP 不承诺进程退出期间无损补流，页面刷新或重连后重新读取 Pi JSONL 历史，再接收新事件。

## 11. 安全基线

- API 只监听 loopback，不提供外网绑定配置。
- 校验 Host 和 Origin，不启用宽泛 CORS。
- 状态变更只接受严格 `application/json`；附件流式落盘，不完整缓冲到内存。
- API Key 和平台凭据不能进入提示词、工作区、容器环境或日志。
- 文件名和所有工作区路径必须经过边界校验，系统不自动解包附件。
- 容器不挂载 Docker socket，不使用 privileged，不共享宿主 PID/IPC namespace。
- 容器模式必须替换全部 Pi 默认环境工具，避免宿主执行旁路。
- 工具参数使用 TypeBox schema 验证；错误响应不返回堆栈、绝对路径、凭据或 Flag。
- 明确提示本机模式不是安全沙箱。

## 12. MVP 验收标准

1. 用户可以创建赛事和带附件的题目，重启后数据仍存在。
2. 同一道题可以启动本机和容器运行，工作区相互独立。
3. 容器内工具只能操作 `/workspace`，不能读取宿主数据、凭据或 Docker socket。
4. 前端实时展示消息、thinking、工具调用、结果和错误。
5. 用户可以发送人工消息、暂停、继续和停止。
6. Agent 调用 `finish_run` 后进入 `completed`。
7. 文件页可以安全浏览文本文件并下载文件，路径穿越请求被拒绝。
8. 运行、题目和赛事 Token 汇总与 Pi JSONL usage 一致。
9. 应用重启后可以查看历史会话和文件；残留运行变为 `paused`。
10. 没有平台适配器时，导入、靶机和提交 Flag 明确不可用。

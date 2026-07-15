# AegisX 技术选型

> 状态：初稿
> 日期：2026-07-15
> 关联文档：[需求与技术方案](./requirements.md) | [工作计划](./work-plan.md)

## 1. 结论

AegisX 采用 Bun-first 的 TypeScript 技术栈：Bun 作为包管理器、统一脚本入口、API/Worker 运行时、SQLite 驱动和后端测试运行器。Hono 作为 HTTP 应用层，运行在 Bun.serve 上。

不预先保留 Node.js 后端。Node LTS 仅用于 Vite、Playwright 等以 Node 为正式支持运行时的开发工具，并作为 Pi Worker 的应急回退基础。阶段 0 必须验证 Pi SDK 在锁定 Bun 版本下的兼容性；只有出现无法在合理范围内解决的实证问题时，才将 Agent Worker 单独回退到 Node.js，API 和其他部分仍保持 Bun。

## 2. 完整选型

| 层级 | 选择 | 用途 |
| --- | --- | --- |
| Monorepo | Bun workspaces | 依赖管理、workspace 脚本、锁文件 |
| 语言 | TypeScript strict mode | 前后端、Worker、插件接口共享类型 |
| Web | React + Vite | 本地 SPA、开发 HMR、生产静态资源 |
| UI | Tailwind CSS v4 + coss ui + Lucide | 样式、组件和图标 |
| 路由 | React Router | URL、页面结构和嵌套路由，不使用其 data APIs |
| 服务端状态 | TanStack Query | REST 查询、缓存、失效和重试 |
| 客户端状态 | Zustand | 树展开、布局和草稿等非 URL、非服务端 UI 状态 |
| 图表 | Recharts，阶段 5 引入 | Token、费用、运行时长统计图 |
| HTTP 应用层 | Hono | 模块路由、中间件、统一错误、测试和 typed client |
| HTTP 运行时 | `Bun.serve` | Bun 适配、连接和 per-request timeout |
| 实时事件 | Hono `streamSSE` | Agent 事件推送、心跳、游标补拉 |
| 数据库 | SQLite WAL | 本地规范数据存储 |
| SQLite 驱动 | `bun:sqlite` | 同步事务、prepared statement、WAL |
| Schema/迁移 | Drizzle ORM + Drizzle Kit | 类型化 schema、查询和可审计迁移 |
| 运行时验证 | TypeBox + `@hono/typebox-validator` | REST body、插件 DTO、Agent 工具参数 |
| API Client | Hono client，按领域预编译类型 | 前端 REST 调用；SSE 使用原生 EventSource |
| Agent | `@earendil-works/pi-coding-agent` | AgentSession、模型、事件、会话和自定义工具 |
| Docker | Docker CLI + `Bun.spawn` | 容器 create/start/inspect/stop/rm，不引入 dockerode |
| 本机进程 | `Bun.spawn` / 必要时 `node:child_process` | 命令流、超时、信号和进程组回收 |
| 单元/集成测试 | `bun:test` | 领域、数据库、Pi 和环境契约测试 |
| E2E | Playwright on Node LTS | 浏览器、SSE、本机/容器主流程 |
| Lint/Format | Biome | TypeScript/React lint 和格式化 |
| 类型检查 | TypeScript `tsc --noEmit` | 独立于 Bun transpiler的静态检查 |

依赖使用精确版本并提交 `bun.lock`。仓库同时固定 Bun 和 Node LTS 版本，开发者统一使用 `bun run dev/test/check/e2e`，脚本内部选择正确运行时。升级 Bun、Node、Pi、Hono、Drizzle 或 Docker 交互层时，必须运行阶段 0 定义的兼容契约测试。

## 3. 为什么可以全部使用 Bun

先前选择 Node.js 运行 API/Worker 的依据是 Pi SDK 的官方支持声明，而不是 AegisX 自身需要 Node：

- Pi 0.80.7 的 `pi-ai`、`pi-agent-core` 和 `pi-coding-agent` 均声明 `engines.node >=22.19.0`。
- Pi 的常规 SDK 示例、开发命令和容器示例以 Node/npm 为主。
- Pi 使用大量 `node:fs`、`node:path`、`child_process`、stream 和第三方供应商 SDK。

但进一步核对后，Pi 同时存在明确的 Bun 支持证据：

- `pi-coding-agent` 官方 `build:binary` 使用 `bun build --compile` 构建独立 CLI。
- 仓库包含专用 `src/bun/cli.ts`、Bedrock 注册和 Bun sandbox 环境变量兼容代码。
- Pi 的文件、会话和 Agent API 使用的主要 Node API 在 Bun 中已实现。
- AegisX 会替换 Pi 默认的 shell/文件工具，自行通过 `RunEnvironment` 执行，减少对 Pi 本地 `child_process` 行为的依赖。
- Bun 原生提供本项目正好需要的 HTTP/SSE、SQLite、子进程和测试能力。

因此，“Pi 声明 Node engines”意味着 Bun 不是其 npm SDK 的主支持契约，不等于 Pi 不能在 Bun 上运行。对本地 MVP，更合理的做法是锁定 Bun 版本并用契约测试验证，而不是为尚未出现的兼容问题维护两套运行时。

## 4. Bun 方案的实际风险

### 4.1 Pi SDK 支持声明

直接从 Bun import `@earendil-works/pi-coding-agent` 不在其 `engines` 声明内。Pi 官方 Bun 构建证明核心代码可运行，但不能自动证明所有 SDK 导出、扩展和供应商组合都兼容。

处理方式：阶段 0 建立 AegisX 实际使用面的 smoke test，并固定通过测试的 Pi/Bun 版本。

### 4.2 Node API 兼容并非 100%

Bun 官方仍将 `node:child_process`、`node:process`、`worker_threads` 等部分 API 标记为部分兼容。本项目最敏感的是子进程、信号和进程树终止。

处理方式：

- AegisX 环境工具优先使用 `Bun.spawn`，不依赖 Pi 默认 bash。
- 对本机和容器分别测试 stdout/stderr 流、AbortSignal、10 分钟超时、后台进程和进程组回收。
- macOS 与 Linux 都运行环境契约测试。

### 4.3 供应商 SDK

Pi 依赖 OpenAI、Anthropic、Google、AWS 等 SDK。普通 fetch 型供应商风险较低；Bedrock 等依赖 Node HTTP 栈的供应商风险更高。Pi 的 Bun 入口对 Bedrock 有专门注册逻辑，也说明该区域需要单独验证。

处理方式：默认测试使用 Pi faux provider；阶段 0 至少验证 OpenAI-compatible、Anthropic、Google 的初始化与流式事件，以及 Bedrock 模块可加载性。没有凭据时只做无网络加载测试。

### 4.4 Vite 与 Playwright 的运行时声明

Vite 文档提供 Bun 安装命令，但正式兼容说明仍以 Node 版本为基线；Playwright 也将 Node LTS 列为系统要求。强制二者运行于 Bun 会把兼容风险转嫁给每次升级。

处理方式：依赖仍由 Bun 安装和锁定，Vite 与 Playwright CLI 使用仓库固定的 Node LTS 执行。根脚本封装具体命令，日常开发入口不变。

### 4.5 开发环境便携性

- 固定 Bun、Node LTS 和 Docker 最低版本，不依赖全局 npm 包。
- 提供 `bun run doctor` 检查运行时、Docker daemon、磁盘目录和端口。
- `bun install --frozen-lockfile` 后通过根脚本启动，不要求开发者理解各 workspace 命令。
- macOS 作为主要开发环境，Linux CI 验证运行时、文件权限、进程信号和容器行为。
- 不为 Windows 原生环境承诺本机执行语义；需要时使用 WSL2。

## 5. 为什么选择这些组件

### 5.1 Hono + `Bun.serve`

AegisX 的 HTTP 面已包含多个领域路由、输入验证、统一错误、request ID、SSE、文件流和测试。直接使用 Bun route table 会重复实现中间件与模块组合。Hono 足够小，基于 Web `Request`/`Response`，可在 Bun 上直接运行，也保留未来切换 runtime adapter 的可能性。

约束：

- 按 `events`、`challenges`、`runs`、`files`、`settings` 组织 feature routers，再由根 app 组合。
- handler 只负责 HTTP 映射，业务规则放在可直接测试的 use-case 函数；不创建 controller/repository/mapper 三层模板。
- 使用 Hono request ID、统一错误 envelope 和 TypeBox validator。
- 使用 Hono client 提供类型化 REST 调用；按领域拆分并预编译客户端类型，避免大型 RPC 类型拖慢 IDE。
- Hono typed client 只是编译期类型，不改变 REST 协议；SSE 和文件流使用显式客户端。
- SSE 使用 `streamSSE`；Bun bootstrap 对 SSE 请求调用 `server.timeout(req, 0)`，并继续发送注释心跳。
- 路由测试直接调用 `app.request()`，不监听真实端口。

### 5.2 `bun:sqlite` + Drizzle

`bun:sqlite` 原生支持 prepared statement、事务和 WAL，避免 native addon。直接 SQL 足以执行复杂查询，但项目已有十余张表、迁移和共享 TypeScript 类型；Drizzle 在这里确实减少 schema/迁移重复，而不是隐藏 SQLite。

约束：

- 启动时执行 `journal_mode=WAL`、`foreign_keys=ON` 和 `busy_timeout`。
- `bun:sqlite` 使用 `strict: true`；每个连接都设置 connection-local pragma。
- 事务保持同步且短，不在事务中 await 网络或文件操作。
- 关键队列领取和状态迁移可使用显式 SQL，不强制经过 ORM 高层 API。
- 迁移由启动命令/API 进程唯一执行，Worker 只校验 schema version 后启动。
- 锁定 Drizzle 的稳定精确版本，不使用 beta/RC。
- 备份时正确处理 macOS 上可能持续存在的 `-wal` / `-shm` 文件，先 checkpoint 再复制。

### 5.3 Docker CLI，不选 dockerode

AegisX 只需要稳定的容器生命周期操作，开发者本机已要求安装 Docker CLI。使用 `Bun.spawn(["docker", ...])`：

- 避免额外 Node 客户端和类型依赖。
- 命令可在终端直接复现和排查。
- `docker inspect --format '{{json .}}'` 提供结构化输出。
- bind mount 已消除文件复制 API 需求。

所有容器通过固定 label 关联 run ID，禁止拼接 shell 字符串，参数以 argv 数组传递。

不能把终止 `docker exec` 客户端进程等同于终止容器内命令。默认镜像提供命令包装器：每次执行建立独立进程组并记录 PGID；abort/timeout/pause/stop 通过容器内受控清理命令终止对应进程组，停止运行时再以停止容器作为最终回收边界。本机环境以相同契约跟踪和清理进程组。

### 5.4 TypeBox，不选 Zod

Pi 本身使用 TypeBox 定义工具 schema。AegisX 复用同一种 JSON Schema 表达来验证 HTTP、插件 DTO 和 Agent 工具，避免维护两套验证模型。

数据库 row、请求 DTO 和公开响应分别定义，不从 Drizzle schema 自动暴露 API，避免凭据或内部字段越过边界。

### 5.5 TanStack Query + Zustand

TanStack Query 管理服务端事实以及当前运行的 SSE 增量。赛事、题目、运行、事件和统计不复制进 Zustand。赛事 ID、运行 ID 和 tab 写入 URL；Zustand 只保存跨组件但不属于 URL/服务端的数据，例如树展开、分栏尺寸和未发送草稿。

React Router 只负责 URL 和页面结构，不使用 loader/action 获取业务数据，避免与 TanStack Query 重复。

### 5.6 事件持久化

- 状态、工具开始/结束、错误和运行生命周期事件立即写入 SQLite。
- 高频 text/thinking delta 在 Worker 内按短时间窗或大小合并后批量写入，避免逐 token 放大 WAL 写竞争。
- SSE 读取 SQLite 中的规范事件；前端将增量合并进 TanStack Query cache，不建立第三份事件 store。

### 5.7 Pi SDK 受控集成

- 使用自定义 ResourceLoader、AuthStorage 和 SessionManager 路径。
- 禁止 Pi 默认发现用户 `~/.pi`、项目 extensions、skills、prompt 和 AGENTS.md，除非未来明确开放。
- 显式传入允许的环境工具和领域工具，禁用未注册默认工具。
- Pi、Docker、进程信号和供应商模块使用真实 Bun runtime 契约测试，不只做 mock。

### 5.8 本地 HTTP 安全边界

- MVP 只监听 loopback，不提供外网绑定配置。
- 校验 Host 和 Origin，只允许 AegisX/Vite 本地来源，防止 DNS rebinding 和恶意网页调用本机高权限 API。
- 状态变更端点只接受严格 `application/json` 或指定的原始附件媒体类型，不启用宽泛 CORS。
- 附件采用原始 body 流式落盘，不调用会把整个文件读入内存的通用 form parser。
- 统一错误响应不返回堆栈、绝对路径、凭据或 Flag。

## 6. 不采用

- Node.js 作为默认后端运行时：没有已证实的必要性。
- Redis/消息队列：单机、单 Worker、SQLite 游标足够。
- WebSocket：MVP 没有双向实时协议需求。
- tRPC/GraphQL：REST DTO 和 SSE 已覆盖需求。
- Fastify/Express：Hono 已提供所需应用层能力，并更贴合 Bun/Web 标准。
- dockerode：Docker CLI 已覆盖所需操作。
- Zod：TypeBox 已由 Pi 使用并适合共享 JSON Schema。
- 自研 ORM：Drizzle 已支持 `bun:sqlite`。
- Electron/Tauri：MVP 是本地 Web 应用，没有桌面壳需求。

## 7. 阶段 0 Bun 验证门

只有以下检查全部通过，才宣布“API/Worker 默认使用 Bun”正式成立：

1. Bun 直接 import Pi coding-agent SDK 并创建 faux `AgentSession`。
2. 自定义环境工具能流式返回、响应 abort，并触发 `finish_run`。
3. Pi JSONL 会话可以持久化、恢复、压缩并读取 usage。
4. OpenAI-compatible、Anthropic、Google provider 模块可加载，faux provider 完成确定性对话。
5. 本机和 Docker 命令支持输出流、超时、后台进程跟踪和进程树回收。
6. `bun:sqlite` 在 API/Worker 双进程下通过 WAL 并发、队列领取和 cleanup job 测试。
7. Hono on Bun SSE 通过心跳、Bun per-request timeout、`Last-Event-ID` 和 `after` 断线补拉测试。
8. Node LTS 下的 Vite production build、`bun test` 和 Playwright smoke test 通过。
9. macOS 开发环境和 Linux CI 均通过上述相关检查。

若只有某个供应商不兼容，先将该供应商标记为当前 Bun 版本不支持，不回退整个后端。只有 Pi AgentSession 核心链路无法稳定运行时，才把 `apps/worker` 改为 Node.js 进程；API、数据库模块接口和前端不变。

## 8. 参考依据

- Pi coding-agent package.json: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json
- Pi Bun entry: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/bun
- Pi SDK: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Bun Node compatibility: https://bun.com/docs/runtime/nodejs-compat
- Bun HTTP server: https://bun.com/docs/runtime/http/server
- Bun SQLite: https://bun.com/docs/runtime/sqlite
- Hono Bun: https://hono.dev/docs/getting-started/bun
- Hono streaming: https://hono.dev/docs/helpers/streaming
- Hono testing: https://hono.dev/docs/guides/testing
- Drizzle Bun SQLite: https://orm.drizzle.team/docs/connect-bun-sqlite
- Vite: https://vite.dev/guide/

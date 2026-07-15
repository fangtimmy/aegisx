# AegisX 技术选型

> 状态：初稿
> 日期：2026-07-15
> 关联文档：[需求与技术方案](./requirements.md) | [工作计划](./work-plan.md)

## 1. 结论

AegisX 使用 Bun-first TypeScript 技术栈。Bun 负责依赖、脚本、API 运行时、SQLite 驱动和后端测试；Hono API 在单个 `Bun.serve` 进程内管理 Pi AgentSession。MVP 不设置独立 Worker，也不预设 Node.js 后端回退。

Node LTS 只用于明确要求 Node 的 Playwright CLI，不属于应用运行架构。Pi SDK 是否满足本项目实际调用面由一个最小 smoke test 验证；若核心链路不兼容，应在编码前重新选择单一后端运行时，而不是长期维护条件回退。

## 2. 选型

| 层级 | 选择 | 用途 |
| --- | --- | --- |
| 语言与依赖 | TypeScript strict + Bun | 前后端共享语言、依赖和脚本 |
| Web | React + Vite | 本地 SPA |
| UI | Tailwind CSS v4 + coss ui + Lucide | 样式、组件和图标 |
| 路由 | React Router | URL 和页面结构 |
| 服务端状态 | TanStack Query | REST 查询和 SSE 增量 |
| 客户端状态 | Zustand | 树展开、布局和草稿 |
| 图表 | Recharts | 题目 Token 对比图 |
| HTTP | Hono on `Bun.serve` | REST、SSE、验证和错误处理 |
| 数据库 | `bun:sqlite` + Drizzle | 业务数据、设置和迁移 |
| 验证 | TypeBox + `@hono/typebox-validator` | HTTP 和 Agent 工具参数 |
| Agent | `@earendil-works/pi-coding-agent` | 会话、模型、事件和自定义工具 |
| Docker | Docker CLI + `Bun.spawn` | 容器生命周期和命令执行 |
| 测试 | `bun:test` + Playwright | 逻辑、集成和浏览器主流程 |
| 质量 | Biome + `tsc --noEmit` | 格式、lint 和类型检查 |

依赖使用锁定版本并提交 `bun.lock`。不为未发生的兼容问题建立多运行时适配层。

## 3. 组件边界

### 3.1 Hono + `Bun.serve`

- 按业务功能组织路由，不创建 controller/repository/mapper 模板层。
- handler 负责 HTTP 映射，业务规则放在普通函数中。
- 使用 Hono validator、统一错误响应和 request ID。
- 当前运行的 Pi 事件直接通过 `streamSSE` 转发。
- 页面刷新后从 Pi JSONL 读取历史，不建立 SQLite 事件副本和游标补流系统。

### 3.2 `bun:sqlite` + Drizzle

- SQLite 保存赛事、题目、附件、运行元数据和设置。
- Pi JSONL 保存 Agent 会话和 usage。
- 启用 `foreign_keys`；单进程 MVP 不围绕数据库并发设计队列和协调协议。
- 事务保持短小，不在事务中等待网络或文件操作。
- Drizzle 只负责 schema、普通查询和迁移；复杂查询可以直接使用 SQL。

### 3.3 Docker CLI

AegisX 只需要 create、start、exec、stop 和 rm，直接使用 `Bun.spawn(["docker", ...])`。参数始终以 argv 数组传递，不拼接 shell 字符串。

- 每次运行一个容器和一个 bind mount 工作区。
- 网络固定为 `bridge`。
- 暂停、停止或超时时终止当前命令；容器模式可以停止容器完成回收。
- MVP 不支持后台进程跨暂停存续，因此不实现容器内 PID 登记服务。

### 3.4 TypeBox

Pi 已使用 TypeBox 定义工具 schema，HTTP 边界复用同一种验证方式。数据库 row 与公开响应仍分别定义，避免凭据和内部路径越过 API 边界。

### 3.5 TanStack Query + Zustand

TanStack Query 管理赛事、题目、运行、统计和当前 SSE 增量。赛事 ID、运行 ID 和 tab 写入 URL。Zustand 只保存树展开、分栏尺寸和未发送草稿，不复制服务端数据。

### 3.6 Pi SDK

- 使用 `createAgentSession()`、Pi 会话持久化、usage 和事件订阅。
- 本机模式使用独立 `cwd`；容器模式替换全部默认文件和 shell 工具。
- 平台凭据和模型密钥只留在宿主进程。
- 只支持前台命令，abort/stop 必须终止当前进程树。

### 3.7 本地 HTTP 安全边界

- 只监听 loopback，并校验 Host 和 Origin。
- 不启用宽泛 CORS。
- 附件流式落盘，路径经过 canonical 校验。
- 错误和日志不返回绝对路径、凭据或 Flag。

## 4. 不采用

- 独立 Agent Worker、数据库运行队列和 Worker 心跳。
- SQLite `run_events` / `run_usage` 镜像账本。
- Redis、消息队列、WebSocket、GraphQL 或 tRPC。
- dockerode 和容器内进程登记服务。
- 动态插件加载、capability 框架和 fake 平台子系统。
- Electron/Tauri、Kubernetes 和远程执行环境。
- 多个内部 workspace package；出现第二个真实消费者时再拆分。

## 5. 最小技术验证

编码前只验证四项：

1. Bun 可以创建 faux `AgentSession` 并接收流式事件。
2. 一个自定义 `finish_run` 工具可以结束会话，JSONL 可以重新读取。
3. 本机工具在独立工作目录执行，abort 可以终止当前命令进程树。
4. 容器工具只能操作 bind mount 的 `/workspace`，不能调用 Pi 默认宿主工具。

验证失败时根据实证调整技术选型。供应商矩阵、多操作系统和浏览器兼容性在对应功能落地后按实际支持范围测试，不作为前置认证工程。

## 6. 参考依据

- Pi SDK: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Pi containerization: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md
- Bun Node compatibility: https://bun.com/docs/runtime/nodejs-compat
- Hono Bun: https://hono.dev/docs/getting-started/bun
- Drizzle Bun SQLite: https://orm.drizzle.team/docs/connect-bun-sqlite
- coss ui: https://coss.com/ui/docs/get-started

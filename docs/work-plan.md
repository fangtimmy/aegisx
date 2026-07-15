# AegisX 工作计划

> 状态：初稿
> 日期：2026-07-15
> 依赖文档：[需求与技术方案](./requirements.md)

## 1. 交付策略

采用纵向切片推进：先跑通一条“手工题目 -> 本机 Agent -> 实时对话 -> 完成”的闭环，再增加容器、文件管理、平台接口和统计。每个阶段必须有可运行演示和自动检查，不先搭建暂时没有调用方的抽象。

建议技术基线：

- TypeScript monorepo，Bun 负责依赖、脚本、API/Worker 运行时和测试。
- Vite SPA + React + Tailwind CSS v4 + coss ui + Zustand。
- Bun-first 后端：Hono on `Bun.serve`、`bun:sqlite`、`Bun.spawn`、`bun:test`；Vite/Playwright 使用锁定的 Node LTS。Pi SDK 兼容性在阶段 0 验证，只有 Pi `AgentSession` 核心链路仍无法稳定运行时才将 Worker 单独回退 Node.js，API 始终保持 Bun。
- SQLite 作为规范数据存储，启用 WAL、foreign keys 和 `busy_timeout`。
- Docker Engine 作为容器执行后端。
- REST 处理命令和查询，SSE 处理实时事件。

具体组件按 [技术选型](./technology-selection.md) 执行；阶段 0 验证 Hono、Bun、Pi、Drizzle、Vite 和进程控制兼容性，不重复引入备用技术栈。

## 2. 阶段与验收

### 阶段 0：技术验证

目标：消除 Pi、容器转发和实时事件链路的最高风险。

任务：

- 建立最小 workspace 和统一 lint/typecheck/test 命令。
- 固定 Bun、Node LTS 和 Docker 最低版本，提供 `bun run doctor` 环境检查。
- 按 [技术选型](./technology-selection.md) 建立 Bun API/Worker runtime smoke test。
- 用 Pi faux provider 创建 `AgentSession`，注册 `finish_run` 工具并记录完整事件。
- 验证 `steer`、`abort`、会话持久化、恢复和 usage 读取。
- 实现一次性 Docker spike：宿主 Pi 使用自定义 `read`/`write`/`bash` 工具操作容器 `/workspace`。
- 验证禁用默认工具后不存在宿主执行旁路。
- 验证自定义 Pi ResourceLoader/AuthStorage/SessionManager 不读取用户或项目 Pi 资源。
- 验证 coss ui + Tailwind v4 的 React 工程初始化。
- 验证 SSE `Last-Event-ID` / `after` 补拉、心跳和 SQLite 短轮询延迟。
- 验证 Pi JSONL 到 SQLite 事件/usage 的幂等恢复，不重复展示或计费。
- 验证 Hono request ID、统一错误、Host/Origin 限制、TypeBox 校验和流式附件写入。

验收：

- 一个脚本可用 faux provider 完成工具调用并生成可重放 JSONL 会话。
- 同一测试分别在本机临时目录和容器 `/workspace` 创建文件，宿主其他目录不被容器工具访问。
- `abort` 后可以从同一会话发送新提示并继续。
- 前端能渲染一组录制的 Pi 事件。

预计：2-3 个开发日。

### 阶段 1：赛事与题目闭环

目标：完成持久化管理和手工题目录入。

任务：

- 建立数据库 schema、迁移和开发数据命令。
- 确保迁移只有一个执行者，Worker 在 schema version 就绪后启动。
- 实现赛事 CRUD、归档、搜索和删除确认。
- 实现活动运行删除保护和持久化 `cleanup_jobs`。
- 实现题目 CRUD、多附件上传、哈希和安全存储。
- 实现赛事列表、赛事页框架、概览题目网格。
- 实现附件原样复制和安全文件名校验；不自动解包附件。

验收：

- 可从 UI 创建赛事和带多个附件的题目。
- 服务重启后数据与附件可读。
- 附件复制前后 SHA-256 一致；路径型文件名和重复文件名被拒绝，UI 显示磁盘空间警告。
- API 与前端类型检查、核心用例测试通过。

预计：3-4 个开发日。

### 阶段 2：本机 Agent 运行

目标：打通首条完整解题链路。

任务：

- 实现 Run 状态机、数据库队列领取和 Worker 心跳。
- 创建每运行独立工作目录和不可变运行快照。
- 集成 Pi `AgentSession`、题目提示词和内置编码工具。
- 实现 `finish_run` 工具和完成摘要。
- 持久化 Pi 事件与 usage，建立按序补拉 API。
- 即时写入生命周期/工具事件，短暂合并 text/thinking delta 后批量写入。
- 实现运行树、运行概览和实时对话。
- 实现 steer、暂停、继续、停止和重新打开。
- 实现前台命令默认 10 分钟超时及进程树终止。
- 记录人工文件变更路径，并在 resume 时注入摘要。

验收：

- 两个并发本机运行使用不同工作区和会话文件。
- Agent 可读取附件、调用工具并通过 `finish_run` 完成。
- 浏览器断线重连后无事件丢失或重复展示。
- 高频输出下 SQLite 不逐 token 提交，事件展示 P95 仍小于 500 ms。
- 非法状态转换和重复控制命令可预测且幂等。
- Worker 被强制终止后，运行会被识别为 interrupted。
- interrupted 运行不会自动继续，必须由用户重新打开并显式 resume。
- completed 运行可人工标记失败；completed、failed、stopped 和 interrupted 均可重新打开为 paused，再显式继续。

预计：5-7 个开发日。

### 阶段 3：容器环境与文件工作区

目标：提供默认推荐的隔离运行环境。

任务：

- 构建基于 Kali Rolling 的默认镜像，并实现 `DockerEnvironment` 生命周期。
- 默认镜像保持最小工具集，使用非 root 用户并提供容器内免密 sudo。
- 默认设置 4 CPU、8 GiB 内存、512 PIDs 和 bridge 网络，允许配置网络模式及资源限额。
- 将每运行专属宿主工作目录 bind mount 到容器 `/workspace`。
- 将 Pi 文件、搜索、编辑和 shell 环境工具转发到环境接口；领域工具保留在宿主 Worker。
- 实现工作区文件树、范围读取、图片预览和暂停态编辑。
- 实现附件/工作区占用和宿主剩余空间展示，不设置硬配额。
- 允许并按运行跟踪后台进程，暂停、停止和删除时统一回收。
- 实现容器停止、删除、遗留容器恢复和工作区保留策略。
- 对容器逃逸配置、路径逃逸和符号链接进行测试。

验收：

- 容器内工作目录固定为 `/workspace`，附件可见。
- 附件内容未经转换或解包，bind mount 中的修改可由文件页立即读取。
- Agent 工具不能读取宿主 AegisX 数据目录、凭据或 Docker socket。
- CPU、内存和 PID 限额实际生效。
- bridge、none 及平台支持时的 host 网络模式行为可验证。
- 运行完成、失败或停止后容器删除，工作区仍可浏览。
- 本机和容器运行共用相同前端与 Agent 事件协议。

预计：5-7 个开发日。

### 阶段 4：平台插件契约

目标：证明插件接口可用，但不接入真实平台。

任务：

- 实现插件类型、本地包静态注册表、capability 和结构化错误。
- 实现平台连接配置、SQLite 明文凭据存储和掩码读取。
- 实现批量导入应用服务和幂等策略。
- 实现 `start_target`、`stop_target`、`get_target`、`submit_flag` Agent 工具。
- 编写内存 fake 插件，覆盖题目、附件、靶机和 Flag 流程。
- fake DTO 和测试场景参考 CTFd API 语义，避免通用接口与首个平台方向脱节。
- 实现无插件、缺少 capability 和插件失败的 UI 状态。

验收：

- fake 插件可批量导入题目及附件，重复导入不重复创建。
- Agent 可启动/停止 fake 靶机并提交 Flag。
- stopped 或删除运行时自动回收 fake 靶机；completed/failed 时保留，直到用户显式停止。
- 插件凭据不出现在提示词、工作区、容器环境、事件和日志中。
- 插件超时或失败不会破坏 Agent 会话，可由 Agent 或用户重试。

预计：3-4 个开发日。

### 阶段 5：统计与设置

目标：完成配置和复盘能力。

任务：

- 实现供应商、模型、默认环境和并发设置。
- 实现自定义 OpenAI-compatible 模型配置和连通性检查。
- 聚合运行、题目、赛事 usage、费用、时长和结果。
- 实现统计图表、明细表、筛选和空价格状态。
- 对话中的 thinking/reasoning 默认折叠，并保留供应商实际返回内容。
- 校验设置快照只影响新运行。

验收：

- 可配置至少一个真实供应商和一个自定义兼容端点。
- 运行创建后修改全局设置，不改变该运行配置。
- 统计聚合与会话中的 assistant usage 逐条核对一致。
- 未配置价格的模型不显示错误的零费用。

预计：3-4 个开发日。

### 阶段 6：稳定性与发布准备

目标：达到可持续本地使用的质量基线。

任务：

- 覆盖关键端到端流程和失败恢复。
- 完成日志脱敏、多附件上传、原样复制、文件路径和容器配置安全检查。
- 完成键盘操作、焦点、状态文本和窄屏布局检查。
- 验证数据库备份恢复、持久化清理任务重试和遗留容器清理。
- 编写本地安装、开发、配置、升级和故障排查文档。
- 固定依赖版本并执行供应链审计。

验收：

- 从空数据库到完成一次本机和容器运行的 E2E 测试通过。
- Vite 和 Playwright 在锁定的 Node LTS 下通过，API/Worker 在锁定的 Bun 下通过。
- API/Worker 意外退出后历史数据完整，运行进入明确可恢复状态。
- 密钥和 Flag 不出现在应用日志与前端通用错误中。
- 桌面和窄屏关键页面无溢出、遮挡和不可操作控件。
- 新环境按文档可在 15 分钟内启动应用。

预计：3-5 个开发日。

## 3. 建议任务顺序

```text
Pi spike
  -> 数据库与领域模型
  -> 赛事/题目 UI
  -> Run 状态机与 Worker
  -> 本机 Environment
  -> 实时对话与控制
  -> Docker Environment
  -> 文件工作区
  -> 平台插件 fake
  -> 设置与统计
  -> 恢复、安全和 E2E
```

关键路径是 Pi spike -> Run 状态机 -> 工具转发 -> 实时事件。统计和真实平台适配不应阻塞核心解题闭环。

## 4. 测试策略

### 4.1 单元测试

- Run 状态转换。
- 提示词构建和秘密值排除。
- 平台 DTO 映射与 capability 检查。
- 工作区路径解析、附件安全文件名和字节一致性规则。
- Token/费用聚合。

### 4.2 集成测试

- SQLite 单 Worker 队列领取、并发短事务、幂等命令和事件序号。
- Hono feature router、TypeBox 边界验证、统一错误和 Host/Origin 拒绝测试。
- Pi faux provider + 自定义工具 + JSONL 会话恢复。
- LocalEnvironment 和 DockerEnvironment 契约测试。
- fake 平台导入、靶机和 Flag 流程。
- SSE `Last-Event-ID` / `after` 断线补拉、心跳和事件顺序。

### 4.3 端到端测试

- 创建赛事和题目 -> 上传附件 -> 启动本机运行 -> steer -> 暂停 -> 继续 -> 完成。
- 启动容器运行 -> 浏览 Agent 生成文件 -> 停止 -> 重启应用 -> 查看历史。
- 修改模型设置 -> 创建新运行 -> 验证旧运行快照不变。

真实模型调用不进入默认 CI；默认测试使用 Pi faux provider，真实供应商只做手工 smoke test。

## 5. 风险清单

| 风险 | 影响 | 前置验证 / 缓解 |
| --- | --- | --- |
| Pi 默认工具绕过容器 | 严重，宿主暴露 | 阶段 0 禁用默认工具并做负向测试 |
| 本机模式拥有用户权限 | 严重，读取本机数据 | UI 持续警告；后续可改为默认容器，但 MVP 接受已确认风险 |
| 暂停不是进程现场恢复 | 中等，命令可能部分执行 | 将暂停定义为 abort；记录中断事件；继续从新一轮开始 |
| Worker 崩溃产生孤儿容器 | 中等，资源泄漏 | 心跳、启动时 reconciliation、按 run label 清理 |
| 终止 docker exec 后容器内进程继续运行 | 严重，暂停/停止失效 | 容器内进程组记录与清理命令，停止容器作为最终回收边界 |
| 实时流断线丢事件 | 中等，审计不完整 | 事件先持久化，seq 游标补拉 |
| 高频 delta 放大 SQLite 写竞争 | 中等，延迟或锁冲突 | 生命周期事件立即写，text/thinking delta 短窗合并批写 |
| 附件或工作区耗尽磁盘/路径穿越 | 严重，运行失败或文件破坏 | 占用与剩余空间告警、canonical path、安全文件名和异步清理 |
| 模型 usage 或价格缺失 | 低，统计不准 | 保存原始 usage；未知费用显示未知 |
| Pi SDK 快速变化 | 中等，集成破坏 | 固定版本；Agent runtime 包集中适配；升级跑契约测试 |
| 平台插件泄漏凭据 | 严重，账号泄漏 | 凭据虽在 SQLite 明文存储，但只进入宿主 context；日志统一脱敏；fake secret 测试 |
| 恶意网页调用本机高权限 API | 严重，命令执行或数据破坏 | 仅 loopback、Host/Origin allowlist、严格 Content-Type、不开放 CORS |
| Kali Rolling 更新破坏工具链 | 中等，镜像不可复现 | 固定基础镜像 digest，按计划更新并运行环境契约测试 |

## 6. 完成定义

每个任务只有同时满足以下条件才算完成：

- 行为符合需求和状态机。
- 有覆盖失败路径的最小自动测试。
- 类型检查、lint 和相关测试通过。
- 数据迁移可前向执行，破坏性变更有说明。
- 错误可被用户理解，日志包含定位所需 ID 且不泄漏秘密。
- 前端在桌面和窄屏下可操作，键盘与焦点行为正确。
- 文档随接口或运维行为同步更新。

## 7. 已确认技术决策

MVP 的关键产品与运行决策已写入需求文档。首个平台方向为 CTFd，阶段 4 仅使用 fake 插件校验契约，不实现真实适配器。

## 8. 粗略总工期

单人顺序开发约 24-34 个开发日，不含真实 CTF 平台适配器和不可预见的 Pi/Docker 兼容问题。阶段 0 结束后应基于 spike 结果重新估算，避免在最关键技术假设尚未验证时承诺固定日期。

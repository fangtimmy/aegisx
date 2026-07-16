# Run 内多 Agent 编排

## 目标

一次 Run 包含一个主 Agent 和零个或多个子 Agent。主 Agent 可以在解题过程中后台创建子 Agent，继续自己的工作，并在子 Agent 完成后收到其最后一条输出。前端在 Conversation 下按 Agent 展示独立会话。

## 核心约束

- 每个 Run 只有一个主 Agent。
- 只有主 Agent 可以创建子 Agent 和调用 `finish_run`。
- 子 Agent 不能创建孙 Agent。
- 子 Agent 后台并行运行，使用 Run 的模型、凭据和执行环境。
- 用户消息只发送给主 Agent。
- 暂停、恢复、停止和完成统一作用于 Run 下所有非终态 Agent。
- `maxConcurrency` 统计活跃 Agent 实例，而不是 Run 数量。

## 工作区

主 Agent 使用 Run 工作区根目录。子 Agent 使用以下工作目录：

```text
本机：<workspace>/agents/<agent-id>
容器：/workspace/agents/<agent-id>
```

子目录是协作式隔离，不是安全边界。子 Agent 可以读取整个 Run 工作区，但提示词要求只把产物写入自己的目录。本机模式仍继承应用进程权限；容器模式仍以 Run 的单个受限容器作为安全边界。

## 创建与通信

主 Agent 拥有两个工具：

- `spawn_agent(name, task)`：创建子 Agent，Session 启动后立即返回 Agent ID，不等待任务完成。
- `inspect_agent(agent_id)`：查询子 Agent 状态、错误和最后一条输出摘要。

子 Agent 完成后，服务端保存其最后一条 assistant 文本。如果主 Agent 正在生成，使用 `steer()` 注入结果；如果主 Agent 空闲，使用 `prompt()` 启动新一轮。完整历史保留在子 Agent 的 Pi JSONL 中，自动回传内容限制长度。

## 持久化

`runs` 继续保存题目、模型、环境、工作区和 Run 级状态。新增 `run_agents` 保存：

- Agent ID、Run ID、父 Agent ID和名称。
- 委派任务、状态和错误。
- 独立 Pi JSONL 会话路径。
- 最后一条输出摘要和时间戳。

迁移时，现有 Run 的会话路径回填为主 Agent 记录。Run usage 是所有 Agent usage 之和。

## 生命周期

- 创建 Run 时同步创建主 Agent 数据行。
- 创建子 Agent 时先占用并发槽，再异步启动 Session。
- 子 Agent 正常结束只结束自身，并把结果交给主 Agent。
- 子 Agent 失败只标记自身失败，不直接令 Run 失败。
- 暂停会中断所有运行中的 Agent 并标记为暂停。
- 恢复前必须确保有足够容量恢复所有暂停 Agent，不允许部分恢复。
- 停止或完成 Run 会终止所有非终态子 Agent。
- 服务重启后，残留的运行中 Run 和 Agent 统一变为暂停，不自动调用模型或工具。

## API 与事件

Run 详情返回 Run、Agent 元数据和聚合 usage。单个 Agent 详情接口返回该 Agent 的历史与 usage。

SSE 使用带 Agent ID 的事件 envelope：

```ts
type RunEvent =
  | { type: "status"; run: RunPublic }
  | { type: "agent_status"; agent: AgentPublic }
  | { type: "agent_event"; agentId: string; event: AgentSessionEvent }
```

前端按 `agentId` 隔离 live entries，避免不同 Session 的消息和工具调用相互污染。

## 前端

Conversation 内增加 Agent Tabs：

- 默认选择主 Agent，选择写入 `?agent=<agent-id>`。
- Tab 显示 Agent 名称和状态。
- 历史按选中的 Agent 按需读取。
- 新子 Agent 出现时增加 Tab，但不强制切换。
- 消息输入框只在主 Agent Tab 显示。
- Run 级暂停、恢复和停止控制所有 Agent。

## 首版不做

- 孙 Agent 和任意深度 Agent 树。
- 子 Agent 独立模型、环境或权限配置。
- Agent 独立暂停、停止和人工消息。
- 强制文件写隔离、完整工作区副本或每 Agent 独立容器。
- 黑板、共享聊天、平等 Agent 或固定专家角色系统。

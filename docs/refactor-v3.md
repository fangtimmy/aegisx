# AegisX v3 重构方案

Status: **已实施（v3 现状见 [architecture.md](./architecture.md)）**
Last updated: 2026-07-29
相关：[architecture-v2.md](architecture-v2.md)（v2，将被本版替换）

## 一、目标与核心转变

把 agent 运行方式从「AegisX 服务进程内自写 agent loop + `docker exec` 工具调用」改为「**容器主进程跑 pi 交互式 TUI，前端 ghostty-web 直渲 TTY 并可接管**」。

| 维度 | v2（现状） | v3（目标） |
|---|---|---|
| agent loop | 服务端自写（pi-agent-core + pi-ai） | 容器内 pi（交互式 TUI） |
| 工具执行 | `docker exec` 每次调用 | pi 内建工具，在容器内执行 |
| 前端展示 | SSE 拉消息渲染 timeline | ghostty-web 渲染 pi 的 TTY |
| 接管 | 不支持 | 用户直接在同一 TTY 打字（pi 运行中 steer） |
| 多 agent | 一主 + N 子 | **单 agent**（一 Run = 一容器 = 一 pi） |
| 运行环境 | local / container | **仅 Docker** |
| submit_flag / target / finish | pi 内建工具 | 容器内通过 **skill + HTTP API** 回调 AegisX |
| 消息存储 | SQLite `messages` 表 | pi jsonl session（不入库） |
| 会话续接 | 无 | resume = 新容器 + `pi --session <id>` 续同一会话 |

服务端职责收窄为：**编排容器生命周期、生成 pi 配置（models.json/skills/auth）、提供 run 级 HTTP API、PTY 桥接、持久化 pi session**。DB 为权威。

## 二、确认的关键决策（已与用户对齐）

1. **pi 启动与接管**：容器主进程跑交互式 `pi`；前端 ghostty-web 直渲该 TTY；接管 = 用户直接在同一 TTY 打字。
2. **初始 prompt**：用 pi 的位置参数 `pi "<prompt>"`（Interactive with initial prompt），**不**用 `-p`（那是非交互 print-and-exit），**不**用 stdin 注入。
3. **finish_run**：agent 调 `aegisx-finish` skill → POST `/api/runs/:id/finish` → 服务端 SIGTERM pi → pi 存 session 退出 → 容器停 → `container.wait()` resolve → run=completed。**服务端掌握生命周期、DB 权威。**
4. **usage/统计**：MVP **省略**（Overview 不显示 token/cost），二期再解析 jsonl 补回。
5. **pi session 持久化**：每个 Run 一个**独立挂载卷**承载 `~/.pi/agent`（含 sessions/models.json/skills/auth），容器停止后 jsonl 留在卷里；resume 时 `pi --session <id>` 续同一会话。
6. **供应商/模型设置**：**不改数据结构与 UI**（保留现有 `ProviderConnection`/`ProviderModel` 及 `piBinding` 绑定 pi 内置模型的能力）；只在起 Run 前**生成** pi 格式 `models.json`。
7. **依赖**：加 `dockerode`、`ghostty-web`；删 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`；**保留 `handlebars`**（提示词模板继续用）。
8. **容器回连**：`AEGISX_API_URL=http://host.docker.internal:3000`，加 `--add-host=host.docker.internal:host-gateway`（OrbStack 已原生支持 host.docker.internal）。
9. **data 全量 wipe**：删 `data/aegisx.sqlite*`、旧 `data/workspaces/`、`data/config.json*`；从空库 `data/runs/` 起步。
10. **launcher 参数化**：runs 表加 `launcher` 字段（MVP 取值 `'pi'`）；container-manager 按 launcher 拼主进程命令 + 生成 sidecar。后续接 claude-code/codex 只加新分支。

## 三、架构与数据流

```
┌─────────────── Browser ───────────────┐
│  ghostty-web  ⇄  WS transport          │
└───────────────┬────────────────────────┘
                │ /api/runs/:id/pty  (binary WS: stdin/stdout bytes + resize 帧)
┌───────────────▼────────────────────────┐
│           AegisX server (Hono/Bun)      │
│  run-service · container-manager        │
│  (dockerode) · pty-bridge · models-json │
│  generators(skills/auth) · http api     │
└───────────────┬────────────────────────┘
                │ dockerode: create/start/wait/kill/attach/resize
┌───────────────▼────────────────────────┐
│   Docker container (solver image)       │
│   主进程: pi (interactive TUI)           │
│   /workspace         ← workspace 卷      │
│   /root/.pi/agent    ← pi-agent 卷       │
│   skill scripts → curl $AEGISX_API_URL   │
└──────────────────────────────────────────┘
```

### Run 生命周期（服务端权威）

1. `POST /api/challenges/:id/runs`
   → 建 `data/runs/<id>/`（workspace/ + pi-agent/）
   → 拷题目附件到 workspace/
   → 生成 pi-agent 卷内容：`models.json`、`skills/aegisx/`、`auth.json`
   → dockerode 创建+启动容器（主进程 `pi`，env 注入 `AEGISX_API_URL`/`AEGISX_RUN_ID`/`AEGISX_CHALLENGE_*`）
   → run.status = `running`
2. PTY WS `/api/runs/:id/pty` 双工桥接：browser ⇄ dockerode 双工流，转发字节 + resize。
3. finish（agent 主动 or 用户 Stop）
   → `POST /api/runs/:id/finish {summary}`
   → 服务端 `container.kill({signal:'SIGTERM'})` → pi 存 session 退出 → 容器停
   → `container.wait()` resolve → run.status=`completed`，落 summary
4. resume 停止的 Run
   → 新容器 + `pi --session <sessionId>` 续同一会话（jsonl 在 pi-agent 卷里持续存在）
   → run.status=`running`

## 四、容器管理（dockerode）

替换 `infrastructure/container.ts`（docker CLI 封装）与 `run/container-pool.ts`、`run/session.ts`。

**为什么用 dockerode**：PTY 流（exec/attach + `Tty:true` hijack 双工流）、`exec.resize({h,w})`、`container.wait()` 监听 pi 退出、生命周期 create/start/kill/remove 全部干净。docker CLI 拼 PTY 很脏。

`apps/server/src/run/container-manager.ts` 职责：
- `create({runId, image, cpus, memoryMb, pidsLimit, mounts, env, cmd})` → 创建+启动容器
- `attach(runId)` → 返回双工流（stdin/stdout/stderr 合一，Tty:true）供 pty-bridge 用
- `resize(runId, {cols, rows})` → `exec.resize` / container resize
- `wait(runId)` → `container.wait()`，resolve 时触发 run 收尾
- `kill(runId, signal)` / `remove(runId)`

容器创建参数（关键）：
- `Image`: solver 镜像（默认 settings `container.image`）
- `Cmd`: `["pi", ...flags, "<bootstrap prompt>"]`（见 §五）
- `WorkingDir`: `/workspace`
- `Tty: true`, `OpenStdin: true`, `AttachStdin/Stdout/Stderr: true`
- `HostConfig`:
  - `Binds`: `["<workspace>:/workspace", "<pi-agent>:/root/.pi/agent"]`
  - `NanoCPUs`/`Memory`/`PidsLimit`（来自 run 配置）
  - `CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges"]`, `IpcMode: "none"`
  - `Tmpfs`: `{"/tmp": "rw,nosuid,nodev,noexec,size=<tmpfsSize>"}`
  - `ExtraHosts`: `["host.docker.internal:host-gateway"]`
- `Env`: `AEGISX_API_URL`、`AEGISX_RUN_ID`、`AEGISX_CHALLENGE_ID`/`AEGISX_CHALLENGE_NAME`（skill 脚本用）

> 注：现有镜像 `CMD ["sleep","infinity"]` 由 dockerode 的 `Cmd` 覆盖；镜像不用改。

## 五、pi 启动命令

交互式 + 初始 prompt（位置参数）。dockerode 以 argv 数组传参（exec 风格，**不经 shell**），故多行 prompt 无需转义。主系统提示改用 **文件** 注入（避免长 CLI 参数）。拼装：

```js
// dockerode Cmd 数组（argv，无 shell 转义）
["pi",
  "--approve",                       // 跳过 project trust 交互提示
  "--no-context-files",             // 不加载 workspace 的 AGENTS.md/CLAUDE.md
  "--tools", "read,bash,edit,write,grep,find,ls",  // 启用全部内建工具
  "--model", "<provider>/<modelId>:<thinking>",
  "--name", "<challenge name>",
  "<rendered initial prompt>"]      // 位置参数 = 初始 prompt
```

要点（已对照 pi 文档验证）：
- **位置参数 = 初始 prompt**：`pi "<prompt>"` 是 Interactive-with-initial-prompt 模式，pi 启动后自动提交并开跑。**不用 `-p`**（那是 print-and-exit 非交互）。
- **主系统提示用文件**：渲染后写入 `pi-agent/APPEND_SYSTEM.md`（pi 全局追加系统提示文件，见 settings.md「System Prompt Files」）。**不**用 `--append-system-prompt`（长多行内容走 argv 仍可，但文件更干净、可审计）。子 agent 模板不再需要（无多 agent）。保留现有 `settings/prompt-templates.ts` 的 handlebars 渲染逻辑，只是输出目标从「内存喂 pi-ai」改为「写 APPEND_SYSTEM.md」。
  - 注意：`APPEND_SYSTEM.md` 属于 System Prompt File，**不受** `--no-context-files` 影响（后者只禁 AGENTS.md/CLAUDE.md）。
- `--model "<provider>/<modelId>:<thinking>"`：`provider` 用 models.json 的 provider key；`<thinking>` ∈ off/minimal/low/medium/high/xhigh/max。
- `--tools`：pi 默认只开 read/write/edit/bash；显式加上 grep/find/ls（solver 里 rg/fd 都有）。
- `--approve`：跳过 project trust 提示（自主运行不能卡 yes/no）。配合 settings.json 的 `defaultProjectTrust:"always"` 双保险。
- `--no-context-files`：题目 workspace 无项目约定，不加载其 AGENTS.md。若要把 ENVIRONMENT.md 等喂 agent，由 prompt 模板引用或生成到 workspace。
- **resume**：`pi --approve --no-context-files --tools ... --model "<...>" --session "<sessionId>"`（**不带**位置 prompt，仅续接）。`--session <id>` 支持 partial UUID 偏匹配；sessionId 存 runs 表。`--session-dir` 可省（sessions 默认落挂载卷内 `/root/.pi/agent/sessions`）。

## 六、Per-run 目录与挂载

```
data/runs/<runId>/
  workspace/            → bind /workspace
    <题目附件>
  pi-agent/             → bind /root/.pi/agent  (per-run, 持久)
    models.json         ← 服务端生成 (§七), apiKey 字面量写入即可覆盖 auth
    APPEND_SYSTEM.md    ← 服务端生成 (渲染后的主系统提示, §五)
    settings.json       ← 服务端生成 (见下)
    skills/aegisx/      ← 服务端生成 (§八)
    sessions/*.jsonl    ← pi 运行时自写 (持久, 供 resume)
```

**生成的 `pi-agent/settings.json`**（关键项）：
```json
{
  "defaultProjectTrust": "always",
  "quietStartup": true,
  "enableInstallTelemetry": false,
  "enabledModels": ["<provider>/<modelId>"],
  "compaction": { "enabled": true }
}
```
配合容器 env：`PI_OFFLINE=1`（禁启动期网络：更新检查/telemetry）、`PI_SKIP_VERSION_CHECK=1`。

**Auth（已对照 providers.md「Resolution Order」验证）**：凭据解析优先级为 CLI `--api-key` > `auth.json` > 环境变量 > models.json provider `apiKey`。容器内无 `auth.json`、无凭据环境变量（我们控制 env），故 **models.json 里 provider 的 `apiKey` 字面量即生效**，无需额外 auth.json。`piBinding` 绑定内置 provider 时，在同一内置 provider key 下写 `apiKey` 同样有效。

环境变量兜底：也可用 `PI_CODING_AGENT_DIR=<path>` 重定位整个 `~/.pi/agent`（若想塞进 /workspace 单挂载）。MVP 用双挂载（workspace + pi-agent），结构最清晰。

## 七、models.json 生成（不改供应商/模型设置）

**数据结构/UI 不动**：保留 `ProviderConnection`/`ProviderModel`（`apps/shared/provider.ts`）与 `features/settings/` 的 provider/model 编辑器、`piBinding` 绑定 pi 内置模型的能力。

新增 `apps/server/src/providers/models-json.ts`：

```ts
export function generateModelsJson(providers: ProviderConnection[]): PiModelsJson
```

- 仅导出 `enabled` 的 provider 与 model。
- `piBinding` 非空（绑定 pi 内置模型 `{providerId, modelId}`）：
  - 输出 `{ "providers": { "<内置 providerId>": { "baseUrl"?, "apiKey"?, "headers"?, "modelOverrides": { "<modelId>": { ...可选覆盖 } } } } }`
  - 或仅依赖内置模型 + provider 级 `baseUrl`/`headers`/`apiKey` 注入（路由到代理）。
- `piBinding` 为空（完全自定义模型）：
  - 输出 `{ "providers": { "<自定义 key>": { "baseUrl", "api": <由 type 映射>, "apiKey", "headers"?, "compat"?, "models": [ { id, name, reasoning, input, cost, contextWindow, maxTokens, thinkingLevelMap?, compat? } ] } } }`
- `type` → `api` 映射：`openai-compatible → openai-completions`、`openai-responses → openai-responses`、`anthropic-messages → anthropic-messages`（与现有 `providerApi()` 一致）。
- `apiKey` 按字面量写入（按 AGENTS.md 不脱敏）。
- `metadata`（`ModelMetadata`）字段平铺到 pi 的模型字段（cost/contextWindow/maxTokens/reasoning/input/thinkingLevelMap/headers/compat）。

删除：`providers/models.ts`（pi-ai `MutableModels` registry）—— 不再需要把模型喂给 pi-ai。

## 八、skills + run 级 HTTP API（submit_flag / target / finish）

容器内 pi 无内建 submit_flag/target/finish 工具，改用 **skill 文档 + helper 脚本** 调 AegisX HTTP API。

### 8.1 生成的 skill（`pi-agent/skills/aegisx/`）

```
aegisx/
  SKILL.md             # 文档: 何时调、怎么调
  bin/aegisx-submit-flag   # curl POST /api/runs/$AEGISX_RUN_ID/flag
  bin/aegisx-target       # curl POST /api/runs/$AEGISX_RUN_ID/target/{get|start|extend|stop}
  bin/aegisx-finish       # curl POST /api/runs/$AEGISX_RUN_ID/finish
```

helper 用 `$AEGISX_API_URL` + `$AEGISX_RUN_ID`（容器 env 注入）发 curl。SKILL.md 描述：
- 提交 flag：`aegisx-submit-flag "<flag>"`，返回 accepted/rejected/...
- 控制靶机：`aegisx-target start|stop|extend|get`
- 结束 run：`aegisx-finish "<summary>"`（调完后 pi 会被服务端优雅停止）

### 8.2 新增 run 级 HTTP 端点（容器调用）

复用现有 `platforms/submissions.ts`、`platforms/targets.ts` 逻辑，加薄封装：

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/runs/:runId/flag` `{flag}` | submit → `platformService.submitFlag` |
| POST | `/api/runs/:runId/target/get\|start\|extend\|stop` | → `platformService.targetAction` |
| POST | `/api/runs/:runId/finish` `{summary}` | 记录 summary → 优雅停止 pi/容器 → run=completed |

现有平台端点（`/api/challenges/:id/target/*` 等）保留不变（前端挑战详情仍用）。

### 8.3 finish 优雅退出流程

```
agent 调 aegisx-finish
  → helper POST /api/runs/:id/finish {summary}
  → 服务端: run.pendingFinishSummary = summary
  → container.kill({signal:'SIGTERM'})
  → pi 收 SIGTERM, 存 session, 退出
  → 容器停止 → container.wait() resolve
  → 服务端: run.status=completed, run.summary=summary, run.completedAt=now
```

用户手动 Stop 走同一 kill 路径（summary 留空）。

**SIGTERM 优雅性已由文档确认**：extensions.md 生命周期明确列出 `exit (Ctrl+C, Ctrl+D, SIGHUP, **SIGTERM**) → session_shutdown`，即 SIGTERM 触发 pi 的优雅关闭路径（发 `session_shutdown` 事件 → 存 session → 退出）。故 SIGTERM 是正确信号，无需实测风险。

> 备选（更干净，未来可选）：写一个 AegisX pi 扩展，注册 `finish_run` 内建工具，在 execute 里调 HTTP API 后调 `ctx.shutdown()`（交互模式下延迟到 agent idle 后优雅退出）。MVP 仍按用户要求用 **skill + 服务端 SIGTERM**。

## 九、数据库 schema v3（wipe）

**保留**：`events` / `eventPlatforms` / `challenges` / `challengeRemote` / `attachments` / `submissions` / `platformRequestLog`。

**重做 `runs`**（精简）：

| 列 | 说明 |
|---|---|
| id, challengeId | |
| status | `running \| completed \| failed \| stopped` |
| launcher | `'pi'`（MVP；参数化主进程） |
| provider, modelId, thinkingLevel | 选定模型快照 |
| image, cpus, memoryMb, pidsLimit | 容器资源（envJson 取代） |
| containerName | dockerode 容器名 |
| workspacePath | `data/runs/<id>/workspace`（相对 dataDir） |
| piSessionId, piSessionFile | pi jsonl session 标识（供 resume） |
| createdAt, startedAt, updatedAt, completedAt | |
| error, summary, flag | |

**删除整表**：`agents`、`messages`、`agentUsage`（usage 二期再从 jsonl 解析）。

Wipe：删 `data/aegisx.sqlite*`、旧 `data/workspaces/`、`data/config.json*`；schema `user_version=3`，旧库拒开。`SCHEMA_VERSION=3`。

## 十、前端（ghostty-web 终端）

ghostty-web 是纯渲染器（WASM VT 解析），不含 transport。自建 WS transport。

### 10.1 新组件 `features/runs/terminal.tsx`

- `ghostty-web` 实例挂载容器。
- WS 连 `/api/runs/:runId/pty`（二进制）：
  - 收到的字节 → `term.write(uint8)`；
  - `term.onInput(data)` → `ws.send(data)`；
  - `term.onResize(cols,rows)` / `ResizeObserver` → 发控制帧 `{type:'resize',cols,rows}`（或单独 WS 文本帧）。
- 自动 resize：ResizeObserver 监听容器尺寸 → 计算 cols/rows → resize。

### 10.2 重连 / scrollback 策略（服务端环形缓冲，**不用 tmux**）

- **browser 关 WS ≠ 停 run**：服务端只停止向该 WS 转发；容器与 pi 继续跑。
- **scrollback 回放**：服务端为每个 run 维护一个输出环形缓冲（近期 N KB / 若干屏）。新 WS 连上时先回放缓存字节给 ghostty-web（它渲染后重建屏幕），再续接实时流。这是 xterm.js 类终端的标准做法。
- **不用 tmux 包裹 pi**：tmux.md 指出 tmux 默认会丢失修饰键信息（Shift+Enter/Ctrl+Enter 坍缩成 Enter），需 `extended-keys-format csi-u` 且要 tmux 3.5+。ghostty-web 支持 Kitty 键盘协议，直连 docker PTY 可干净传递修饰键；套 tmux 反而破坏键保真。故 pi 直接作容器主进程挂在 docker PTY 上。
- **服务端重启韧性**（可选，二期）：把环形缓冲落盘到 `data/runs/<id>/pty.buf`，服务端重启后 re-attach 容器并回放，避免空白屏。MVP 接受重启后重连从空屏续流。

### 10.3 Run 页 Tabs

- **Terminal**（替换 Conversation）：ghostty-web。运行中/已停止都可看（停止后看历史渲染快照或只读；MVP 简单处理：WS 断开即只读保留末屏）。
- **Overview**（保留，简化）：run 状态、模型、容器资源、flag、summary；MVP 不显示 usage。
- **Files**（保留）：`features/runs/files-workspace.tsx` 不动。

接管 = 直接在 Terminal 打字（共享 TTY，pi 运行中 steer）。无需显式 takeover 按钮；可加状态提示「agent 运行中，输入即接管」。

### 10.4 删除的前端文件

`src/stream/`（整目录）、`features/runs/` 的 `timeline.tsx`/`timeline-model.ts`/`tool-render.tsx`/`tool-expand.ts`/`agent-inspector.tsx`/`agent-status-icon.tsx`/`agent-activity-badge.tsx`/`run-stream-store.ts`/`use-run-controller.ts`（重写）。SSE 消息流相关 API/store 删除。run 状态 meta 可经 WS 控制帧或独立轻量 SSE 推送（MVP 轮询 `GET /api/runs/:id` 亦可）。

## 十一、依赖变更

| 包 | 动作 | 说明 |
|---|---|---|
| `dockerode` | 后端加 | 容器编排/PTY |
| `ghostty-web` | 前端加 | 终端渲染 |
| `@earendil-works/pi-agent-core` | 后端删 | 不再自写 agent loop |
| `@earendil-works/pi-ai` | 后端删 | pi 自己读 models.json |
| `handlebars` | **保留** | 提示词模板 |
| `drizzle-orm` / `hono` / `typebox` | 保留 | |

## 十二、删除清单（最终）

**后端**
- `apps/server/src/agent/`（整目录）：runtime/tools/usage/compact/convert/managed-tools/edit-apply/tool-prompts/*.test.ts
- `apps/server/src/run/`：machine.ts、session.ts、tools.ts、runtime-port.ts、store.ts、live.ts、container-pool.ts、bus.ts、prompt-context.ts、stats.ts、types.ts、machine.test.ts、tools.test.ts、stats.test.ts、service.test.ts（重写）
- `apps/server/src/infrastructure/container.ts`（docker CLI 封装，被 dockerode 取代）、`infrastructure/redaction.ts`
- `apps/server/src/providers/models.ts`（pi-ai registry）
- `apps/server/src/run/prompt.ts`、`run/queries.ts`、`run/public.ts`：按新 run-service 重写

**共享（apps/shared）**
- `agent.ts`、`message.ts`、`live-event.ts`（消息相关类型）
- `run-config.ts` 的 local 分支、`usage.ts`（二期再回）、`thinking.ts`（若仅 agent 用）

**前端**
- `src/stream/`（整目录）
- `features/runs/`：timeline/timeline-model/tool-render/tool-expand/agent-*/run-stream-store/use-run-controller

**保留不动**
- `apps/server/src/platforms/`（加 run 级薄端点）、`events/`、`infrastructure/storage.ts`、`infrastructure/workspace-files.ts`（Files tab）、`settings/prompt-templates.ts`、`infrastructure/config-store.ts`（供应商设置不变）、`infrastructure/validation.ts`/`http-errors.ts`
- `containers/solver` 镜像（已装 pi@0.80.7；运行时挂载 skills；CMD 由 dockerode 覆盖）
- `apps/web/src/components/ui/**`（coss，只读）

## 十三、实施顺序

1. **后端骨架**：dockerode container-manager + DB schema v3 wipe + 新 run-service（create/stop/finish/resume/delete + 状态机）+ run 级 HTTP（flag/target/finish）。
2. **pi 启动**：models-json 生成器 + pi-agent 卷生成（models.json/skills/auth）+ 启动 `pi`（位置 prompt + flags）。
3. **PTY 桥接**：`/api/runs/:id/pty` WS + resize + container.wait 收尾 + resume（`pi --session <id>`）。
4. **前端**：ghostty-web Terminal 组件 + PTY WS transport + Run 页改造（Terminal/Overview/Files）。
5. **清理**：删旧 agent/多 agent/SSE/本地 backend 代码 + 跑 `check`/`test`。

## 十四、实现期需验证的风险点

- **ghostty-web 的 input/resize API 与 WS transport 适配**：渲染器无 transport，需自写适配层；确认 paste/特殊字符、二进制帧与控制帧分离。
- **models.json 生成对 `piBinding` 内置模型的正确性**：`modelOverrides` vs 完整自定义的边界用例；内置 provider 在容器内无 `auth.json`，需确认 models.json 内 `apiKey` 生效（文档已证，实测确认）。
- **pi 启动时序**：位置 prompt 模式下 pi 是否立即开跑；`APPEND_SYSTEM.md` 是否被正确追加（与 `--no-context-files` 互斥性已文档排除）。
- **PTY 桥接**：dockerode `attach`+`start`（Tty:true）双工流与 `container.resize({h,w})`/`container.wait()` 的实战稳定性；环形缓冲回放与 ghostty-web 渲染的配合。
- **多 Tab/并发 WS**：MVP 单 WS；第二个连接策略（拒绝 / 共享缓冲）待定。

## 十五、考虑过但否决/延后的方案

- **SDK 进程内（host 侧 `createAgentSession`）**：能把 submit_flag/finish 做成原生内建工具、subscribe 流式、ResourceLoader 覆盖系统提示。否决：SDK 跑在 AegisX 进程里，**失去 Kali 容器隔离与 CTF 工具链**，与「容器内跑 pi」的核心目标冲突。
- **容器内跑 SDK runner 而非裸 `pi`**：容器主进程改为 `node runner.js`（用 `InteractiveMode` + `defineTool` 注入原生 submit_flag/finish，finish 调 `ctx.shutdown()`）。优点：原生工具、无需 curl/skill、退出最干净。**延后**：需向容器额外 ship 一个 runner 脚本并维护；MVP 按既定「裸 `pi` + skill + 服务端 SIGTERM」实现，后续可平滑切换。
- **tmux 包裹 pi**：解决重连 scrollback，但 tmux 默认破坏修饰键（tmux.md），需 csi-u + tmux 3.5+，得不偿失。改用「服务端环形缓冲回放」（§10.2）。
- **JSON 模式（`--mode json`）**：结构化事件流，但非 TTY，无法满足「前端直渲 TTY + 可接管」。仅作为未来结构化 telemetry 的备选。

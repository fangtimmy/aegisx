# Agent Workspace Tools 升级规划

状态：实施中（已确认决策）  
范围：仅 workspace 工具与相关运行时链路；**不做** skills / todo / 子 agent 类型 / webfetch / websearch / plan mode。  
对标：opencode、claude-code 的读写编辑语义与描述写法；实现可参考 pi（同源）的 edit-diff / truncate。

### 已确认决策（覆盖下文草案）

| 项 | 决策 |
|----|------|
| 参数命名 | 破坏性对齐 opencode：`filePath` / `oldString` / `newString` / `replaceAll` / `outputMode` |
| edit 形态 | 单次替换（同 opencode/claude），非 multi-edits 数组 |
| rg/fd 缺失 | **报错**，无 JS fallback |
| grep 默认 `outputMode` | `files_with_matches` |
| 必须先 read 再 edit | **不硬拦**（仅 description） |
| 无 vision | read 图片只返回路径/mime/size |
| 后台 bash | 返回 pid+log；agent 自行 `kill`；无 `bash_kill` |
| 交付 | 一次做完 |

---

## 0. 目标与非目标

### 目标

1. 工具 **description + 参数 description** 达到 opencode/claude-code 可用水平。
2. **edit**：唯一性校验、对原文多 edits、返回 diff；支持 `replaceAll`。
3. **grep/find**：container 内用 `rg` / `fd`；local 有可靠 fallback。
4. **read**：行号输出、默认窗口；支持图片（vision 模型）。
5. **bash**：正式后台模式（非靠 prompt 约定 `nohup`）。
6. **grep**：`output_mode` 等实用小参数。

### 非目标

- skills、todo、子 agent 角色类型、webfetch/websearch、plan mode、MCP/LSP。
- 把 CTF 二进制工具（nmap/ghidra…）做成独立 tool。
- 重命名工具名（保持 `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`）。
- 为权限审批引入交互 UI。

### 参数命名策略

| 决策 | 说明 |
|------|------|
| **保留** `path` / `oldText` / `newText` / `command` | 与现有 AegisX/pi 一致，避免无意义 breaking |
| **语义与文案** 对齐 opencode/claude-code | description、失败信息、默认值、行号格式 |
| **不** 改成 `filePath`/`oldString` | 收益低、迁移成本高 |

---

## 1. 目标 API 契约（定稿草案）

### 1.1 `read`

```ts
parameters: {
  path: string                    // 相对 workspace 或 /opt/solver（container 只读）
  offset?: number                 // 1-indexed 起始行，默认 1
  limit?: number                  // 默认 2000 行
}
```

行为：

| 项 | 规范 |
|----|------|
| 文本输出 | 每行 `N: content`（与 opencode/claude `cat -n` 风格一致：行号 + `: ` + 内容） |
| 默认窗口 | 未传 `limit` → **2000 行**；另受 maxOutput 字节上限（默认 64KB，可配置） |
| 超长单行 | 单行截断到 2000 字符并标注 |
| 分页提示 | 截断时明确写出「下一页用 offset=…」 |
| 图片 | 扩展名/魔数识别 `jpeg/png/gif/webp` → 返回 image content part（base64 + mimeType）+ 简短 text 说明 |
| 非文本二进制 | 拒绝并提示用 `bash file` / `xxd` 等 |
| 目录 | 保持现状：不读目录（用 `ls`）；错误信息指向 `ls` |

依赖修复（**必须同 PR**）：

- `apps/server/src/agent/convert.ts` 的 `toLlmMessages` 当前把 toolResult 图片压成 `"[image]"`。  
  需在模型支持 vision 时 **透传 image parts**；不支持时保留 text 占位 + 说明。

### 1.2 `write`

```ts
parameters: {
  path: string
  content: string
}
```

行为：

| 项 | 规范 |
|----|------|
| description | 对齐 opencode：优先 edit、勿主动写新文件、勿乱加 emoji 等（CTF 语境微调） |
| 返回 | 路径 + 字节数；若覆盖已有文件，details 可带 `overwrote: true` |
| 顺序 | `executionMode: "sequential"`（与 edit 一致，防 race） |

### 1.3 `edit`

采用 **「claude/opencode 语义 + pi 多 edits」**：

```ts
parameters: {
  path: string
  edits: Array<{
    oldText: string
    newText: string
    replaceAll?: boolean   // 默认 false
  }>                       // minItems: 1
}
```

行为：

| 项 | 规范 |
|----|------|
| 匹配基线 | **全部 edits 相对文件原文**匹配，禁止「改完再改」的串行污染 |
| 唯一性 | `replaceAll !== true` 时，`oldText` 在原文中必须 **恰好 1 次**，否则失败并提示扩大上下文或 `replaceAll` |
| 重叠 | 匹配区间不得重叠/嵌套，否则失败 |
| 未找到 | 明确错误：`oldText not found` |
| 相同串 | `oldText === newText` → 失败 |
| 换行 | 归一化匹配（LF）；写回保留原文件 line ending |
| 返回 | text 摘要 + `details.diff`（unified patch 或 display diff）+ `editsApplied` |
| 并发 | `executionMode: "sequential"`；同 path 写互斥（进程内 queue，覆盖 main/child 并行） |

可选小参数（P1，若实现成本低）：

- 顶层 `replaceAll`：作为所有 edits 的默认（单 edit 字段优先）。

### 1.4 `bash`

```ts
parameters: {
  command: string
  timeout?: number            // 秒，与现网一致；后台模式可忽略或仅作启动超时
  background?: boolean        // 默认 false
  // 可选 P1：
  // workdir?: string         // 限制在 workspace 内；默认 backend.cwd
}
```

**前台**（现状增强）：

- 非 0 exit 仍 throw，错误消息含 stdout/stderr（保留现语义）。
- 大输出落盘 `.aegisx/tool-output/<uuid>.log`。
- description 写清：勿交互式、独立探测可并行、长服务用 `background`。

**后台**（新增，优先于完整 PTY）：

| 项 | 规范 |
|----|------|
| 实现 | 在 backend 层启动分离进程：`nohup sh -c '…' > log 2>&1 & echo $!`（container 用 docker exec 等价） |
| 返回 | `pid`、`logPath`（workspace 相对路径）、`command`；**立即返回，不 wait** |
| 日志 | 默认 `.aegisx/bg/<uuid>.log` |
| 生命周期 | run stop / container 销毁时一并清理（复用现有 abort/容器 teardown） |
| 不提供 | 首版不做交互式 stdin PTY；agent 用 `read`/`grep` 读 log |
| 超时 | 后台任务 **不** 套用 command timeout 杀进程；仅受 run 生命周期约束 |

PTY 会话：标记为 **后续可选**（见 §6），首版不做。

### 1.5 `grep`

```ts
parameters: {
  pattern: string
  path?: string
  glob?: string                 // 现有；映射 rg --glob
  ignoreCase?: boolean
  literal?: boolean             // rg -F
  output_mode?: "content" | "files_with_matches" | "count"
                                // 默认 "content"（保持现网习惯；claude 默认 files_with_matches 我们不跟，避免 breaking）
  context?: number              // -C，仅 content
  before?: number               // -B，可选
  after?: number                // -A，可选
  limit?: number                // 默认 100
  multiline?: boolean           // 可选 P1
}
```

引擎：

| 环境 | 实现 |
|------|------|
| container | `rg`（已在 solver 镜像） |
| local | 优先 `rg`/`ripgrep`；缺失则 JS fallback（现有 walk，行为尽量对齐） |

### 1.6 `find`

```ts
parameters: {
  pattern: string               // glob
  path?: string
  limit?: number                // 默认 1000
}
```

引擎：container 用 `fd`；local 优先 `fd`/`fdfind`，否则 walk + `matchesGlob`。

### 1.7 `ls`

```ts
parameters: {
  path?: string
  limit?: number                // 默认 500（对齐 pi）
}
```

补参数 description + limit；逻辑小改。

---

## 2. 描述文案策略

### 2.1 原则

- **Schema description 自洽**：模型即使不读 system prompt 也能正确用 tool。
- **System prompt 变薄**：`prompt-templates.ts` 里重复的 tool 使用说明改为「见 tool 描述」+ CTF 特有约束（flag/target/finish）。
- **对标来源**：
  - opencode：`packages/opencode/src/tool/{read,edit,write,grep,glob,shell}*.txt`
  - claude-code：`FileRead/FileEdit/Grep/Bash` 的 `prompt.ts`
- **CTF 改写**：去掉 git commit 仪式、emoji 说教可保留简短版；强调 workspace 边界、`/opt/solver` 只读、大输出落盘路径。

### 2.2 落地方式

```
apps/server/src/agent/tool-prompts/
  read.ts      # 或 .txt + 常量
  write.ts
  edit.ts
  bash.ts
  grep.ts
  find.ts
  ls.ts
```

- description 从独立模块导入，避免 `tools.ts` 巨型字符串。
- 每个参数 `Type.String({ description: "..." })`。

---

## 3. 架构改动

### 3.1 文件拆分（建议）

当前 `agent/tools.ts` ~500 行，升级后会膨胀。建议：

```
apps/server/src/agent/
  tools.ts                 # createWorkspaceTools 组装 + 导出类型
  workspace-backend.ts     # WorkspaceBackend + createLocalBackend
  tool-limits.ts           # 截断常量与 boundedText
  tools/
    read.ts
    write.ts
    edit.ts
    bash.ts
    grep.ts
    find.ts
    ls.ts
    edit-diff.ts           # 唯一性/重叠/diff（可移植 pi 逻辑）
    search-exec.ts         # rg/fd 调用与解析
    file-mutex.ts          # 同 path 写锁
  tool-prompts/            # 见 §2.2
```

`createContainerBackend` 仍在 `infrastructure/container.ts`；按需扩展 backend 接口。

### 3.2 WorkspaceBackend 扩展

```ts
type WorkspaceBackend = {
  // 现有
  cwd: string
  resolvePath(path: string, write?: boolean): string
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>
  write(path: string, content: string, signal?: AbortSignal): Promise<void>
  list(path: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>
  exec(command, options): Promise<ExecResult>

  // 新增（可选方法 + 默认 fallback，避免两处实现分叉）
  search?(opts: GrepOptions, signal?): Promise<GrepResult>
  findFiles?(opts: FindOptions, signal?): Promise<string[]>
  execBackground?(command, options): Promise<{ pid: number; logPath: string }>
}
```

或：**不扩接口**，grep/find/bash-bg 一律 `backend.exec` 拼命令——实现快，但 local/container 引号与路径要统一封装在 `search-exec.ts`。

**推荐**：`search-exec.ts` 通过 `exec` 调 rg/fd；`execBackground` 作为 backend 方法（local spawn detached + container `docker exec -d` 或 `nohup`）。

### 3.3 图片与 LLM 链路

```
read tool → content: [{type:image, data, mimeType}, {type:text,...}]
  → persist toolResult (shared Message 已支持 ImageContent)
  → toLlmMessages：透传 image（若 model.input includes image）
  → UI：conversation 已有 [Image: mime] 占位；可选后续显示缩略图
```

任务拆分时 **convert 必须与 read 图片同批**。

### 3.4 后台 bash 与超时

- `manageAgentTools`：`background: true` 时 **不要** 用短 timeout 杀掉刚启动的进程；timeout 仅保护「启动命令本身」或直接跳过 bash 参数 timeout。
- `resolveToolTimeoutMs`：background 用固定短上限（如 10s）仅覆盖 spawn 往返。

---

## 4. 实施阶段

### Phase A — 契约与描述（低风险，可先合）

| # | 工作项 | 验证 |
|---|--------|------|
| A1 | 抽出 `tool-prompts/*`，补全 7 工具 description + 参数 description | 单测 snapshot 或字符串包含关键约束 |
| A2 | 收紧 `prompt-templates.ts` 工具段落，去掉与 schema 重复内容 | 人工 diff；不删 CTF 领域约束 |
| A3 | `ls` 增加 `limit`；参数 description | 单测 |

**成功标准**：模型可见的 tool schema 信息密度接近 opencode 短版。

### Phase B — read / write / edit 对齐

| # | 工作项 | 验证 |
|---|--------|------|
| B1 | read：行号、默认 2000 行、单行截断、分页提示 | 单测 |
| B2 | read：图片检测 + image content；非文本错误 | 单测 fixture png |
| B3 | convert：toolResult 图片透传 / 非 vision 降级 | convert 单测 |
| B4 | edit-diff：唯一性、原文多 edits、重叠检测、line ending、diff 返回 | 单测（对标 pi 边界用例） |
| B5 | edit：`replaceAll`；file-mutex | 单测并发写 |
| B6 | write：sequential + 描述；覆盖检测可选 | 单测 |

**成功标准**：

- 重复 `oldText` 不静默改错。
- 多 edits 同时合法应用。
- read 输出可直接支撑 edit（行号不污染 oldText——description 明确「匹配时去掉行号前缀」）。

### Phase C — grep / find 引擎

| # | 工作项 | 验证 |
|---|--------|------|
| C1 | `search-exec`：rg 参数映射、解析输出 | 单测（mock exec 或本机有 rg） |
| C2 | grep：`output_mode` / context / limit；container 路径含 `/opt/solver` | 集成或 unit |
| C3 | find：fd 映射 + fallback | 单测 |
| C4 | 无 rg/fd 时 fallback 行为与错误提示 | 单测 |

**成功标准**：在含 knowledges 规模目录上，container 内 grep 不再全量 Node walk。

### Phase D — bash 后台

| # | 工作项 | 验证 |
|---|--------|------|
| D1 | local `execBackground`：detached + log + pid | 扩展现有 bash abort 测试 |
| D2 | container `execBackground` | 有 docker 时集成测；否则 mock |
| D3 | bash tool 参数 `background` + 返回格式 + timeout 策略 | 单测 |
| D4 | run stop / 容器销毁时清理 bg 进程（尽力） | 文档 + 关键路径测 |

**成功标准**：agent 可 `background: true` 起监听，再用 `read` log，无需手写 nohup。

### Phase E — 收尾

| # | 工作项 | 验证 |
|---|--------|------|
| E1 | 更新 `docs/agent-orchestration.md` 工具小节（若有） | 文档 |
| E2 | 全量相关测试 + typecheck | CI 本地 |
| E3 | 对照本文件 checklist 勾选 | — |

---

## 5. 测试计划

| 区域 | 文件 | 要点 |
|------|------|------|
| 现有 | `test/platforms/agent-tools.test.ts` | 保留 abort / 截断 / 非 0 exit；扩展 background |
| 现有 | `run/tools.test.ts` | main/child 工具集不变 |
| 新增 | `agent/tools/*.test.ts` 或集中 `agent/workspace-tools.test.ts` | read 行号、edit 唯一/重叠/replaceAll、grep modes |
| 新增 | `agent/convert.test.ts` | image 透传 |
| 新增 | `agent/edit-diff.test.ts` | 纯函数边界 |

原则（项目 AGENTS.md）：**整阶段实现完再统一测**，避免写一个函数检查一次。

---

## 6. 明确延后

| 项 | 原因 |
|----|------|
| 完整 PTY / 交互 shell | 后台 log 模式覆盖 CTF 主场景；PTY 复杂且易挂死 |
| bash `workdir` | 可用 `cd` 单命令；需要时再加 |
| grep `multiline` / `type` | 首版可不做；API 预留可选 |
| read PDF/notebook | CTF 价值低 |
| 必须先 read 再 edit 的硬校验 | opencode/claude 有；CTF 自治下可能过严，**首版只写进 description，不做硬拦截** |
| 跨 run 的 bg 进程注册表 | 先 per-backend 尽力清理 |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| edit 语义变更导致旧习惯失效 | 错误消息写清；system prompt 同步 |
| local 无 rg/fd | fallback + 日志一次 warn |
| 图片撑爆上下文 | 限制分辨率/字节（对齐 pi 约 2000px / 合理 base64 cap）；超限只返回 path 提示 |
| 后台进程泄漏 | run stop 杀进程组；container 随容器灭 |
| container `docker exec` 调 rg 的路径转义 | 统一 `shellQuote`；只传 resolve 后绝对路径 |
| description 过长占 token | 控制在 opencode 短文水平（每工具 ~0.5–2KB），不搬 claude bash 全文 git 教程 |

---

## 8. 工作量粗估

| Phase | 量级 |
|-------|------|
| A 描述 | 0.5–1d |
| B read/write/edit + convert | 1.5–2.5d |
| C grep/find | 1–1.5d |
| D bash bg | 1–1.5d |
| E 收尾 | 0.5d |
| **合计** | **约 4.5–7d** |

---

## 9. 验收清单（全部勾选才算完成）

- [x] 7 个 workspace 工具均有完整 tool + 参数 description
- [x] read：行号、默认 2000 行、图片仅返回路径（无 vision 透传）
- [x] edit：`filePath`/`oldString`/`newString`/`replaceAll`、唯一性、diff、写互斥
- [x] write：`filePath`；sequential + 写锁
- [x] grep：rg 必需 + `outputMode`（默认 files_with_matches）+ context；无 fallback
- [x] find：fd/fdfind 必需；无 fallback
- [x] bash：`background` 返回 pid/logPath；前台行为回归通过
- [x] system prompt 同步新参数名；CTF 约束仍在
- [x] 相关单测通过（agent workspace/edit/managed + platforms bash）
- [x] 未引入 skills/todo/websearch/子 agent 类型等非目标项

---

## 10. 建议合并策略

1. **PR1** = Phase A（仅描述 + ls limit）— 可独立上线。  
2. **PR2** = Phase B（read/edit/write/convert）— 核心正确性。  
3. **PR3** = Phase C（grep/find）。  
4. **PR4** = Phase D（bash background）+ E。

或按你偏好合成 1–2 个大 PR；仍建议 **B 不与 D 绑死**（edit 正确性优先）。

---

## 11. 确认问题（实施前）

请确认或改口：

1. **grep 默认 `output_mode`**：建议保持 `content`（现状）。是否改为 claude 的 `files_with_matches`？
2. **edit 硬性「必须先 read」**：建议首版仅 description 要求，不硬拦。是否同意？
3. **图片**：无 vision 的模型是否完全禁止 image part（只返回「这是图片，路径为…」）？
4. **后台 bash**：是否需要 `bash_kill(pid)` 工具，还是 stop run / 自行 `kill` 即可？
5. **合并粒度**：按 §10 四 PR，还是一次做完？

确认后按 Phase 顺序实施。

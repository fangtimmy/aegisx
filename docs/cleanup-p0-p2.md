# AegisX Slop 清理计划（P0–P2）

状态：**待执行**
范围：机械清理（P0）、消除双轨（P1）、结构性重构（P2）。P3（设置系统重构、插件盘点）不在本计划内。
本文档是执行的唯一依据：按阶段顺序执行，每阶段完成后统一验证并提交 commit。

## 基线快照（2026-08-14）

| 指标 | 基线值 |
|---|---|
| 总行数（不含 data/、node_modules/） | 52,597 |
| apps/server/src | 18,790 |
| apps/web/src（含只读 ui 6,583） | 23,144 |
| apps/shared | 2,017（21 个文件） |
| apps/server/test | ~8,400（42 文件） |
| server/service.ts | 2,215 |
| 测试 | server 229 pass / 0 fail；web 7 pass / 0 fail |

行数统计命令（验证时复用）：

```sh
find apps -type f \( -name "*.ts" -o -name "*.tsx" \) -not -path "*/node_modules/*" -not -path "*/dist/*" | xargs wc -l | tail -1
```

验证命令（每阶段结束必须全绿）：

```sh
bun run check    # oxlint --type-check + oxfmt，全 workspace
bun run test     # server + web 全部测试
bun run build    # web 生产构建（捕获依赖删除导致的缺失）
```

## 执行总则

1. **只读约束**：`apps/web/src/components/ui/**` 是 coss UI 库，禁止修改、禁止删除其中未使用的文件（knip 报告的 23 个 unused ui 文件一律跳过）。因此 `react-day-picker` 等仅被 ui 内未使用组件引用的依赖**保留**。
2. **每阶段一个或多个 commit**，message 前缀 `cleanup(p0|p1|p2):`。阶段内改动一次性完成后统一跑验证，不要改一个文件查一次。
3. **纯移动优先**：P2 的代码搬迁不改变任何逻辑/行为；测试必须原样通过（删除过时测试除外，见 P2.2）。
4. knip 报告是快照，执行时以现场输出为准。仓库根新增 `knip.json`（见附录），运行 `bunx knip --config knip.json --no-progress`。

---

## P0 — 机械清理（预计 −2,000 行，零行为变更）

### P0.1 死代码与死导出清理

以 `bunx knip --config knip.json` 现场输出为准。参考快照（业务代码，已排除 ui/）：

**server（删符号）**
- `src/agents/event-pipeline.ts` → `messageIdOf`
- `src/agents/host.ts` → `HOST_FILE_TOOLS`, `buildHostFileTools`
- `src/db/index.ts` → `readJournalMigrationCount`
- `src/infrastructure/storage.ts` → `defaultMaxAttachmentBytes`
- `src/lib/guards.ts` → `isString`, `isFiniteNumber`, `isBoolean`, `isNullableString`
- `src/lib/schemas.ts` → `ThinkingLevelSchema`, `EnvironmentSchema`
- `src/orchestration/registry.ts` → `registerPlugin`, `getPlugin`, `registerOrchestrationPlugins`（改非导出）
- `src/orchestration/types.ts` → `pluginTemplateKeys`；unused types：`SpawnTemplate`, `OrchestrationSlotInfo`, `EventPlugin`
- `src/platforms/service.ts` → `PlatformActionError`, `createPlatformAdapter`
- `src/providers/builtin-models.ts` → `parseThinkingLevelMap`；type `ModelThinkingLevel`
- `src/providers/models-json.ts` → `piProviderKeyBound`, `piProviderKeyCustom`, `piModelRef`, `enabledModelRefs`；types `PiApi`, `PiModel`, `PiProvider`
- `src/providers/public.ts` → `mapProviderModel`
- `src/providers/routes.ts` → `providerName`
- `src/run/bash-tool.ts` → `BASH_DESCRIPTION`
- `src/run/prompt.ts` → `attachmentFiles`
- `src/run/workspace/edit-apply.ts` → `normalizeToLf`, `detectLineEnding`, `restoreLineEndings`, `stripBom`, `normalizeForFuzzyMatch`
- `src/settings/prompt-templates.ts` → `renderOrchestratorSystemPrompt`, `renderInitialPrompt`（`preview*` 与 `ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES` 被 routes 使用，**保留**，P1 处理）
- `src/settings/routes.ts` → `settingsResponse`
- `test/support.ts` → 唯一导出 `waitFor` 未使用，**整个文件删除**
- unused types（其余）：`ProviderType`(infrastructure/config-store), `AgentSessionOps`(run/agent-session-ops), `ChildAgentRuntime`(run/child-agents), `ContainerLimits`(run/container/container-manager), `ModelResolver`(run/model-resolver), `RunQueries`(run/queries), `RunSummary`/`SchedulerStatusSnapshot`(run/scheduler-tools), `WorkspaceEntry`/`ExecResult`/`BackendExecOptions`(run/workspace/backend)

**web（删符号或去 export）**
- `src/api/index.ts` → `apiRequest`, `defaultSettings`, `get`, `settingDef`
- `src/api/types.ts` → `defaultSettings`, `get`, `settingDef`（与 index.ts 重复）
- `src/api/platforms.ts` → `syncChallenges`
- `src/api/runs.ts` → `deleteRun`, `sendMessage`, `switchModel`, `finishRun`（删前 rg 确认零调用点）
- `src/features/events/event-agents-shared.ts` → `ROLE_LABELS`
- `src/features/events/event-view-prefs.ts` → `DEFAULT_EVENT_VIEW_PREFS`, `loadEventViewPrefs`, `saveEventViewPrefs`（若仅文件内使用则去 export）
- `src/features/events/scheduler-config-tab.tsx` → `SchedulerConfigFields`
- `src/features/runs/model-switcher.tsx` → `THINKING_LEVELS`, `useModelAliases`, `useResolvedAliases`, `useAvailableModels`, `groupByProvider`
- `src/features/runs/tool-render.tsx` → `stripAnsi`, `toolDiff`
- `src/lib/toast.ts` → `toastManager`

**处理规则**
1. 符号在文件内仍被使用 → 仅去掉 `export` 关键字；完全无人用 → 删除符号及其孤儿 import。
2. 每删一批跑 `bun run check`（type-check 能捕获 knip 误报）。
3. 处理完后重跑 knip，直到业务代码（排除 ui/）无 unused exports / unused files。

### P0.2 web 未使用依赖

`apps/web/package.json` 删除：
- `@earendil-works/pi-coding-agent`（web 无引用，仅 server 用）
- `recharts`（全仓库零引用）
- `katex` + `apps/web/src/index.css` 第 2 行 `@import "katex/dist/katex.min.css"`（无 remark-math/rehype-katex，streamdown 内置也不含 katex，纯死重 ~300KB）
- devDep `tw-animate-css`（无任何 import）

**保留**（有真实引用，knip 误报或 ui 只读约束）：
- `tailwindcss`（index.css `@import "tailwindcss"` + `@tailwindcss/vite` peer）
- `react-day-picker`（被 ui/calendar.tsx 引用，ui 只读）

验证：`bun install && bun run build`，并视觉抽查页面（math 已不存在任何渲染路径，无需担心）。

### P0.3 测试目录合并

`apps/server/test/runs/*`（6 个文件：bash-tool、child-agent-prompt、container-manager、read-image、tools、workspace.test.ts）移入 `apps/server/test/run/`，修正内部相对导入。删除空的 `test/runs/`。

### P0.4 shared 包整合（21 文件 → 8 文件）

纯移动 + import 更新，不改内容。合并目标：

| 新文件 | ← 合并来源 | 预计行数 |
|---|---|---|
| `model.ts` | model-ref + alias + model-switch | ~340 |
| `run.ts` | run + run-config + run-status | ~205 |
| `domain.ts` | event + platform + challenge + target + provider | ~265 |
| `agent.ts` | agent + session-entry | ~165 |
| `live-event.ts` | live-event + timing + thinking | ~205 |
| `settings-schema.ts` | settings-schema + settings | ~505 |
| `prompt-defaults.ts` | （P1.1 整体移出 shared，见下） | — |
| `index.ts` | 更新 barrel | ~10 |

- 同步更新 `index.ts` 的 `export *`。
- 所有 `@aegisx/shared/<子路径>` 直接导入（约 38 处，分布：provider×8、thinking×7、prompt-defaults×7、agent×5、live-event×4、target×2、platform×2、model-ref×2、alias×1）改为合并后路径或 barrel `@aegisx/shared`。package.json 的 `./*: ./*.ts` 通配无需改。
- shared 内部的 `isRecord` 重复实现（session-entry.ts、timing.ts 各一份）收敛为一份。

### P0.5 guard 去重

`isRecord` 共 3 处定义（server `lib/guards.ts`、web `domain/conversation.ts`、shared）。三端各自保留一份属于合理边界（跨包共享一行类型守卫不值得抽包），仅确保**每个包内只有一份**。P0.4 已处理 shared 内部；server/web 各自查重。

### P0.6 文档清理

**直接删除**（均已被 orchestration-redesign.md 取代或为过程文档）：
- `docs/refactor-v3.md`、`docs/refactor-v4.md`
- `docs/architecture.md`、`docs/lifecycle-redesign.md`、`docs/orchestrator.md`
- `docs/code-review-fixes.md`
- `docs/session-format-redesign.md`、`docs/session-storage-optimization.md`

**移入 `docs/archive/`**（历史记录，保留可查）：
- `docs/agent-tools-upgrade.md`、`docs/e2e-v5-results.md`、`docs/archive-maintainability-refactor-v1.md`

**保留**：`docs/orchestration-redesign.md`（当前设计）、`docs/migrations.md`、`docs/archive/` 目录。

执行检查：删除前 `rg "refactor-v4|architecture\.md|lifecycle-redesign|orchestrator\.md" apps/ README.md` 清理残留引用；更新 README.md 的 Design notes 链接（只留 orchestration-redesign.md）。

### P0.7（可选，磁盘清理，需用户确认）

`data/` 下 5 个 sqlite 备份共 ~240MB（已 gitignore，不影响仓库）：
```sh
rm data/aegisx.sqlite.bak-*
```

**P0 完成标准**：knip 业务代码零报告；check/test/build 全绿；shared 8 文件；docs 只剩 2 个顶层文档 + archive/。

---

## P1 — 消除双轨（预计 −800 行）

### P1.1 提示词模板模块合一（767 行三处 → 单一模块）

现状：
- `apps/shared/prompt-defaults.ts`（314 行）：默认模板文案常量（唯一文案来源，正确）
- `apps/server/src/orchestration/prompt-templates-store.ts`（176 行）：DB seed/load/legacy 迁移
- `apps/server/src/settings/prompt-templates.ts`（277 行）：handlebars 渲染引擎 + 预览 + 样例上下文

动作：
1. **移动** `apps/shared/prompt-defaults.ts` → `apps/server/src/orchestration/prompt-defaults.ts`（grep 确认仅 server 7 处引用；检查 shared/settings-schema.ts 是否引用其常量，若有则改从 server 侧注入或保留该常量于 schema 侧——以现场为准）。shared 不再包含 prompt 文案。
2. **合并** `prompt-templates-store.ts` + `settings/prompt-templates.ts` → `apps/server/src/orchestration/prompt-templates.ts`（seed / load / render / preview 一体）。`settings/` 目录若因此只剩 routes.ts，将 routes 并入或保留（现场判断，倾向保留 routes.ts 原位）。
3. **删除** v7 遗留的未使用渲染路径：`renderOrchestratorSystemPrompt`、`renderInitialPrompt`（P0.1 已删导出，此处连同实现）。`previewOrchestratorSystemPrompt` / `previewInitialPrompt` / `ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES` 被 `settings/routes.ts` 预览端点使用——**先追踪 web 端是否真的调用该预览端点**：若 web 的 prompt 模板编辑 UI 不再预览 orchestrator 模板，则端点 + 辅助函数一并删除；若在用则保留并随合并迁走。

### P1.2 web api 层去重

- `api/index.ts` 与 `api/types.ts` 的重复导出（`defaultSettings`/`get`/`settingDef`）收敛到 types.ts 一处（P0.1 已删死侧，此处确保无残余重复）。
- `api/runs.ts` 死函数删除后，逐文件确认 api/ 下每个导出函数都有调用点（rg 验证），不引入新的 barrel 重复。

**P1 完成标准**：prompt 渲染/存储/默认文案各只有一处定义；web api 层无重复无死函数；check/test/build 全绿。

---

## P2 — 结构性重构（预计 −1,200 行 + service.ts 2,215 → ≤1,100）

### P2.1 `run/service.ts` 拆分

service.ts 是 57 个闭包函数 + 12 个可变 Map 的巨型工厂。按内聚边界抽取为模块，**纯移动，不改逻辑**。每抽一块跑一次 check+test。建议顺序（依赖方向从叶子到核心）：

1. `run/run-status.ts` ← 行 327–405：`recomputeRunStatus`, `markFinishing`, `agentTurnStart`, `agentTurnSettled` + `emitRun`/`emitAgents`/`emitRunEvent`（依赖注入：db、sqlite、queries、bus、eventScopes、emitters）
2. `run/teardown.ts` ← 行 462–563：`clearForceKill`, `terminateContainer`, `teardownRun`, `FORCE_KILL_GRACE_MS`, `forceKillTimers`（依赖：containerManager、queries、bus、emitters、childSessions、deadline 清理回调）
3. `run/deadlines.ts` ← 行 564–614：`clearRunTimers`, `armRunTimers`, `streamingAgentIds`, `TIMEOUT_GRACE_MS`, `timeoutTimers`（依赖：lifecycle abort、teardown）
4. `run/scheduler-admin.ts` ← 行 1806–末尾：`buildSchedulerToolContext`, `resolveAndCreate`, `setRunTimeout`, `readRun`, `getStatusSnapshot`, `getSchedulerRun`, `getSchedulerConfig`, `upsertSchedulerConfig`, `startScheduler`, `notifySchedulerOfFailure`（routes 直接调用的 API 面）
5. `run/run-factory.ts` ← 行 725–1027 + 1300–1755：`create`, `runSetup`, `buildRunContext`, `buildHandleHost`, `restoreRunContext`, `restoreRunContextOnce`, `prepareAgent`, `recoverOnBoot`（最大的块，~750 行）

service.ts 保留：锁/围栏、bus 装配、子模块接线、对 routes 暴露的门面。行号以现场为准（P0/P1 会移动行号），按函数名定位。

**抽取规则**：
- 模块形态与现有 `queries.ts`/`queue.ts` 一致：工厂函数 + 依赖对象注入，不引入 class。
- 不新增抽象层、不改函数签名（除非把闭包捕获改为显式参数）。
- 搬迁时顺手把 `spec §N.M` 注释改写为自解释注释（见 P2.3）。

### P2.2 `db/schema-compat.test.ts` 瘦身（548 → ~100 行）

**前置确认（执行时向用户求证）**：所有现存数据库（含备份）均已升级到 schema v11（`sqlite3 data/aegisx.sqlite "PRAGMA user_version"` 应 ≥11）。v7→v8 是一次性历史迁移。

动作：删除 `buildV7Database` 及 v7→v8 升级路径的全部 fixture 测试；保留：
1. 全新空目录建库 → 迁移到 `SCHEMA_VERSION`
2. 未识别 user_version 的库被拒绝
3. `0002_v8_unified_run.sql` 中"保留表/列仍存在"的一个 smoke 断言（防回退）

若用户确认不再需要 v7 升级路径，`db/index.ts` 中对应的 legacy 拒绝逻辑注释也可简化（仅注释，不改代码）。

### P2.3 `spec §` 注释清理

基线：103 处，分布 23 个文件。**不专项扫描**，随 P2.1 的代码搬迁顺手改写为自解释注释（保留技术内容，去掉对 orchestration-redesign.md 章节号的引用）。P2 结束时统一验收：

```sh
rg -c "spec §" apps/server/src   # 目标：0
```

`docs/orchestration-redesign.md` 本体保留（README 引用的设计说明），但代码不再逐节锚定它。

**P2 完成标准**：service.ts ≤ 1,100 行；模块按上述边界落位；server 229 测试允许因 P2.2 减少（记录删了几个）；`rg "spec §"` 为 0；check/test/build 全绿。

---

## 总验收清单

- [ ] `bun run check && bun run test && bun run build` 全绿
- [ ] `bunx knip --config knip.json` 业务代码（排除 components/ui）无 unused exports/files/deps
- [ ] shared = 8 个文件；shared 无 prompt 文案
- [ ] docs/ 顶层仅 orchestration-redesign.md、migrations.md、archive/、本计划
- [ ] service.ts ≤ 1,100 行；`rg "spec §" apps/server/src` = 0
- [ ] 总行数报告（对比基线 52,597，预期 44,000–46,000）
- [ ] git log 中 P0/P1/P2 各自成组，每个 commit 可独立通过 check+test

## 附：knip 配置（仓库根 `knip.json`）

```json
{
  "workspaces": {
    ".": { "entry": ["apps/server/src/index.ts", "apps/web/src/main.tsx"] },
    "apps/server": { "entry": ["src/index.ts"], "project": ["src/**/*.ts", "test/**/*.ts"] },
    "apps/web": { "entry": ["src/main.tsx", "src/App.tsx"], "project": ["src/**/*.{ts,tsx}"] },
    "apps/shared": { "entry": ["index.ts"], "project": ["*.ts"] }
  }
}
```

## 不做（P3 留档，需用户另行拍板）

- 设置系统声明式 schema → 写死页面（预计 −1,500~2,000 行）
- 编排插件盘点（classic / observer-solver / bootstrap-solver / trio 实际使用情况）
- `components/ui/` 未使用文件与 react-day-picker 的删除（受只读约束）

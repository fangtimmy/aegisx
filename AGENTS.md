# AGENTS.md

AegisX：本地单机部署的网络安全多智能体协同 CTF 平台。Bun monorepo（单一 lockfile），workspace 间以 `@aegisx/*` 互相引用。仓库文档以中文为主，提交信息用英文 conventional commits（`fix(run): …`）。

## 协作规则

- 一轮对话内完成全部修改后统一检查（类型 / lint / 测试），不要写一个文件检查一次。
- 先规划再实施，规划经用户确认后再动手；完成规划的全部内容后才停止，并明确说明未完成项。
- `apps/web/src/components/ui/**` 是 coss UI 组件库，只读，禁止修改。

## 包结构

| 包 | 职责 |
|---|---|
| `apps/server` | Hono API + agent 宿主进程，全部业务逻辑所在 |
| `apps/web` | React + Vite 前端（dev 时 `/api` 代理到 `127.0.0.1:3000`） |
| `apps/shared` | 前后端 wire 类型的 canonical 来源，无 runtime 代码路径 |
| `apps/sdk/python` | 容器内 Python SDK，构建时 COPY 进镜像 `/opt/aegisx-sdk`，位置固定不可移动 |
| `containers/solver` | Kali 解题镜像，minimal / essential / full 三档共用一个 Dockerfile |
| `containers/allinone` | 单镜像整机（`AEGISX_EXEC_BACKEND=local`，无独立工具箱容器） |

## 命令

仅支持 Bun 作为包管理器与运行时，不兼容 node / npm / pnpm。

```sh
bun install         # 仓库根目录，一次装全部 workspace
bun run dev         # server + web 并行（dev:server / dev:web 可单独启）
bun run check       # oxfmt --check + knip + oxlint --type-check（全部 workspace；无 tsc 脚本，类型检查走 oxlint）
bun run fmt         # oxlint --fix + oxfmt
bun run test        # 全部测试；server 侧脚本是 bun test --max-concurrency 1，勿绕过并发限制
bun run test:sdk    # Python SDK 契约测试（apps/server/scripts/sdk-contract.ts）
bun run build       # web 生产构建
bun run db:generate # drizzle 迁移生成（在 apps/server 下执行）
```

knip 会卡未使用的导出：新增导出若无消费方，`bun run check` 直接失败。

## 架构边界

- agent loop 在宿主 server 进程内运行（`@earendil-works/pi-coding-agent`，版本由根 package.json `overrides` 统一钉住，升级须多处同步）；bash 与文件工具不落宿主进程——每题一个长寿 Kali 容器，命令经 dockerode `exec` 送入，工作区双向 bind mount。
- `apps/server/src/run/` 是运行时心脏：`service.ts` 组装根，`agent-factory.ts` 单次 spawn 组装（容器 → host session → 工具注入），`fence.ts` 强制并发上限与槽位——系统约束在启动侧强制校验，不依赖调度者自觉。
- 调度者是 agent 而非代码循环：消费 `orch` 频道事件，用 Python SDK 产出计划，`run/queue.ts` 排水落地。
- 频道键全部派生、无频道表：`team:<challengeId>` / `dm:<agentId>` / `orch:<eventId>`；`channel_messages` 是全部 agent 间通信的唯一账本，`channels-delivery.ts` 是唯一推送出口。
- 数据模型 Event → Challenge → Agent（`apps/server/src/db/schema.ts`）；Workspace 是派生路径无表行；数据全落 `data/`（`AEGISX_DATA_DIR` 可改址）。
- web 侧 SSE 消费有单流约束（同时只订阅一个 agent，`stream/conversation-store.ts`）；前端 API 类型直接取自 `@aegisx/shared`。

## Schema 变更工作流

Schema 演进是基线制：`apps/server/drizzle/` 只保留一份从当前 schema 生成的基线迁移，旧库不做升级。

1. 改 `apps/server/src/db/schema.ts` → `rm -rf apps/server/drizzle` → 在 apps/server 下 `bun run db:generate` 重新生成唯一基线。
2. 人工审查生成 SQL：必须是从空库到当前 schema 的完整 DDL，不得出现 `DROP` / `RENAME` / `ALTER`。
3. 同步 bump `SCHEMA_VERSION`（同文件，开机 stale 判定锚点），基线 SQL + journal + schema + 版本号一个提交。

详见 docs/migrations.md（开机三态协商、无升级路径）。

## 文档导航

- docs/README.md — 文档总索引
- docs/architecture.md — 架构概览（活文档），动敏感区域前先读，改架构后同步更新
- docs/migrations.md — 数据库迁移工作流
- apps/sdk/python/GUIDE.md — agent Python SDK 参考
- containers/solver/README.md — 解题镜像三档的构建与内容

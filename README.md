# AegisX

AegisX is a local, single-user workspace for running multi-agent CTF solving sessions. It manages events, challenges, attachments, model providers, isolated agent workspaces, live agent conversations, an event task queue (scheduler), and token usage.

> **Schema v19（题中心模型）** — Run 作为一等实体被移除。Event → Challenge → Workspace → Agent 四层；agents 表重建（eventId/challengeId/role/prompt/source/deadlineAt/summary），spawn_queue（append 语义），challenge_flags.agentId + source 'agent'；频道附件改为 shared/ 路径（删 channel_files 表）；调度者容器挂载 /challenges 只读。迁移 0013 为纯破坏性 DDL（旧数据弃置）。
> Design notes: [docs/model-v19-challenge-centric.md](docs/model-v19-challenge-centric.md)（v19 题中心设计，已实施）、[docs/model-v19-implementation.md](docs/model-v19-implementation.md)（实施计划，已实施）、[docs/tasks-tab-design.md](docs/tasks-tab-design.md)（任务 Tab：题中心作战视图，已实施）、[docs/composer-realtime-design.md](docs/composer-realtime-design.md)（SteerQueue/多行输入/频道 SSE/provider 测试，已实施）、[docs/agents-graph-and-activity-log.md](docs/agents-graph-and-activity-log.md)（Agents tab 纯 Graph 化 + 全局活动日志，已实施）、[docs/sdk-refactor.md](docs/sdk-refactor.md)（agent token / 权限收口 / SDK 契约测试，已实施；SDK 用法见 apps/sdk/python/GUIDE.md）。更早的设计史（v9 编排 / v16-18 频道 IM / v18 统一消息层）见 git 历史。

## Requirements

- [Bun](https://bun.sh/)
- Docker when using the container execution environment

## Run locally

Install everything, then start the API and web app together:

```sh
bun install    # at repo root — installs all workspaces (single lockfile)
bun run dev    # starts server + web concurrently
```

Or start them individually: `bun run dev:server` / `bun run dev:web`.

Open the URL printed by Vite. The web development server proxies `/api` to `http://127.0.0.1:3000` by default. Set `VITE_API_URL` to use another API endpoint.

## Data and execution

The API stores its SQLite database, attachments, and run workspaces under `data/`. Set `AEGISX_DATA_DIR` to use another directory.

The agent loop runs **host-side in-process** via the pi SDK. `bash` and the CTF toolchain execute inside a dedicated Kali container (a long-lived `sleep infinity` tool box, workspace bind-mounted at `/workspace`) over `docker exec`; the file tools (`read`/`edit`/`write`/`grep`/`find`/`ls`) operate on the host workspace, which is shared with the container. Container resources (CPU, memory, PIDs) are configurable.

A challenge workspace hosts 1..N parallel solver agents sharing one container (each agent has its own model, prompt, and deadline); an event hosts a single orchestrator agent that manages the event's task queue. Each agent works in its own directory (agents/<id8>) within the challenge workspace; shared findings land in shared/ (read-only to agents).

## Solve container image

`containers/solver` defines the Kali-based solver image used as the per-run tool box (main process `sleep infinity`).

## LLM gateway relay

Some competitions hand out fixed-endpoint LLM proxy URLs (e.g. `https://llm-gateway.dasctf.com/llm-gateway/proxy/e/<id>`) that must be used verbatim: any path appended to them 404s, but every provider type appends `/chat/completions` / `/responses` / `/v1/messages`. `bun run relay` starts a local strip-path proxy that forwards every request to such a URL as-is (streaming and SSE included):

```sh
bun run relay <upstream-url> [port]   # defaults to 8788; one process per upstream
```

Then point an `openai-compatible` provider at `http://127.0.0.1:<port>/v1` with the upstream's API key, and add models manually (these gateways don't serve `GET /models`, so model discovery fails by design).

## Checks

```sh
bun run check        # oxlint (lint + type-check) + oxfmt (format) across all workspaces
bun run test         # tests across all workspaces
bun run build        # web production build
bun run db:generate  # server drizzle migrations
```

All run from the repo root. Lint and formatting are provided by the oxc toolchain: `oxlint` (with the native `oxlint-tailwindcss` plugin for Tailwind v4 class checking and type-aware/`--type-check` via `tsgolint`) and `oxfmt` (with built-in import, Tailwind class, and package.json sorting). The workspace is a Bun monorepo: `apps/server` (`@aegisx/server`), `apps/web` (`@aegisx/web`), and `apps/shared` (`@aegisx/shared`, wire types) are linked as workspace packages; shared model-provider versions are pinned centrally via `overrides` in the root `package.json`.

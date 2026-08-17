# AegisX

AegisX is a local, single-user workspace for running multi-agent CTF solving sessions. It manages events, challenges, attachments, model providers, isolated run workspaces, live agent conversations, an event task queue (scheduler), and token usage.

> **Schema v16（频道化 IM）** — 统一消息层：channels / channel_messages / channel_reads / channel_files 四表（每 run 频道树 #team/#announce/DM + 事件作用域调度者 DM；调度 digest 以 recap 消息存回，scheduler_inbox_digests 表删除），迁移 `0010_im_channels`；v15 及更早的执行态数据库会被迁移，无 `__drizzle_migrations` 的 v1–v5 库仍被拒绝。此前 v14（v9 编排简化）删除插件编排与 spawn child。
> Design notes: [docs/im-channels.md](docs/im-channels.md)（统一消息层，现行）、[docs/orchestration-v9-simplify.md](docs/orchestration-v9-simplify.md)（v9 编排模型）。

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

A challenge run hosts 1..N parallel solvers sharing one container and workspace (each solver has its own model and optional per-solver prompt); an event run hosts a single scheduler that manages the event's task queue.

## Solve container image

`containers/solver` defines the Kali-based solver image used as the per-run tool box (main process `sleep infinity`).

## Checks

```sh
bun run check        # oxlint (lint + type-check) + oxfmt (format) across all workspaces
bun run test         # tests across all workspaces
bun run build        # web production build
bun run db:generate  # server drizzle migrations
```

All run from the repo root. Lint and formatting are provided by the oxc toolchain: `oxlint` (with the native `oxlint-tailwindcss` plugin for Tailwind v4 class checking and type-aware/`--type-check` via `tsgolint`) and `oxfmt` (with built-in import, Tailwind class, and package.json sorting). The workspace is a Bun monorepo: `apps/server` (`@aegisx/server`), `apps/web` (`@aegisx/web`), and `apps/shared` (`@aegisx/shared`, wire types) are linked as workspace packages; shared model-provider versions are pinned centrally via `overrides` in the root `package.json`.

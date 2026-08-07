# AegisX

AegisX is a local, single-user workspace for running multi-agent CTF solving sessions. It manages events, challenges, attachments, model providers, isolated run workspaces, live agent conversations, and token usage.

> **Schema v6** — wipe any old `data/` directory (or just `data/aegisx.sqlite*`) before first start; older databases are refused.
> Design notes: [docs/architecture.md](docs/architecture.md) (current). Transitions: [docs/refactor-v4.md](docs/refactor-v4.md) (v3→v4), [docs/refactor-v3.md](docs/refactor-v3.md) (v2→v3); v2 docs live in [docs/archive/](docs/archive/).

## Requirements

- [Bun](https://bun.sh/)
- Docker when using the container execution environment

## Run locally

Install and start the API:

```sh
cd apps/server
bun install
bun run dev
```

In another terminal, install and start the web app:

```sh
cd apps/web
bun install
bun run dev
```

Open the URL printed by Vite. The web development server proxies `/api` to `http://127.0.0.1:3000` by default. Set `VITE_API_URL` to use another API endpoint.

## Data and execution

The API stores its SQLite database, attachments, and run workspaces under `data/`. Set `AEGISX_DATA_DIR` to use another directory.

The agent loop runs **host-side in-process** via the pi SDK. `bash` and the CTF toolchain execute inside a dedicated Kali container (a long-lived `sleep infinity` tool box, workspace bind-mounted at `/workspace`) over `docker exec`; the file tools (`read`/`edit`/`write`/`grep`/`find`/`ls`) operate on the host workspace, which is shared with the container. Container resources (CPU, memory, PIDs) are configurable.

Each run has one main agent and may spawn background child agents (`spawn_agent`).

## Solve container image

`containers/solver` defines the Kali-based solver image used as the per-run tool box (main process `sleep infinity`).

## Checks

```sh
cd apps/server && bun run check && bun test
cd apps/web && bun run check && bun test && bun run build
```

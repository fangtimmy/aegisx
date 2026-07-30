# AegisX

AegisX is a local, single-user workspace for running multi-agent CTF solving sessions. It manages events, challenges, attachments, model providers, isolated run workspaces, live agent conversations, and token usage.

> **Schema v2** — wipe any old `data/` directory before first start.  
> Design notes: [docs/architecture.md](docs/architecture.md) (current). Historical: [docs/refactor-v3.md](docs/refactor-v3.md); v2 docs live in [docs/archive/](docs/archive/).

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

Local runs execute commands with the API process permissions and are not sandboxed. Container runs use a dedicated Docker container with the run workspace mounted at `/workspace` and configurable CPU, memory, and PID limits.

Each run has one main agent and may have multiple background child agents.

## Solve container image

`containers/solver` defines the Kali-based solver image used for container Runs.

## Checks

```sh
cd apps/server && bun run check && bun test
cd apps/web && bun run check && bun test && bun run build
```

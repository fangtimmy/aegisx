# AegisX

AegisX is a local, single-operator platform for attacking CTF competitions with agents. One scheduler agent per event plans the work and fills the spawn queue; solver agents — each with its own model, prompt, and deadline — work the challenges, share findings in per-challenge channels, and submit flags. The web UI shows live conversations, token usage, and the queue, and lets you intervene through the same channels.

Architecture: [docs/architecture.md](docs/architecture.md).

## Requirements

- [Bun](https://bun.sh/)
- Docker
- Solver image — build from the repo root (default `container.image` is `aegisx/solver:full`):

```sh
docker buildx build -f containers/solver/Dockerfile --target full -t aegisx/solver:full .
```

Tiers: `minimal` 0.85 GB / `essential` 4.75 GB / `full` 16.7 GB — [containers/solver/README.md](containers/solver/README.md).

## Run

```sh
bun install    # repo root, all workspaces (single lockfile)
bun run dev    # server + web concurrently
```

Open the URL printed by Vite (`bun run dev:server` / `bun run dev:web` run them separately). The dev server proxies `/api` to `http://127.0.0.1:3000`; set `VITE_API_URL` to use another API endpoint.

First steps:

1. Settings → Models: add a provider (OpenAI-compatible / OpenAI Responses / Anthropic Messages), discover models, set the default model.
2. Home: create an event; in its settings, bind a platform (CTFd, A1CTF, DASCTF, Ret2Shell, TSecBench). Challenge sync, remote flag submission, and target lifecycle come with the binding.
3. Event's Tasks tab: start the scheduler, or enqueue and spawn solvers manually.
4. Follow progress in Tasks and Stats; intervene by posting to a challenge's `#team` or DMing a solver.

## Execution and data

Agent loops run host-side in-process (pi SDK). `bash` and the CTF toolchain execute in a per-challenge Kali container — a long-lived tool box with the workspace bind-mounted — over `docker exec`; file tools operate on the host workspace, shared with the container. Each agent works in its own directory in the challenge workspace; shared findings land in `shared/` (read-only to agents).

Everything is stored under `data/` (SQLite database, attachments, per-event workspaces); set `AEGISX_DATA_DIR` to relocate.

Solver containers hold `NET_RAW` on the default bridge (or share a VPN container's netns via `container.networkMode`) and have unrestricted outbound reach, including the host LAN. Isolation is enforced solver↔host-data and solver↔other-challenges, not solver↔LAN; tighten via `container.networkMode` if required.

## Configuration

Runtime settings live in the web UI under Settings: agent defaults, scheduler concurrency and task timeout, container resources, `container.image`, `container.networkMode`. Per-event scheduler policy (model, instruction, target slots, flag handling) is in the event's settings tab.

Relay — for fixed-endpoint LLM gateways where any appended path 404s:

```sh
bun run relay <upstream-url> [port]   # default 8788, one process per upstream
```

The relay forwards every request as-is. Point an `openai-compatible` provider at `http://127.0.0.1:<port>/v1`; such gateways don't serve `GET /models`, so add models manually.

## Documentation

- [docs/architecture.md](docs/architecture.md) — architecture overview
- [apps/sdk/python/GUIDE.md](apps/sdk/python/GUIDE.md) — agent Python SDK (shipped in the container at `/opt/aegisx-sdk`)
- [docs/README.md](docs/README.md) — full index (report, migrations, audits, design archive)

## Development

```sh
bun run check   # format + lint + type-check across workspaces
bun run test    # tests across workspaces (test:sdk: Python SDK contract suite)
bun run build   # web production build
```

# AegisX

[中文](README.md) · **English**

AegisX is a local, single-operator platform for attacking CTF competitions with agents.

Architecture: [docs/architecture.md](docs/architecture.md). Usage guide: [docs/usage.md](docs/usage.md).

## Requirements

- [Bun](https://bun.sh/) — the only supported package manager and runtime; incompatible with node / npm / pnpm.
- Docker
- Solver image — build from the repo root (default `container.image` is `aegisx/solver:full`):

```sh
docker buildx build -f containers/solver/Dockerfile --target full -t aegisx/solver:full .
```

The image ships in three tiers — `minimal` / `essential` / `full` — see [containers/solver/README.md](containers/solver/README.md).

## Quick start

```sh
bun install    # repo root, all workspaces (single lockfile)
bun run dev    # server + web concurrently
```

Open `http://localhost:5173` (the Vite default; `bun run dev:server` / `bun run dev:web` run them separately). The dev server proxies `/api` to `http://127.0.0.1:3000`; set `VITE_API_URL` to use another API endpoint.

## Documentation

- [docs/usage.md](docs/usage.md) — usage guide
- [docs/architecture.md](docs/architecture.md) — architecture overview
- [apps/sdk/python/GUIDE.md](apps/sdk/python/GUIDE.md) — agent Python SDK (shipped in the container at `/opt/aegisx-sdk`)
- [docs/README.md](docs/README.md) — full index (report, migrations, audits, design archive)

## Development

```sh
bun run check   # format + lint + type-check across workspaces
bun run test    # tests across workspaces (`test:sdk`: Python SDK contract suite)
bun run build   # web production build
```

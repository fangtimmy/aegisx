# AegisX

**中文** · [English](README.en.md)

AegisX 是本地单机部署的网络安全多智能体协同任务平台。

架构概览：[docs/architecture.md](docs/architecture.md)。使用指南：[docs/usage.md](docs/usage.md)。

## 环境要求

- [Bun](https://bun.sh/) — 本项目仅支持 Bun 作为包管理器与运行时，不兼容 node / npm / pnpm。
- Docker
- 解题镜像 — 在仓库根目录构建（默认 `container.image` 为 `aegisx/solver:full`）：

```sh
docker buildx build -f containers/solver/Dockerfile --target full -t aegisx/solver:full .
```

镜像提供 `minimal` / `essential` / `full` 三档，详见 [containers/solver/README.md](containers/solver/README.md)。

## 快速启动

```sh
bun install    # 仓库根目录，一次安装全部 workspace（单一 lockfile）
bun run dev    # 同时启动 server 与 web
```

打开 `http://localhost:5173`（Vite 默认地址；`bun run dev:server` / `bun run dev:web` 可分别单独启动）。开发服务器将 `/api` 代理到 `http://127.0.0.1:3000`，可用 `VITE_API_URL` 指向其他 API 端点。

## 文档

- [docs/usage.md](docs/usage.md) — 使用指南
- [docs/architecture.md](docs/architecture.md) — 架构概览
- [apps/sdk/python/GUIDE.md](apps/sdk/python/GUIDE.md) — agent Python SDK（随镜像分发于 `/opt/aegisx-sdk`）
- [docs/README.md](docs/README.md) — 文档索引（报告、迁移、审计、设计存档）

## 开发

```sh
bun run check   # 格式 + lint + 类型检查（全部 workspace）
bun run test    # 全部测试（`test:sdk` 为 Python SDK 契约测试）
bun run build   # web 生产构建
bun run compile # 服务端 + 前端打进单个可执行文件（dist/aegisx，内嵌 SPA 与迁移）
```

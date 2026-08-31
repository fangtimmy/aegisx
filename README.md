# AegisX

**中文** · [English](README.en.md)

AegisX 是本地单机部署的多智能体 CTF 作战平台。每场赛事一个调度者 agent 负责规划并维护派发队列；求解者 agent——各自独立的模型、提示词与时限——解题、在题目频道沉淀情报并提交 flag。Web UI 提供实时会话、token 用量与队列视图，人通过同一套频道介入。

架构概览：[docs/architecture.md](docs/architecture.md)。使用流程：[docs/usage.md](docs/usage.md)。

## 环境要求

- [Bun](https://bun.sh/) — 本项目仅支持 Bun：安装、开发、测试全部经 bun 执行，不提供对 Node、pnpm 等其他运行时/包管理器的支持。
- Docker
- 解题镜像 — 在仓库根目录构建（默认 `container.image` 为 `aegisx/solver:full`）：

```sh
docker buildx build -f containers/solver/Dockerfile --target full -t aegisx/solver:full .
```

三档镜像：`minimal` 0.85 GB / `essential` 4.75 GB / `full` 16.7 GB，详见 [containers/solver/README.md](containers/solver/README.md)。

## 启动

```sh
bun install    # 仓库根目录，一次安装全部 workspace（单一 lockfile）
bun run dev    # 同时启动 server 与 web
```

打开 Vite 输出的地址（`bun run dev:server` / `bun run dev:web` 可分别启动）。开发服务器将 `/api` 代理到 `http://127.0.0.1:3000`，可用 `VITE_API_URL` 指向其他 API 端点。

## 数据与执行

agent loop 在宿主进程内运行（pi SDK）；bash 与 CTF 工具链在每题一个的 Kali 容器中执行——长寿工具箱，工作区 bind mount——经 `docker exec` 调用；文件工具操作宿主工作区，与容器共享。每个 agent 在题目工作区内有独立目录，共享成果落在 `shared/`（对 agent 只读）。

所有数据存于 `data/`（SQLite 数据库、附件、按赛事划分的工作区），可用 `AEGISX_DATA_DIR` 重定位。

网络：solver 容器在默认 bridge 上持有 `NET_RAW`（或经 `container.networkMode` 共享 VPN 容器的网络命名空间），出站不受限，包括宿主局域网。隔离施加于 solver↔宿主数据 与 solver↔其他题目，不含 solver↔局域网；有需要时通过 `container.networkMode` 收紧。

## 文档

- [docs/usage.md](docs/usage.md) — 使用指南
- [docs/architecture.md](docs/architecture.md) — 架构概览
- [apps/sdk/python/GUIDE.md](apps/sdk/python/GUIDE.md) — agent Python SDK（随镜像分发于 `/opt/aegisx-sdk`）
- [docs/README.md](docs/README.md) — 文档索引（报告、迁移、审计、设计存档）

## 开发

```sh
bun run check   # 格式 + lint + 类型检查（全部 workspace）
bun run test    # 全部测试（test:sdk 为 Python SDK 契约测试）
bun run build   # web 生产构建
```

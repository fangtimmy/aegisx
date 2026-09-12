# AegisX 竞赛 appliance 镜像

面向**完全离线**的 CTF 决赛/评测环境的 all-in-one 单镜像家族：服务端（API + agent 宿主
+ Web UI + 调度者）与解题工具链在**同一容器**（`AEGISX_EXEC_BACKEND=local`），除平台
网关/VPN 外无任何网络，所有工具、词表、知识库、调优在构建期内置，运行时不安装。

全部变体共享 `containers/appliance/Dockerfile` 一个阶段阶梯（knowledges → toolchain →
各 target），用 `--target` 构建不同变体：

| target | 镜像 | 场景 | 手册 |
|---|---|---|---|
| `tsecbench` | `aegisx/tsecbench:v12` | TSecBench 断网评测 | [tsecbench/README.md](tsecbench/README.md) |
| `xihulunjian` | `aegisx/xihulunjian:v2` | 西湖论剑决赛（内置逐题知识库） | [xihulunjian/README.md](xihulunjian/README.md) |

## 构建

构建上下文为仓库根目录。先构建共享的前端+服务端单二进制（`containers/app-build`），
再按需构建目标镜像（amd64；构建机需可访问 kali/pypi 镜像与 github）：

```sh
# 1) 共享构建段：server + web 编译为单可执行文件（内嵌 Bun 运行时、SPA、迁移）
docker buildx build -f containers/app-build/Dockerfile \
  --platform linux/amd64 -t aegisx/app-build:latest .

# 2) 目标镜像（必须显式 --target；不指定时默认构建最后一个 target）
docker buildx build -f containers/appliance/Dockerfile \
  --platform linux/amd64 --target tsecbench -t aegisx/tsecbench:v12 .
docker buildx build -f containers/appliance/Dockerfile \
  --platform linux/amd64 --target xihulunjian -t aegisx/xihulunjian:v2 .
```

工具链的 apt/pip cache mount id（`tsec-apt`/`tsec-pip` 等）跨 target 共享——本机一次
缓存服务所有 appliance 构建。

## 共享机制

- **调优以数据分发**：每个 target 的 `preset.json`（promptHint / settings / scheduler
  三段）构建期 COPY 到 `/opt/aegisx-preset/preset.json`，bootstrap 首启落库——不做
  构建期源码改写，preset 缺失或损坏只记日志跳过。语义见 `apps/server/src/bootstrap.ts`。
- **ENVIRONMENT.md 离线化**：构建期以 `containers/solver/gen-environment.py` 文件系统
  自省生成，并把「缺工具时的安装 SOP」章节替换为各场景的离线文案（离线禁装包）。
- **app 产物**：`/opt/aegisx/aegisx` 单可执行文件（内嵌 Bun 运行时、Web SPA、基线迁移），
  来自 `aegisx/app-build`；Python SDK 固定 COPY 到 `/opt/aegisx-sdk`（`PYTHONPATH` 已设，
  位置不可移动）。
- **升级镜像请用全新 /data 卷**：内置提示词模板行是「已存在则不覆盖」语义，旧卷会保住
  旧版本模板，新镜像的提示词更新不会生效。

各变体的工具链差异（JDK 8、libzbar0/pyzbar/cysignals/fpylll、kb/、事件名）与运行手册
（本地/托管评测操作步骤、镜像体积、出厂自检）见上表两份手册。

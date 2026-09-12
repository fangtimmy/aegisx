# AegisX allinone 镜像

服务端（API + agent 宿主 + Web UI）与解题工具链打包在**同一镜像**里，单容器即整套平台。适合单机部署：不依赖宿主 Docker，起容器后按环境变量自动完成 LLM 接入、赛事绑定、拉题与调度启动。

## 构建

构建上下文为仓库根目录；先构建共享单二进制（`containers/app-build` → `aegisx/app-build:latest`），并确保求解镜像 minimal 档（`containers/solver` → `aegisx/solver:minimal`）已存在，再构建本镜像：

```sh
docker buildx build -f containers/allinone/Dockerfile \
  --platform linux/amd64 -t aegisx/allinone:latest .
```

镜像内布局：`/opt/aegisx/aegisx`（服务端单可执行文件：bun `--compile` 产物，内嵌 Web SPA 与基线迁移 SQL，不含源码）、`/opt/aegisx-sdk`（来自 minimal 档的 Python SDK）、`/data`（数据卷：SQLite、附件、各赛事工作区）。

## 运行

```sh
docker run -d --name aegisx \
  -p 3000:3000 \
  -v aegisx-data:/data \
  -e AEGISX_PROVIDER_BASE_URL=http://llm-gateway:8080/v1 \
  -e AEGISX_PROVIDER_API_KEY=sk-... \
  -e AEGISX_MODEL_ID=glm-5.3 \
  -e AEGISX_EVENT_NAME=qualifiers \
  -e AEGISX_PLATFORM_TYPE=ctfd \
  -e AEGISX_PLATFORM_BASE_URL=https://ctf.example.com \
  -e AEGISX_PLATFORM_CREDENTIAL=<token> \
  aegisx/allinone:latest
```

启动后 Bootstrap 自动执行（幂等，重启安全）：配置 LLM provider 与默认模型 → 创建赛事并绑定平台 → 同步全部题目 → 启动调度者（调度者按策略逐题简报、入队并派 solver 开始答题）。Web UI 在 `http://<host>:3000`。

任何一步失败只记录日志，服务保持可用，可进 UI 手工修复。

**安全边界**：服务端用户面没有任何鉴权（这是本地单机部署的既定边界），而镜像默认 `HOST=0.0.0.0`，会把整套 API（含明文返回的 provider apiKey 与平台凭据）暴露给整个局域网。请绑定 `127.0.0.1` 并置于带鉴权的反向代理之后，或用防火墙限制访问来源。

## 环境变量

完整清单（含镜像内置项与 exec 注入项）见 [docs/env.md](../../docs/env.md)。

| 变量 | 必填 | 说明 |
|---|---|---|
| `AEGISX_PROVIDER_BASE_URL` | 推荐 | LLM API base URL（http/https），与 `AEGISX_MODEL_ID` 成对生效 |
| `AEGISX_MODEL_ID` | 推荐 | 模型 id；元数据命中内置目录则自动带全，否则用保守默认值（可在设置页修正） |
| `AEGISX_PROVIDER_TYPE` | 否 | `openai-compatible`（默认）/ `openai-responses` / `anthropic-messages` |
| `AEGISX_PROVIDER_API_KEY` | 否 | LLM API key |
| `AEGISX_PROVIDER_LABEL` | 否 | provider 显示名，默认 `Bootstrap` |
| `AEGISX_MODEL_EFFORT` | 否 | 思考档位（如 `high`），拼进默认模型引用；非内置目录模型据此推断 `reasoning:true` |
| `AEGISX_MODEL_PROFILE` | 否 | 绑定 pi 内置模型元数据（`<providerId>/<modelId>`，如 `zai/glm-5.3`）——部署的模型 id 是网关变体时直接继承同家族条目的上下文窗口/思考档位/compat |
| `AEGISX_MODEL_METADATA` | 否 | 模型元数据 JSON（`reasoning` / `contextWindow` / `maxTokens` 等，schema 同设置页），逐字段合并到 `AEGISX_MODEL_PROFILE` / 内置目录匹配 / 保守默认值之上 |
| `AEGISX_EVENT_NAME` | 推荐 | 赛事名（不存在则创建，重启用同名赛事） |
| `AEGISX_PLATFORM_TYPE` | 否 | 平台类型：`ctfd` / `a1ctf` / `dasctf` / `ret2shell` / `tsecbench` |
| `AEGISX_PLATFORM_BASE_URL` | 否 | 平台地址 |
| `AEGISX_PLATFORM_CREDENTIAL` | 否 | 平台凭据（CTFd token / a1token cookie / AccessKey / Bearer 等，按平台） |
| `AEGISX_PLATFORM_REMOTE_EVENT_ID` | 否 | 远端赛事 id（ctfd/tsecbench/dasctf 自动合成可省略；a1ctf/ret2shell 必填） |
| `AEGISX_SCHEDULER_INSTRUCTION` | 否 | 调度者自然语言指令（仅在未手工配置过时写入） |
| `PORT` / `HOST` | 否 | 监听端口/地址，默认 `3000` / `0.0.0.0` |

镜像内置的固定环境（`Dockerfile` 中声明）：`AEGISX_EXEC_BACKEND=local`（solver bash 在本容器内执行）、`AEGISX_BOOTSTRAP=1`、`AEGISX_API_URL=http://127.0.0.1:3000`、`AEGISX_DATA_DIR=/data`。

## 与分体部署的差异

- **无题间隔离**：local 执行后端下，所有 solver 的 bash 都在本容器内以 root 运行，共享内核与文件系统命名空间（工作区目录仍然隔离）。这是单机自用部署的明确取舍，勿在多租户环境使用。
- 容器资源限制（`container.cpus/memoryMb/pidsLimit/tmpfsSize`）在 local 后端下不生效。
- 求解工具链为 minimal 档：缺的工具由 agent 按「缺工具 SOP」在解题时现场安装（pip/apt），也可换用更大的基底重建。

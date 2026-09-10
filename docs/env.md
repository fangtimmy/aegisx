# 环境变量总参考

按「谁读、何时生效」分三类。**运行时可设**由使用者按部署方式传入；**镜像内置**焊死在
镜像 ENV 里，覆盖会破坏 appliance 语义；**exec 注入**由服务端在派生 agent 时写入
bash 工具环境，面向容器内的 Python SDK，使用者不应手工设置。

 Bootstrap 相关变量仅在 `AEGISX_BOOTSTRAP=1` 时被读取；bootstrap 幂等——重启时只
补缺失项，绝不覆盖 UI 里已手工配置的值。调优（提示词/调度策略）不走环境变量，走
event preset（`/opt/aegisx-preset/preset.json`，见 `containers/tsecbench/README.md`）。

## 运行时可设

### Appliance bootstrap（`AEGISX_BOOTSTRAP=1` 时生效）

| 变量 | 必填 | 说明 |
|---|---|---|
| `AEGISX_PROVIDER_BASE_URL` | 推荐 | LLM API base URL（须 http/https），与 `AEGISX_MODEL_ID` 成对生效，二者齐备才创建 provider |
| `AEGISX_MODEL_ID` | 推荐 | 模型 id；元数据解析见下方「模型元数据层」 |
| `AEGISX_PROVIDER_TYPE` | 否 | `openai-compatible`（默认）/ `openai-responses` / `anthropic-messages` |
| `AEGISX_PROVIDER_API_KEY` | 否 | LLM API key |
| `AEGISX_PROVIDER_LABEL` | 否 | provider 显示名，默认 `Bootstrap` |
| `AEGISX_MODEL_EFFORT` | 否 | 思考档位（`low`/`medium`/`high` 等），拼进默认模型引用（`model:effort`）；模型元数据未命中目录时据此推断 `reasoning:true` |
| `AEGISX_MODEL_PROFILE` | 否 | 绑定 pi 内置模型元数据，格式 `<providerId>/<modelId>`（如 `zai/glm-5.3`）。部署的模型 id 是网关变体时，直接继承同家族条目的上下文窗口/思考档位表/compat。不存在时 bootstrap 报错（记日志，不影响启动） |
| `AEGISX_MODEL_METADATA` | 否 | 模型元数据 JSON（schema 同设置页：`reasoning`/`thinkingLevelMap`/`input`/`cost`/`contextWindow`/`maxTokens`/`headers`/`compat`），逐字段合并到 PROFILE / 目录匹配 / fallback 之上。坏 JSON 或未知字段在启动时报错 |
| `AEGISX_EVENT_NAME` | 否 | 赛事名（不存在则创建，重启复用同名赛事） |
| `AEGISX_PLATFORM_TYPE` | 否 | `ctfd` / `a1ctf` / `dasctf` / `ret2shell` / `tsecbench`；仅给 `BENCHMARK_BASE_URL` 时自动判 `tsecbench` |
| `AEGISX_PLATFORM_BASE_URL` | 否 | 平台地址；与 `AEGISX_PLATFORM_TYPE`（或 BENCHMARK 回退）齐备才绑定 |
| `AEGISX_PLATFORM_CREDENTIAL` | 否 | 平台凭据（CTFd token / a1token cookie / AccessKey / Bearer 等，按平台） |
| `AEGISX_PLATFORM_REMOTE_EVENT_ID` | 否 | 远端赛事 id；ctfd/tsecbench/dasctf 自动合成可省略，a1ctf/ret2shell 必填 |
| `BENCHMARK_BASE_URL` | 否 | TSecBench 托管 harness 注入；`AEGISX_PLATFORM_BASE_URL` 的回退 |
| `BENCHMARK_TOKEN` | 否 | 托管 harness 注入；`AEGISX_PLATFORM_CREDENTIAL` 的回退（`AEGISX_*` 显式给出时优先；只有 TOKEN 没有 BASE_URL 则不绑定平台） |
| `AEGISX_SCHEDULER_INSTRUCTION` | 否 | 调度者自然语言指令；建赛事时随调度策略写入，重启时仅在用户未自设指令时补写 |

**模型元数据解析层**（最优先在前）：
`AEGISX_MODEL_METADATA` 字段合并 → `AEGISX_MODEL_PROFILE` 绑定 → pi 内置目录按
`AEGISX_MODEL_ID` 匹配 → 保守 fallback（`AEGISX_MODEL_EFFORT` 存在时推断
`reasoning:true`）。落库来源记在模型条目的 `metadataSource`（`env` / `pi:<id>` / `bootstrap`）。

### 服务器运行（进程启动时读取，与 bootstrap 无关）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AEGISX_DATA_DIR` | `<repo>/data` | 数据根目录（SQLite、config.json、工作区、附件）。镜像内置为 `/data` 并挂 VOLUME |
| `AEGISX_EXEC_BACKEND` | `docker`（每题一个 solver 容器） | `local` = solver bash 与服务端同容器执行（单镜像 appliance 模式） |
| `AEGISX_WEB_DIR` | 未设 = 纯 API | 设值则从该目录托管 Web 静态产物（镜像内置 `/opt/aegisx-web`；开发模式不设，走 vite 代理） |
| `AEGISX_API_URL` | `http://host.docker.internal:3000` | 容器内 agent 访问服务端 API 的地址；docker 后端下 `127.0.0.1`/`localhost` 自动改写为 `host.docker.internal`，local 后端原样使用 |
| `AEGISX_SDK_PATH` | 未设 | **开发用**：把宿主机的 SDK 目录只读挂载进 solver 容器 `/opt/aegisx-sdk`（镜像构建时已 COPY，无需设置） |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | docker 后端的 socket 路径 |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | 服务监听地址/端口（镜像内置 `0.0.0.0`/`3000`；用户面无鉴权，暴露局域网前先读 allinone README 安全边界一节） |

## 镜像内置（不要覆盖）

| 变量 | 值 | 出处 |
|---|---|---|
| `AEGISX_BOOTSTRAP` | `1` | tsecbench / allinone 镜像：启用 appliance 自动装配 |
| `AEGISX_EXEC_BACKEND` | `local` | tsecbench / allinone 镜像：单容器模式 |
| `AEGISX_DATA_DIR` | `/data` | 同上，数据卷挂载点 |
| `AEGISX_API_URL` | `http://127.0.0.1:3000` | 同上，local 后端回环地址 |
| `AEGISX_WEB_DIR` | `/opt/aegisx-web` | 同上，Web 静态产物位置 |
| `PYTHONPATH` | `/opt/aegisx-sdk` | 同上，SDK 免配置导入（出厂自检项，见 tsecbench README） |
| `KNOWLEDGES_DIR` | `/opt/solver/knowledges` | solver 镜像（三档）：离线知识库位置，ENVIRONMENT.md 引用 |

## exec 注入（面向容器内 agent，勿手工设置）

服务端派生 agent 时写入 bash 工具环境；Python SDK（`apps/sdk/python/GUIDE.md`）靠它们
找到 API 与身份：

| 变量 | 注入粒度 | 说明 |
|---|---|---|
| `AEGISX_EVENT_ID` | 每 challenge 容器 | 赛事 id，SDK 调用按此路由 |
| `AEGISX_API_URL` | 每 challenge 容器 | 服务端地址（上表运行时变量的派生值） |
| `AEGISX_AGENT_ID` | 每次 bash exec | agent 身份；同一题的 N 个 agent 共享容器、各自区分 |
| `AEGISX_TOKEN` | 每次 bash exec | agent 调用凭据，与 AGENT_ID 配对 |
| `PYTHONPATH` | SDK 挂载时 | 仅开发挂载（`AEGISX_SDK_PATH`）或镜像内置时存在 |

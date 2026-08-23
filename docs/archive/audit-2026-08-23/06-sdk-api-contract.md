# SDK 与 API 契约审查

## 范围与方法

- 审查对象：`apps/sdk/python`（Python SDK，非 TS 包）、`apps/server/src/*/routes.ts` 七个路由模块与 `app.ts` 注册中心、`apps/shared` 共享类型、`containers/solver/Dockerfile`、`apps/server/scripts/sdk-contract.ts`。
- 方法：纯静态阅读。先建立路由全景（`grep` 全部 `app.get/post/put/patch/delete` 注册点，展开多行注册），再逐条对照 SDK 方法；handler 响应形状通过追入 service 层（`run/service.ts`、`run/channels.ts`、`run/queries.ts`、`events/catalog.ts`）核实。未启动服务器、未执行测试。

## 契约架构梳理（shared/sdk/routes 三方类型流向）

```
apps/shared/*.ts (TS wire types, 46 处 server 引用 + 7 处 web 引用)
        │  import type
        ├──► apps/server handlers（响应形状由 service 层构造，如 fleet()/toPublic()）
        └──► apps/web（直接 fetch + 共享类型）
apps/sdk/python/aegisx/models.py（手写 dataclass 镜像，camelCase→snake_case）
        │  HTTP/JSON
        └──► apps/server
```

- **shared 是唯一 TS 侧契约源**：`queue.ts`（QueueItemPublic/QueueSnapshot）、`agent.ts`（AgentSummary/AgentDetail）、`channels.ts`（ChannelPublic/ChannelMessagePublic/ChannelMessageMeta）、`scheduler.ts`（SchedulerStatusSnapshot/FleetInfo）。server 与 web 均 import，无重复定义。
- **Python SDK 无法引用 TS 包**，`models.py`（319 行）是纯手工镜像：`from_dict()` 做 camelCase→snake_case 映射、忽略未知键、只对 `list[<Dataclass>]` 注解递归构造（models.py:66-79）。漂移检测依赖"已知字段缺失时 `cls(**kwargs)` 抛 TypeError"这一副作用（见发现 F2）。
- **server handler 返回类型无显式契约**：路由层一律 `c.json(...)` 内联返回，返回值类型由 service 函数的返回类型间接决定（如 `fleet(): FleetInfo`、`listMessages(): MessageList`）。没有 OpenAPI/schema 化的响应描述；请求体有 TypeBox 校验（`validateJson`），响应体没有。
- **SDK 进容器路径**：`containers/solver/Dockerfile:152` `COPY apps/sdk/python /opt/aegisx-sdk` + `PYTHONPATH=/opt/aegisx-sdk`（Dockerfile:156）；dev 覆盖为 `AEGISX_SDK_PATH` bind-mount（`run/agent-factory.ts:85-94`）。身份经 per-exec env 注入：容器级 `AEGISX_EVENT_ID`/`AEGISX_API_URL`（agent-factory.ts:110-114、119-126），per-exec `AEGISX_AGENT_ID`+`AEGISX_TOKEN`。编排提示词引导 agent 先读 `/opt/aegisx-sdk/GUIDE.md`（orchestration/prompt-defaults.ts:25-26）。

## 路由对照表

### A. SDK 覆盖的路由（agent/scheduler 面）

| Method + Path | SDK 方法 | 一致性 |
|---|---|---|
| GET `/api/events/:eventId` | `challenges.list()` / `snapshot()` | 一致（ChallengePublic 19 字段与 models.Challenge 逐一对应） |
| GET `/api/events/:eventId/fleet` | `agents.list()` / `snapshot()` | 一致（fleet 的 challenges 为 3 字段 digest，SDK 刻意从 event 端点取全量记录，__init__.py:115-118） |
| GET `/api/events/:eventId/queue` | `queue.list()` / `queue.state()` | 一致（`{items,state}` ↔ QueueSnapshot） |
| POST `/api/events/:eventId/queue` | `queue.enqueue()` | 一致；服务端额外支持 `promptMode`，SDK 未暴露（见 F5）；返回 202 |
| POST `/api/events/:eventId/queue/pause` | `queue.pause()` | 一致 |
| POST `/api/events/:eventId/queue/resume` | `queue.resume()` | 一致 |
| DELETE `/api/events/:eventId/queue/:itemId` | `queue.remove()` | 一致（204→None） |
| POST `/api/events/:eventId/queue/clear` | `queue.clear()` | 一致 |
| POST `/api/events/:eventId/queue/reorder` | `queue.reorder()` | 一致（body `{itemIds}`） |
| PATCH `/api/events/:eventId/queue/:itemId` | **缺失** | 服务端有编辑队列项能力，SDK 无对应方法（见 F4） |
| GET `/api/events/:eventId/scheduler` | `status()` | 一致（读 `.status` ↔ SchedulerStatusSnapshot 六字段全对应） |
| GET `/api/challenges/:challengeId` | `challenges.get()` | 一致 |
| POST `/api/challenges/:challengeId/agents` | `agents.start()` | 一致；同上 promptMode 未暴露；429 capacity 契约一致 |
| GET `/api/agents/:agentId` | `agents.get()` / `agents.read()` | 形状一致；但 SDK `AgentRead.agent` 注解与运行时不符（F1） |
| GET `/api/agents/:agentId/messages` | `agents.read()` | 一致（读 `{items:[{entry:{message}}]}`，limit 为客户端截断） |
| POST `/api/agents/:agentId/stop` | `agents.stop()` | 一致（服务端要求 emptyInput body，SDK 发 `{}` ✓） |
| POST `/api/agents/:agentId/close` | `agents.close()` | 一致 |
| POST `/api/agents/:agentId/finish` | `agents.finish()` | 一致（`{summary}` 可选） |
| POST `/api/agents/:agentId/compact` | `agents.compact()` | 一致（409 invalid_state 契约有测试覆盖） |
| POST `/api/agents/:agentId/timeout` | `agents.set_timeout()` | 参数下限不一致：服务端 `minimum:60_000`，SDK 不校验（F6） |
| GET `/api/agents/:agentId/channels` | `channels.list()` | 一致（`{items}` ↔ ChannelPublic[]） |
| GET `/api/channels/:channelKey/messages` | `channels.read()` | 一致（query limit/after/markRead=0 与服务端解析吻合，run/routes.ts:571-580） |
| POST `/api/channels/:channelKey/messages` | `channels.post/ask/announce`、`agents.message` | 一致；text 上限 16K（run/routes.ts:690）对 `agents.message` 同样生效（F6） |

### B. 服务端有、SDK 未覆盖的路由（按面分组）

- **用户/UI 面（设计上不对 agent 开放，SDK 不覆盖属正常）**：
  - events CRUD：POST/GET `/api/events`、PATCH/DELETE `/api/events/:id`、`/usage`、DELETE `/agents`、DELETE `/challenges`
  - challenges 管理：POST/PATCH `/api/challenges/:id`、`/solved`、`/flags`、`/flags/:flagId` DELETE、`/remote/refresh`、DELETE、`/attachments`、`/api/attachments/:id`
  - platforms 全部（discover/test/bind/sync/stream/target）、providers 全部、settings 全部、`/api/activity`、`/api/platform/status`
  - 运行细节面：`/halt`、`/files`、`/files/download`、SSE stream（agent/channel）、model switch、PUT `/api/agents/:id/queue`（steering 替换）、sessions list/create/activate、backtrack、DELETE agent、challenge channel tree、channel files/download
- **调度器自身生命周期（用户面，合理缺失）**：inbox GET/pause/resume、`scheduler/start|stop|close|pause|resume|message`、PATCH scheduler config
- **值得注意的缺口**：
  - `PATCH /api/events/:eventId/queue/:itemId`（编辑 prompt/timeout/params）——管理面能力，调度 agent 无法用（F4）
  - `POST /api/agents/:agentId/message`——服务端原生直发消息路由（messageInput，20K 上限）；SDK 用 DM 频道路径替代，两条路径并存且上限不同（F6）
  - `POST /api/agents/:agentId/flag`——flag 提交路由；solver token 被 agentAuth 判 403（verdict 仅放行 solver 的 GET self face），scheduler token 可调用，SDK 未封装（F9）

### C. SDK 有、服务端不存在的端点

**无**。全部 27 个 SDK 公开方法均可映射到真实路由，无幻影方法。

## 发现

### F1 · P2 · `AgentRead.agent` 类型注解与运行时不符

- 位置：`apps/sdk/python/aegisx/models.py:227`、`models.py:66-79`、`contract.py:84`
- 证据：`AgentRead` 声明 `agent: AgentSummary`，但 `from_dict._convert_field` 只对 `list[<Dataclass>]` 注解递归构造，普通字段原样透传 → 运行时 `agent` 是 raw dict。SDK 自己的契约测试也是按 dict 用的：
  ```python
  detail = aegisx.agents.get(SOLVER_ID)
  assert detail.agent["id"] == SOLVER_ID   # contract.py:84
  ```
- 后果：按注解写 `detail.agent.id` 会 AttributeError；类型即文档的承诺被打破，嵌套单对象字段永远拿不到 dataclass。同类问题潜伏于任何未来新增的非 list 嵌套字段。

### F2 · P2 · 字段缺失时抛裸 TypeError，破坏"一切失败皆 AegisxError"的错误契约

- 位置：`apps/sdk/python/aegisx/models.py:82-97`；契约声明见 `client.py:34-42`、`GUIDE.md:89-101`
- 证据：`from_dict` 忽略未知键，但对**已知字段缺失**无防御——`cls(**kwargs)` 直接抛 `TypeError: __init__() missing 1 required positional argument`。docstring 称之为有意的 drift detection（"a MISSING known field fails loudly"），但失败形态不是 `AegisxError`，agent 侧脚本若只捕 `AegisxError`（GUIDE 的指示）会被裸异常击穿。
- 后果：server 改名/删除任一 SDK 已知字段时，所有相关 SDK 调用点以未文档化的异常形态崩溃，错误处理分支（`.code` 分派）失效。当前 ChallengePublic 与 models.Challenge 字段逐一核对一致，暂无现实触发。

### F3 · P2 · 三方契约中 SDK 类型为手工镜像，且无版本同步机制

- 位置：`apps/shared/channels.ts:1-4`、`apps/sdk/python/aegisx/models.py`、`containers/solver/Dockerfile:147-156`、`apps/server/src/run/agent-factory.ts:73-94`
- 证据：
  - `shared/channels.ts` 头注释声称 "Canonical definition — the server's channel service, **the Python SDK** and the web UI all import from here" —— Python SDK 是手写复制，不可能 import TS 包；该注释与现实不符。
  - 同步手段仅两处：`bun run test:sdk`（起真服跑 contract.py）与人工重建 solver 镜像（COPY 打包）。pyproject 版本恒为 0.1.0；client 从不读取 `GET /` 返回的 SCHEMA_VERSION，无任何握手/版本协商。
- 后果：改了 shared/handler 而忘记跑 test:sdk 或忘记重建镜像时，容器内的旧 SDK 会对新 API 静默漂移（from_dict 忽略新增键 → 表现为字段悄悄变 None/缺省而非报错）；镜像内 SDK 版本不可观测。

### F4 · P3 · 队列项编辑：服务端有能力、SDK 缺方法、docstring 却引用它

- 位置：`apps/server/src/scheduler/routes.ts:195-219`；`apps/sdk/python/aegisx/queue.py:72`
- 证据：server 有 `PATCH /api/events/:eventId/queue/:itemId`（prompt/timeoutMs/params）；SDK queue 命名空间只有 list/state/enqueue/pause/resume/remove/clear/reorder。而 `queue.pause()` docstring 写着 "**edit**/reorder/remove still work"——指向一个不存在的方法面。
- 后果：调度 agent 无法在 SDK 内修改已入队任务的策略，只能 remove+enqueue（丢失排序位）；文档误导。

### F5 · P3 · `promptMode` 对 SDK 用户不可达，docstring 却引导"server-side 传参"

- 位置：`apps/server/src/run/routes.ts:26-28,41-43`；`queue.py:52-53`、`agents.py:169-171`
- 证据：两个 spawn 入口均支持 `promptMode: "strategy"|"override"`；SDK 两处 docstring 都写 "`prompt_mode='override'` is the server-side field, not exposed here"。但容器内 agent 被 GUIDE 明令禁止绕过 SDK 用 curl（GUIDE.md:105-106）——所谓 server-side 路径对目标用户不存在。
- 后果：override 语义（整段替换首 prompt）实际无人能用；要么暴露参数，要么删掉死参数的服务端支持，二选一。

### F6 · P3 · 参数边界不对称：16K vs 20K 文本上限、timeoutMs 下限无客户端校验

- 位置：`apps/server/src/run/routes.ts:690`（频道 post 16K）、`run/routes.ts:74`（直发 message 20K）、`run/routes.ts:29,44,51`（timeoutMs minimum 60000）
- 证据：`agents.message()` 走频道 DM 路径，实际受 16K 限制；同语义的原生 `/api/agents/:id/message` 是 20K。`set_timeout(ms)` 传 <60000 时服务端返回 400 `invalid_request`，SDK 不预检、GUIDE 未提示。
- 后果：同为"给 agent 发消息"，两条路径上限不同易踩坑；小 timeout 得到的 400 报错文案（"Invalid request body"）不解释原因。

### F7 · P3 · 非 JSON 错误体降级为 `http_error`；GUIDE 错误码表不全

- 位置：`apps/sdk/python/aegisx/client.py:109-127`；`apps/server/src/app.ts:74-84`；`infrastructure/validation.ts`；`GUIDE.md:94-101`
- 证据：错误信封统一为 `{error:{code,message}}`（http-errors.ts），SDK 双形态兼容（含 legacy top-level）✓；400 validation 能正确解析出 `invalid_request` ✓。但 Hono 对未注册路由默认 text/plain 404、反代 HTML 错误页等非 JSON 体走 `_http_error` 的 except 分支 → `code="http_error"`，语义尽失。GUIDE 错误表只列 6 个 code，未列 server 实际会返回的 `invalid_request`/`invalid`/`internal_error`/`platform_error`/`launch_failed`/`not_bound`。
- 后果：可接受的降级（不崩溃），但 agent 按 `.code` 分派时会遇到文档外代码；部分中文错误消息（如 run/routes.ts:526 "非法频道键"）原样透传给英文提示语境的 agent。

### F8 · P3 · contract 测试覆盖缺口 + 游离于 bun test 之外

- 位置：`apps/server/scripts/sdk-contract.ts:8-9`、`apps/sdk/python/contract.py`
- 证据：已覆盖 snapshot/status/challenges(get,list)/agents(list,get,read-limit,set_timeout,finish,compact-409,get-404)/queue(state,pause,enqueue,reorder,remove,resume)/channels(announce,read,list,post,ask)+四类权限矩阵（scheduler/solver/tokenless/bad token）。**未覆盖**：`agents.stop/close/start/message`、`queue.clear`、`challenges.get` 404、mark_read 游标推进语义（pull=read 的核心承诺）、附件 files 上传路径、urgent 即时投递。且 runner 自述 "Not part of `bun test` (deliberately)"，依赖人工触发。
- 后果：上述方法回归只能靠生产撞上；test:sdk 本身可能长期不跑。

### F9 · P3 · flag 提交路径：solver 无入口，SDK 未封装（意图未确认）

- 位置：`apps/server/src/infrastructure/agent-auth.ts` verdict()（solver 仅放行 GET self face）；`run/routes.ts:482-506`
- 证据：`POST /api/agents/:agentId/flag` 对 solver token 一律 403，scheduler token 可代提交；SDK 与 GUIDE 均未提及 flag 提交方式（solver 侧如何交 flag——经平台集成自动接受？还是必须人工 UI？——静态阅读未见闭环）。
- 后果：若设计预期是"solver 通过平台工具交 flag"则成立；否则存在功能死角。列入待确认。

### F10 · P3 · 所有频道 post 被服务端注入 `deliverAs="steer"` 冗余字段

- 位置：`apps/server/src/run/routes.ts:703`
- 证据：`const deliverAs = input.deliverAs === "followUp" ? "followUp" : "steer"` 对 JSON 频道 post 无条件生效（包括 team 广播、orch 提问）；`deliverAs` 仅对 dm 投递有意义（channels.ts:873 投递链路）。
- 后果：wire 上携带对多数频道无意义的字段；无害但说明该 handler 手工解析（无 schema 校验）积累了语义模糊。

## 建议

1. **修 F1**：让 `from_dict` 支持单个 dataclass 注解递归（或把 `AgentRead.agent` 注解改为 `dict`）。一处改动，消除注解谎言。
2. **修 F2**：`from_dict` 缺已知字段时抛 `AegisxError("bad_response", ...)`，保住"一切失败皆 AegisxError"的单一错误出口；drift 检测语义不变，形态归一。
3. **补 F4 二选一**：给 queue 加 `edit()` 封装（PATCH 已在服务端就绪），或删 docstring 中的 "edit" 字样。
4. **澄清 F5**：暴露 `prompt_mode` 参数，或在 server 端删掉 spawn 的 `promptMode`（当前是死配置）。
5. **同步机制最小化**：`shared/channels.ts` 头注释删去 "the Python SDK"；在 solver 镜像构建 CI 中加一步 `bun run test:sdk`（或至少在 Dockerfile 层变更检查中提醒重建），使"改 SDK 忘建镜像"有护栏。版本协商可不做（本地单兵场景，test:sdk + 重建即可）。
6. **补 contract 用例**：优先 mark_read 游标推进（pull=read 是 SDK 核心承诺）、agents.stop/close/message、queue.clear；并把 test:sdk 挂入 CI 或 pre-commit 触发。
7. **GUIDE 错误码表补全**：加入 `invalid_request`/`invalid`/`internal_error`/`platform_error`，注明非 JSON 响应会降级为 `http_error`。

## 未确认事项

- **F9 flag 闭环**：solver 是否经平台集成（remote 平台轮询/工具）自动交 flag，从而无需 SDK/API 入口——需运行时验证或询问作者。
- **F10 deliverAs 对 orch/team post 的实际影响**：静态看仅 dm 投递消费该字段，但未追踪 delivery tick 全链路，不能排除 orch→scheduler 投递也用它。
- **镜像内 SDK 与仓库的实际漂移现状**：本机是否近期重建过 `aegisx/solver:kali` 未验证（无 docker 运行许可）；若镜像陈旧，F3 所述静默漂移可能已经发生。
- `agents.message` 的 `urgent=True` 默认值与服务端 `input.urgent === true` 语义一致，但其"terminal agent 重开"行为链路（channels.ts 投递逻辑）未逐行核验。

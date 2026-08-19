# SDK 重构:agent 身份、权限收口与契约测试

问题起点:HTTP 同时承担 User API、Agent API、身份认证、权限边界四个职责,导致——
调度者可用 raw curl 打用户面(event/challenge 删除等 destructive 操作)、
`X-Aegisx-Agent-Id` 身份客户端自报、`source` 字段可伪造、SDK 与 server 契约
漂移无人发现(P0 `snapshot()` 崩溃即实例)、SDK 缺管理面(pause/resume)逼调度者绕过 SDK。

修复方式是身份与权限收口,不换传输层。HTTP 保留。

## W1 — agent token + 服务端权限收口

- `agents` 表加 `token` 列(migration `0014`,唯一索引;存量行回填
  `lower(hex(randomblob(32)))`)。spawn 时生成(64 hex),随 per-exec env
  `AEGISX_TOKEN` 与 `AEGISX_AGENT_ID` 并行注入 bash exec。
- `app.ts` 挂全局中间件(`src/infrastructure/agent-auth.ts`):
  `Authorization: Bearer <t>` → 查 agents 行 → principal
  `{id, eventId, challengeId, role}`。无效 token → 401 `unauthorized`。
- principal 的请求只放行 agent API,由一个显式 verdict 函数判定(约 60 行,
  集中全部规则,不命中默认 403 `forbidden`):

| 面                                                                                      | 角色               | 规则                       |
| --------------------------------------------------------------------------------------- | ------------------ | -------------------------- |
| `GET /api/events/:eid`(snapshot 数据源)、`/fleet`、`/queue`、`/scheduler`               | scheduler          | `:eid` 须为自身 event      |
| queue 全套(POST enqueue、DELETE/`:itemId`、clear/reorder/pause/resume)                  | scheduler          | 同上                       |
| `GET /api/challenges/:cid`、`POST /api/challenges/:cid/agents`                          | scheduler          | challenge 须属自身 event   |
| `/api/agents/:id/**`(detail/messages/stop/close/finish/timeout/compact/message、DELETE) | scheduler          | 目标 agent 须属自身 event  |
| `GET/POST /api/channels/:key/messages`                                                  | scheduler + solver | 可见性由 channels 服务强制 |
| `GET /api/agents/:id`、`/messages`、`/channels`                                         | solver             | 仅自身(`self-only`)        |

- 用户面(events/challenges CRUD、providers、settings、platforms、scheduler
  配置/start/stop、activity)对 agent principal 一律 403。
- 无 token 请求照旧全通过(UI 不受影响)。残余边界:容器内不带 token 的
  裸 curl 仍可达用户面——与既有接受的边界同类,本地单兵场景接受。
- channels 路由的 agent 身份从 principal 推导,`X-Aegisx-Agent-Id` header 机制删除。

## W2 — origin 不可伪造

- `enqueueInput` / `spawnInput` / pause/resume body 的 `source` 字段删除;
  服务端从 principal 推导(有 scheduler token → `scheduler`,无 → `manual`),
  写入既有 `agents.source` / `spawn_queue.source` 列与队列通知文案。
- `finish` 的 `agent.finished` 事件与 meta 补 `actor: "user" | "scheduler"`。
  其余 mutation 不发 orch 事件是既有投递预算设计,不为审计加噪音。

## W3 — SDK 修复与面补全

- P0:`snapshot()` 的 challenges 改回 `GET /api/events/:eid`(完整
  publicChallenge;fleet 保持 3 字段供 web 概览)。
- P1:`agents.read(agent_id, last_n)` 客户端截尾。
- 补全:`queue.pause()` / `queue.resume()`、`agents.finish(agent_id, summary)`、
  `agents.compact(agent_id)`。
- token 自动携带(`AEGISX_TOKEN` env → Bearer header);删 `require_manager()`
  客户端 gate 与 `AEGISX_ROLE` 依赖——服务端 403 是唯一边界;
  `agents.start`/`queue.enqueue` 删 `source` 参数。
- 错误模型保持 `AegisxError(code/status)`;常见 code 表进 GUIDE.md。

## W4 — 分发:镜像内置 + dev override

- `containers/solver/Dockerfile` `COPY apps/sdk/python /opt/aegisx-sdk` +
  `ENV PYTHONPATH`;构建上下文改 repo 根(README build 命令同步)。
- 宿主 bind mount 仅在显式 `AEGISX_SDK_PATH` 时挂载(改代码即生效),
  失败 throw;默认走镜像内置。`AEGISX_ROLE` 注入删除。
- 注入的 `AEGISX_API_URL` 为 127.0.0.1/localhost 时归一化为
  `host.docker.internal`(容器内语义)。
- SDK 保持 stdlib 零依赖(无痛点,不主动引入库)。

## W5 — 契约测试(独立 `bun run test:sdk`)

- `apps/sdk/python/contract.py`:对真实 server 全 namespace 走查 +
  权限矩阵断言(scheduler/solver/无 token 三面)+ 错误契约
  (403 forbidden / 404 not_found / 401 unauthorized / invalid_state)。
- `apps/server/scripts/sdk-contract.ts`:temp dataDir 起真实 app
  (`createApp` 增返 `db`),直插 fixture(event、challenge、带 token 的
  scheduler/solver agent 行、solver session entries),随机端口,
  子进程 `uv run` 跑 contract.py,断言退出码。
- enqueue 在 paused 队列上验证(不触发真实 spawn,免 docker 依赖)。
- `smoke.py` 删除;contract.py 是唯一冒烟入口。

## W6 — GUIDE.md + 提示词收敛

- `apps/sdk/python/GUIDE.md`(随 COPY 进镜像):身份与角色、命名空间总表、
  决策工作流、错误 code 表、输出预算纪律、heredoc 模式。
- `orchestratorSystem` 的 SDK API 罗列段与 solver `mainSystem` 的 channels
  用法段收敛为指向 GUIDE.md 的短段;策略性内容(queue 即计划、频道分工、
  手动 agent 纪律)保留。走 `refreshBuiltinTemplateSections` section 刷新
  (用户编辑过的段保留)。
- `docs/scheduler-python-sdk.md` 删除;GUIDE.md 是唯一事实来源。

## 权限矩阵(test:sdk 断言的契约)

| 操作                                                                   | user(无 token)      | scheduler token | solver token |
| ---------------------------------------------------------------------- | ------------------- | --------------- | ------------ |
| snapshot / fleet / queue 读                                            | ✓                   | ✓               | ✗ 403        |
| enqueue / pause / resume / reorder / clear / remove                    | ✓(manual)           | ✓(scheduler)    | ✗ 403        |
| spawn(`agents.start`)                                                  | ✓(manual)           | ✓(scheduler)    | ✗ 403        |
| agents 读管(stop/close/finish/timeout/compact)                         | ✓                   | ✓(同 event)     | ✗ 403        |
| agents 读自己 detail/messages                                          | ✓                   | ✓               | ✓            |
| channels 读发 / ask / announce                                         | ✓(用户面 multipart) | ✓               | ✓(自身身份)  |
| events/challenges CRUD、providers、settings、platforms、scheduler 配置 | ✓                   | ✗ 403           | ✗ 403        |
| 无效 token                                                             | —                   | 401             | 401          |

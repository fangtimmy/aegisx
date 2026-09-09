# 使用指南

## 首次使用

1. **配置模型** — 设置 → 模型：添加 provider（OpenAI 兼容 / OpenAI Responses / Anthropic Messages），发现模型，设置默认模型。
2. **创建赛事并绑定平台** — 首页创建赛事；在赛事设置中绑定平台（CTFd、A1CTF、DASCTF、Ret2Shell、TSecBench）。绑定后即获得题目同步、远程 flag 提交与靶机实例生命周期管理。
3. **启动调度** — 赛事 Tasks 页启动调度者，由它观察态势、规划并填充派发队列；也可不经调度者，在同一页手动入队或直接派发求解者。
4. **跟踪与介入** — Tasks 查看队列与实时会话，Stats 查看 token 用量；向题目的 `#team` 发帖或私信求解者即可介入，消息与 agent 消息出现在同一条时间线上。

## 配置

全局设置在 Web UI 设置页：

- agent 默认值：默认模型、上下文压缩、重试
- 调度：并发上限与任务超时
- 容器：资源、镜像、`container.networkMode`

每赛事的调度策略在赛事自己的设置页：模型、常驻指令、并发靶机槽位、flag 处置。

## TSecBench 断网评测镜像

`aegisx/tsecbench` 是面向 TSecBench 断网评测的 all-in-one 单镜像（服务端 + Web + 求解
工具链同容器，`AEGISX_EXEC_BACKEND=local`）：工具集与词表按全量跑实测裁剪，TSecBench
平台简报与调度策略（靶机槽 3、解出即停）烘焙进镜像，运行时只注入 LLM 与平台凭据。
未压缩 3.06GB / 压缩 965MB。构建与运行见 [containers/tsecbench/README.md](../containers/tsecbench/README.md)。

## LLM 网关 relay

部分赛事会发放固定端点的 LLM 代理 URL。这类网关对任何追加路径都返回 404，而所有 provider 类型都会在 base URL 后追加 `/chat/completions` 等路径，因此无法直接接入。

```sh
bun run relay <upstream-url> [port]   # 默认 8788，每个上游一个进程
```

relay 原样转发所有请求（含流式）。将 `openai-compatible` provider 指向 `http://127.0.0.1:<port>/v1` 即可；此类网关不提供 `GET /models`，模型需在设置页手工添加。

# 未修事项与既定决策

2026-08-23 审计（archive/audit-2026-08-23/）经三轮修复后，剩余项的去向在此留档，
避免后续轮次重新提名已否决的内容。活文档仅两份：本文件与 migrations.md；
其余历史设计与审计报告在 archive/，git 历史是最终归档。

## 明确不修（2026-08-23 决策）

| 项 | 出处 | 理由 |
|---|---|---|
| 模板 seed 升级为「内容比对更新」 | 05 P1 | 维持 seed-once；若未来改内置模板，需手动删 prompt_templates 的 builtin 行让重启重播 |
| release 二进制 sha256 pin | 03 F5 | 单兵自用，接受首次下载的投毒窗口 |
| SSE 重连草稿重放 | 07 F6 | 服务端保留瞬态草稿不值罕见时序下的一次视觉闪烁 |
| solver↔LAN 网络隔离 | 03 F2 | 刻意放开；边界声明已写入 README（bridge + NET_RAW + 出站不限） |
| calendar.tsx / react-day-picker 清理 | 08 H-4 | ui/** 只读区，接受组件闲置、依赖留存 |
| uv.lock 入库 | 08 H-7 | SDK 零依赖，锁文件无可钉内容 |
| ord 并发撞号、close() 窄窗口等理论竞态 | 02 F5/F8 | 触发条件不成立，取舍已记录于报告 |

## 待确认

- **solver 交 flag 的闭环**：`POST /api/agents/:id/flag` 对 solver token 是 403，
  SDK/GUIDE 均未描述提交方式。若设计预期是「经平台集成自动接受」则成立，
  否则存在功能死角（06 F9）。

## 运维待办

- [ ] **重建 solver 镜像**：镜像内的 SDK 与 ENVIRONMENT.md 落后于仓库
  （2026-08-23 的 SDK 契约修复未带入；dev 模式走 `AEGISX_SDK_PATH`
  bind-mount 不受影响）。重建前先跑 `bun run test:sdk`。

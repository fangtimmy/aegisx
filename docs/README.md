# AegisX 文档索引

| 文档 | 内容 |
|---|---|
| [usage.md](usage.md) | 使用指南：首次使用流程、配置、LLM 网关 relay |
| [aegisx-report.md](aegisx-report.md) | 成果报告：架构理念、实战成绩（西湖论剑 / TSecBench），配图在 [figures/](figures/) |
| [architecture.md](architecture.md) | 架构概览（活文档）：包与模块划分、数据模型、agent 生命周期、协作与调度数据流 |
| [migrations.md](migrations.md) | 数据库迁移工作流：版本机制、开机三态协商、无升级路径、schema 变更步骤 |
| [env.md](env.md) | 环境变量总参考：运行时可设 / 镜像内置 / exec 注入三类，含默认值与生效时机 |
| [audit-2026-08-20.md](audit-2026-08-20.md) | 技术债审计（活文档）：问题清单与逐项修复状态标记 |
| [audit-2026-09-09.md](audit-2026-09-09.md) | 优化与重构审计（活文档）：P0 均带可复现实证，含上轮审计的逐项复核、同日二轮复审合并（P1-15 至 P1-20）、修复顺序与明确不动清单 |
| [architecture-review-2026-09-10.md](architecture-review-2026-09-10.md) | 架构评审与重设计提案（已实施）：结构性痛点清单（所有权分散 / 时间不可控 / 双实现温床）、八项提案及逐项落地提交（提案 1–7 已实施，8 不做）、不动清单 |
| [archive/](archive/) | 历史存档：12 份已实施的设计/实施文档（含 TSecBench 跑批复盘与镜像方案）+ [audit-2026-08-23/](archive/audit-2026-08-23/) 专项审查。含对已删文件的引用，有意保留，不再更新 |

仓库其他位置的文档：

- [apps/sdk/python/GUIDE.md](../apps/sdk/python/GUIDE.md) — Python SDK 参考；运行时资产，随镜像分发到 `/opt/aegisx-sdk`，位置固定不可移动
- [containers/solver/README.md](../containers/solver/README.md) — 解题镜像三档（minimal / essential / full）的构建与内容
- [containers/allinone/README.md](../containers/allinone/README.md) — 单镜像整机（local 执行后端，无独立工具箱容器）
- [containers/tsecbench/README.md](../containers/tsecbench/README.md) — TSecBench 断网评测 all-in-one 镜像：工具集、烘焙调优、本地与托管在线评测的操作手册

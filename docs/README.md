# AegisX 文档索引

| 文档 | 内容 |
|---|---|
| [usage.md](usage.md) | 使用指南：首次使用流程、配置、LLM 网关 relay |
| [aegisx-report.md](aegisx-report.md) | 成果报告：架构理念、实战成绩（西湖论剑 / TSecBench），配图在 [figures/](figures/) |
| [tsecbench-analysis-2026-09-08.md](tsecbench-analysis-2026-09-08.md) | TSecBench 完整跑批复盘：成绩与资源模型、Harness/Infra/调度问题清单、按投入产出比排序的优化建议 |
| [tsecbench-fix-handoff.md](tsecbench-fix-handoff.md) | 上述分析的问题修复交接：精确落点、改动要点、验收标准与前置约束 |
| [tsecbench-image-plan.md](tsecbench-image-plan.md) | TSecBench 定制镜像实施计划：基于本轮真实调用数据的档位与增量方案 |
| [architecture.md](architecture.md) | 架构概览（活文档）：包与模块划分、数据模型、agent 生命周期、协作与调度数据流 |
| [migrations.md](migrations.md) | 数据库迁移工作流：版本机制、开机四态分类、备份回滚、schema 变更步骤 |
| [audit-2026-08-20.md](audit-2026-08-20.md) | 技术债审计（活文档）：问题清单与逐项修复状态标记 |
| [archive/](archive/) | 历史存档：12 份已实施的设计/实施文档 + [audit-2026-08-23/](archive/audit-2026-08-23/) 专项审查。含对已删文件的引用，有意保留，不再更新 |

仓库其他位置的文档：

- [apps/sdk/python/GUIDE.md](../apps/sdk/python/GUIDE.md) — Python SDK 参考；运行时资产，随镜像分发到 `/opt/aegisx-sdk`，位置固定不可移动
- [containers/solver/README.md](../containers/solver/README.md) — 解题镜像三档（minimal / essential / full）的构建与内容
- [containers/tsecbench/README.md](../containers/tsecbench/README.md) — TSecBench 断网评测 all-in-one 镜像：工具集、烘焙调优与运行方式

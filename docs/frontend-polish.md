# 前端打磨方案

基于 2026-08 对 `apps/web` 全部视图的代码走查。目标：统一容器语言、收敛横向不一致、补齐微体验。不新增抽象组件与依赖，全部基于现有 coss 原语。

## 容器语言规则（三层）

整个应用按此执行，替代现状三套并存（CardFrame / 手写 `rounded-lg border` / 裸排版）：

1. **分区用 `CardFrame`**：管理、配置、监控性质的堆叠分区。形态固定为
   `CardFrameHeader（Title + Description + Action）+ 内卡`，与全局设置页一致。
2. **独立单元用 `Card`**：网格实体卡（赛事、题目）与孤立信息块（指标条）。
3. **沉浸流保持裸区**：对话时间线、频道消息流、文件预览、Agents 画布、composer
   一律不加卡片，靠 border 分隔。

## P0 · 容器语言统一（纯视觉重构，不动行为）

| 视图 | 改动 | 文件 |
| --- | --- | --- |
| 任务页 → 概览（调度者） | 调度者控制、计划队列、配置摘要、收件箱四个手搓 section → CardFrame；QueueList 外层卡中卡拍平为 frame 内卡 | `tasks/overview-pane.tsx`、`tasks/scheduler-control-panel.tsx` |
| 任务页 → 概览（题目） | 题目目标、Agent 花名册 → CardFrame；描述展开块改为 muted 面板（去边框） | `tasks/overview-pane.tsx`、`runs/target-panel.tsx` |
| 赛事概览 tab | 重排为 hero 进度 frame + 四格指标条（Card divide-x）+ 用量汇总 frame + 活跃 Agents frame；修复「活跃任务 / 活跃 Agents」两格同值（活跃任务改为有活跃 agent 的题目数） | `events/event-summary.tsx` |
| 调度配置 tab | 裸表单 → CardFrame（header + 表单内卡 + footer 保存） | `events/scheduler-config-tab.tsx` |
| 赛事设置 tab | border-t 裸分节 → 每节一个 CardFrame（常规 / 提示词指令 / CTF 平台 / 危险区域），与全局设置页同构 | `events/event-settings.tsx` |

状态：**已实施**。

## P1 · 横向一致性（待实施）

- aside 宽度收敛：现状六种（w-40 / w-48 / w-44 / 17.5rem / 12.5rem / 18rem），
  收敛为一级导航 12rem、二级列表 17.5rem 两档；边框方向统一为 border-r。
- 页面标题行规则统一（题目 tab、赛事设置有 `text-2xl` 标题，概览 / 任务 / Agents 无）。
- 两个 composer（agent 对话 / 频道）统一视觉：边框 token、focus 态、底部快捷键提示。
- 微字号收敛：`text-[11px]`、`text-[10px]` 收敛到 11px 一档，10px 仅时间戳。
- 加载态：高频列表（题目网格、任务列表、赛事卡片）换 Skeleton；Spinner 文案统一
  「正在加载 X…」。
- 分组小标题统一（任务列表 GroupHeader vs 频道 rail section 标题）。

## P2 · 微体验（待实施）

- Card / CardFrame hover 边框过渡；赛事卡、题目卡整卡可点。
- 活动日志：未读数 badge、按时间分组。
- 任务页无选中时的空态升级（默认显示调度者或轻统计面板）。
- `settings-screen.tsx` 手写 `queryKey: ["providers"]` 改用 `keys.providers.all`。

## 明确不做（防过度设计）

- 对话时间线、频道流、文件预览、Agents 画布加卡片容器。
- 全局快捷键、动画体系、主题定制——等 P0/P1 落地后视需要再议。

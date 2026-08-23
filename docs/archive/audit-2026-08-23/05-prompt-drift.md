# 提示词与能力漂移审查

审计日期：2026-08-23 · 方向：提示词与能力漂移 · 范围基线：`b08b057`（已含 5eb516c / 21009c7 两轮修正）

## 范围与方法

- 对象：`apps/server/src/orchestration/{prompt-templates,prompt-defaults,types}.ts`、`apps/server/src/run/{agent-factory,prompt,tools,bash-tool}.ts` 及 channels/stall-watchdog/queue/container-lifecycle 等注入点实现；`containers/solver/{Dockerfile,ENVIRONMENT.md,solver-cache.py}`；`apps/sdk/python/{GUIDE.md,aegisx/*,contract.py}`。
- 方法：纯静态核对 + 只读 git 取证 + 本地 SQLite 运行库只读查询（`data/aegisx.sqlite`，用于验证 seed-only 机制的实际效果）。kali-linux-headless 元包成员通过下载官方 `.deb` 的 control 文件核对（2026.2.12）。**未启动任何服务器/容器**，容器内实况均为静态推断，逐条标注。

## 提示词体系梳理（数据流向）

```
apps/server/src/orchestration/prompt-defaults.ts   ← 6 个内置模板唯一源码（v19 手写常量）
        │ boot: createAgentService() → seedBuiltinTemplates(db)   [service.ts:134]
        ▼
prompt_templates 表 (plugin='builtin', ON CONFLICT DO NOTHING)   ← 运行期事实源（可被 UI PATCH 覆盖）
        │ 每次 spawnAgent: loadTemplateMap(db) 快照 → renderTemplate   [agent-factory.ts:488, 605/615/633/643]
        ▼
agents.system_prompt / agents.prompt 列（spawn 时快照；冷恢复原样复用，不重渲）
        ▼
prepareAgent → createHost(systemPrompt=row.systemPrompt) → lifecycle.send(initialPrompt)
```

- **能力门控链（单一事实源成立）**：`SVER_TOOLS`/`ORCHESTRATOR_TOOLS` 数组（agent-factory.ts:253-264）→ `deriveCapabilities(tools)`（types.ts:20-26）→ 模板内 `{{#if capabilities.*}}` 门控；原生工具由同一份工具名快照创建（tools.ts:57 `createMainTools(ctx, tools)`）。scheduler 工具表为空 → 三个 capability 全 false，而 orchestratorSystem 模板不引用任何 capability —— 一致。solver 的 target 四件套仅在 `challengeSupported()`（remote.available && targetSupported && !targetIgnored，agent-factory.ts:730-738）时进入工具表，模板相应段落同步消失。核对无矛盾。
- **容器工具清单事实源**：真实来源 = Dockerfile（apt 显式清单 + kali-linux-headless 元包 + solver-cache.py 三个清单 DOWNLOADS/KNOWLEDGES/TOOLS + gem/venv 安装行）。提示词侧仅保留指针：mainSystem 第 8 条与 initial Environment 都指向 `/opt/solver/ENVIRONMENT.md`（5eb516c 已拔除 initial 的 Highlights 枚举与 mainSystem 第 9 条）。漂移防控有测试护栏（test/orchestration/prompt-templates.test.ts:86-125，但只覆盖两个模板字符串）。
- **动态注入点（scheduler 初醒读 GUIDE)**：GUIDE.md 是静态文件，与 SDK 源码同一 `COPY apps/sdk/python /opt/aegisx-sdk` 进入镜像（Dockerfile:152，PYTHONPATH 预设）；dev 场景 `AEGISX_SDK_PATH` 只读 bind-mount 整树覆盖（agent-factory.ts:85-95）。两处提示词强制首读：orchestratorSystem "FIRST: cat /opt/aegisx-sdk/GUIDE.md"（prompt-defaults.ts:26）、schedulerInitial 有 instruction 分支同样 FIRST cat（:201）；无 instruction 分支靠系统提示词的全局 FIRST 规则兜底。**时效性结论**：GUIDE 与 SDK 代码同源同层进镜像，二者之间不会互相漂移；唯一的过期窗口是「仓库内 apps/sdk/python 已改、镜像未重建」——challenge 切换不影响 GUIDE（其内容与 challenge 无关）。
- **promptHint**：事件级说明唯一渲染点 = mainSystem 尾部 `{{#if event.promptHint}} ## Event instructions`（prompt-defaults.ts:152-155），位于系统提示词故跨 compaction 存活；5eb516c 已删除 initial 里的重复块并有测试锁定（prompt-templates.test.ts:103-124）。合并投递块 channelDelivery 与调度快照 schedulerDigest 模板的变量均由代码端预派生（prompt-templates.ts:320-455），无缺失字段。
- 其余数值声明逐一落实：bash 截断 ~64KB = MAX_BYTES 64_000（bash-tool.ts:36）；合并投递 ~5min = FLUSH_INTERVAL_MS（channels.ts:73）；停滞 >2min = AGENT_STALL_MS（stall-watchdog.ts:9）；队列 starved = pending 2→1 边沿（queue.ts:153）；/tmp tmpfs 默认 1g 且显式 exec（container-manager.ts:154、settings-schema.ts:241）；已解题禁新 agent 默认开（scheduler-policy.ts:44）；附件 64MB/文件、8 文件/消息（sdk channels.py:102）；SDK 全部签名与 GUIDE 一致且被 contract.py 回归覆盖。

### 核对通过项（抽样列举，均一致）

| 声明位置 | 对照 |
|---|---|
| knowledges 六项清单（ENVIRONMENT.md:8） | solver-cache.py KNOWLEDGES 完全一致（含 libc-database 空壳说明 ：14 属实） |
| 特殊命令入口 11 项（ghidra-analyze/fd/pwndbg/pwninit/llvm-pdbutil/dwarf2json/bkcrack/wine64/pycdc/jwt_tool…） | Dockerfile 均有对应构建行（软链/wrapper/源码编译/gem） |
| Web/AD/Bruteforce/Misc 分类速查 | headless 元包 Depends（nmap/sqlmap/wfuzz/nikto/mitmproxy/netexec/evil-winrm/responder/hashcat/john/masscan/sleuthkit/testdisk/socat/dig…）+ Dockerfile 显式清单，逐个命中 |
| rockyou 路径、seclists Fuzzing 已裁剪 | Dockerfile:47-48 |
| venv 库清单及「可写共享 venv」安装 SOP | Dockerfile:86-98 + /opt/venv PATH；与 mainSystem 第 8 条口径一致 |

## 发现

### F1 · P1 · seed-only 模板无升级路径：5eb516c 修复未到达运行库，活实例仍在渲染旧提示词

- 位置：apps/server/src/run/service.ts:134；apps/server/src/orchestration/prompt-templates.ts:36-44；prompt-defaults.ts:1-5（头注释自述 "No legacy upgrade chain: the seam is the DB row"）
- 证据：seed 仅 `onConflictDoNothing`，代码默认值更新后既有行永不刷新。对本机运行库 `data/aegisx.sqlite` 只读查询证实六行的 updated_at 均早于 5eb516c（2026-08-22 16:41+0800），且旧特征全在：
  - `initial` 含 `pycryptodomo` 拼写错误、含 `## Event instructions`（promptHint 重复块）、含 `Highlights:` 内联工具枚举；
  - `mainSystem` 含过时 SOP `install it into the workspace`；
  - `schedulerInitial` 不含 `FIRST … GUIDE.md`。
- 影响：这轮修复的全部行为收益（去内联枚举、SOP 对齐可写 venv、promptHint 去重、scheduler 初醒先读 GUIDE）在本项目唯一部署形态（本地单机）上**尚未生效**——新 spawn 的 agent 拿到的仍是修复前的系统/初始提示词。测试护栏只断言源码常量，绿灯掩盖了实况漂移。
- 备注：非设计缺陷而是运维缺口；一次 `DELETE FROM prompt_templates WHERE plugin='builtin'` 后重启即自愈，但目前没有任何机制提示这一步的存在。

### F2 · P2 · ENVIRONMENT.md 残留失实条目 yarasan（上轮声称修复但只修了一处）

- 位置：containers/solver/ENVIRONMENT.md:89
- 证据：「符号表拿不到时, yarasan / strings / 手工 carving 仍是可行路径。」5eb516c 只改了上文 vol 行（diff 可证），本行漏网；镜像侧 Dockerfile 与 solver-cache.py 均无 yarasan（venv 只有 `yara-x` 模块），项目自己的复盘笔记（.zcode/plans）也确认「镜像内不存在 yarasan 二进制」。
- 影响：内存取证拿不到符号表的场景下，agent 会按文档寻找不存在的命令，浪费轮次后才回退到 strings/carving。

### F3 · P2 · steghide 写了没装（ENVIRONMENT.md 唯一命中失败的工具条目）

- 位置：containers/solver/ENVIRONMENT.md:57（Forensics/Stego 行）
- 证据：steghide 不在 Dockerfile 任何显式安装行；不在 kali-linux-headless 2026.2.12 的 Depends（已解包 .deb control 核对），也不在 kali-linux-core / kali-system-cli 的 Depends。其余速查表条目逐个核实均有出处，唯独此条两头落空。**仅静态核对**——未进容器验证是否存在传递依赖兜底。
- 影响：stego 类题目 agent 直接 `steghide xx -pf pass` 得到 command not found；虽可走缺工具 SOP 补装，但作为「单一事实源」的文档自身失准正是本轮要消灭的问题类别。

### F4 · P3 · bash 工具描述残留第二份工具链枚举

- 位置：apps/server/src/run/bash-tool.ts:190
- 证据：「The full CTF toolchain is on PATH: python3 (venv with pwntools/angr/impacket/pycryptodome/...), nmap, gdb/pwndbg, ghidra-analyze, fd, rg, ...」。5eb516c 把 mainSystem/initial 的枚举收归 ENVIRONMENT.md，此处是漏改的第三处（复盘笔记原本就点名四处）。当前内容逐项属实，但不受任何 drift-control 测试保护。
- 影响：下次动镜像工具集时这里就是新的漂移点；与刚建立的单源原则相悖。

### F5 · P3 · mainSystem Channels 段内联 SDK 签名与上限，形成三处副本

- 位置：prompt-defaults.ts:116-130（`.author_name/.body/.created_at` 字段名、`channels.read/post/ask` 签名、64MB/8 文件上限、5 分钟投递周期）
- 证据：同一事实存在于 channels.py（docstring+签名）、GUIDE.md、mainSystem 三处；今日三者一致（已逐一对照 channels.py:67-131 与 :102）。但模板注释自称「API specifics live in the in-image GUIDE.md（the prompt keeps the behavioral rules）」（测试注释），实际却抄录了精确签名，言与行不符。
- 影响：SDK 参数一变（如 post 增加 tag 语义），提示词即静默失实；属低危的结构性重复。

### F6 · P3 · PROMPT_TEMPLATE_VARIABLES 缺 `event.promptHint`

- 位置：prompt-templates.ts:81-110（清单止于 event.platform）；经 settings/routes.ts:84 暴露给前端变量面板。
- 证据：mainSystem 实际使用 `{{event.promptHint}}`（prompt-defaults.ts:152-154），清单未收录。
- 影响：用户在模板编辑器里看不到这个可用变量，纯文档性缺口。

### F7 · P3 · 调度者上下文携带 promptHint 但从不渲染

- 位置：run/prompt.ts:136（buildSchedulerPromptContext 填入 promptHint）vs DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE（prompt-defaults.ts:7-86，全文无 `{{event.promptHint}}`）。
- 证据：solver 能看到赛事级说明（flag 格式、平台规则类），做规划、写 strategy、决定投入产出的调度者反而看不到。
- 影响：若作者把关键约束写进 promptHint（例如「只交 X 格式 flag」），调度者的策略产出不会遵守；意图不明（也可能刻意让 instruction 独占调度视野），列为待决事项而非明确缺陷。

### F8 · P3 · 「read-only」措辞将协作约定表述成硬约束

- 位置：prompt-defaults.ts:177-179（attachments/shared/siblings 标注 read-only）、bash-tool.ts:183（"shared/, attachments/, sibling agents' directories are read-only for you"）。
- 证据：真正的强制仅在 host 侧 write/edit 文件工具（buildHostFileTools 以 agent 自己目录为根，agents/host.ts:108）；容器 bash 在 rw bind 上以 root 执行，物理上可写整个 /workspace。mainSystem 自己的措辞才是准确的——「shared/ 与队友目录只读（协作约定）」（:131）。
- 影响：agent 若信以为真，会在合法需要时放弃向 shared/ 落盘（如给队友留产物），或在需要绕过时误判越权；行为面影响轻微，主要是自我认知失真。

## 建议

1. **F1（优先）**：给 builtin seed 一个版本语义并落地本次修复——最小做法是手动执行一次 `DELETE FROM prompt_templates WHERE plugin='builtin'` 后重启；长期做法：BUILTIN_DEFAULTS 内容 hash 入库比对不一致时打日志（或直接覆盖，本地单机无保留价值时可接受破坏性升级，符合项目「不要向后兼容」原则）。
2. **F2**：删除 ENVIRONMENT.md:89 中的 `yarasan / `，保留 strings/手工 carving。
3. **F3**：二选一并保持文档与镜像同步——Dockerfile 显式补 `steghide`，或从速查表移除。
4. **F4**：bash 描述改指针化（"Full toolchain reference: /opt/solver/ENVIRONMENT.md"），并在 drift-control 测试里加一条 `bashDescription` 不含 pwntools/nmap 等具体工具名的断言。
5. **F5/F6/F7/F8**：Channels 段收敛到行为纪律、签名交给 GUIDE；变量清单补 `event.promptHint`；对 promptHint 是否进调度者上下文做出显式决定（渲染或删字段）；read-only 措辞统一为「write/edit 受限，bash 视作约定只读」。

## 未确认事项

- 容器内实况全部为**仅静态核对**：未 docker build/run。F3 的结论依赖 metapackage Depends + Dockerfile 显式清单的穷举，kali-rolling 滚动更新可能使元包成员与 2026.2.12 快照有出入。
- pycdc 对 Python 3.13 的退化程度、wine64/Rosetta 的 SIGTRAP 兼容性描述（ENVIRONMENT.md:40,47-49）无法静态验证，沿用作者自述。
- 镜像内 npm 包 `@earendil-works/pi-coding-agent@0.80.7`（Dockerfile:142）落后于仓库 0.84.2：host 侧会话由仓库内 pi 库驱动、容器执行走 dockerode exec，容器内这份 npm 包是否处于运行时路径未能完全追认；若仅为遗留则无影响。
- mainSystem Channels 的内联签名是有意冗余（省一次 cat GUIDE）还是疏漏，需作者定夺。
- `data/aegisx.sqlite` 为审计时刻快照（WAL 为空）；若作者在取证后已自行清理 builtin 行，F1 的现状部分随之失效。

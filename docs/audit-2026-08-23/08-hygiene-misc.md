# 工程卫生与仓库杂项审查

审计日期：2026-08-23 · 方向：工程卫生与仓库杂项 · 工作目录：`/Users/timmy/Projects/aegisx`

## 范围与方法

覆盖七块：Git 卫生（ignore / 脏文件 / LFS / 大 blob 历史）、疑点考古（`docs/audit-2026-08-22/`、`pai-only/`、`data/` 双命名）、工具链配置（knip / oxlint / oxfmt）、四份 package.json 体检、bun.lock 一致性与幽灵依赖抽查、README 偏差、杂项清扫（空目录 / 临时文件 / TODO 普查）。

全程只读：`git log/show/rev-list/cat-file/count-object/status/check-ignore/stash`、`find/grep/ls/du`、oxlint 以 `-D suspicious` 做了一次只读 lint 计数（无写入）。npm registry 仅做了一次 GET 查询最新版本号。未运行 install / dev / build。

## 发现

严重度定义：P0 阻断 / P1 应尽快修 / P2 计划内修 / P3 低成本随手项 / PASS 信息级验证通过。

### H-1 · P2 · oxlint 默认只跑 correctness 类别，suspicious 全关，实测积压 203 个问题

- **位置**：`apps/server/.oxlintrc.json`、`apps/web/.oxlintrc.json`、`apps/shared/.oxlintrc.json`
- **证据**：三份配置均只声明 `plugins`，未声明任何 category/rule 升级；oxlint 1.76.0 默认类别仅为 `correctness`（`--help` 明示）。实测在 `apps/server` 执行 `oxlint -D suspicious src`：**203 errors / 81 files**，分布：`typescript/no-unsafe-type-assertion` 123、`no-unnecessary-type-assertion` 21、`no-unnecessary-type-conversion` 9、`eslint(no-shadow)` 9、`consistent-return` 4、`preserve-caught-error` 4 等。
- **影响**：当前 `check` 门禁绿灯掩盖了这批 suspicious 级问题。其中 123 个 unsafe assertion 说明类型断言习惯偏松，与项目已开 `typeAware` 的投入不匹配。另：可用而未启用的插件有 `node`、`promise`、`regex`（三个包均未启用）、`react-perf`（web 未启用）。注：oxlint 1.76.0 的插件 schema 中**不存在 security 插件**（已核对 `configuration_schema.json`），「security 类规则缺口」是上游能力边界，不是本项目配置遗漏。

### H-2 · P2 · `pai-only/package/dist/` 孤儿目录，前次审计判删后仍留存

- **位置**：`pai-only/package/dist/`（共 83 项，约 **5.8 MB**，均为 `@earendil-works/pi-*` 构建产物：`dist/cli.js`、`models.generated.js`、`compat/extension-oauth-types.js` 等；无 package.json、无源码）
- **证据**：全仓 grep（含 `package.json`×4、`bun.lock`、tsconfig、源码）零引用；`git log --all -- pai-only/` 为空——从未入库。它之所以不在 `git status` 中出现，是因为被根 `.gitignore` 的 `dist/` 规则（任意层级匹配）静默忽略。`docs/code-audit-2026-08-20.md:115` 已判定「纯遗留，可删」，`:216` 列入清理项，三天后仍未执行。
- **影响**：5.8 MB 死重 + 误导性目录名（"pai" 即 pi）。忽略规则掩盖使其永不暴露在 status 里，属于典型的「看不见的债」。

### H-3 · P3 · `data/aegisx.db` 0 字节孤儿文件

- **位置**：`data/aegisx.db`（0 字节，mtime 2026-08-16 19:06）
- **证据**：服务器代码自首个提交起就用的是 `aegisx.sqlite`（db5e089，2026-07-15：`src/db/index.ts:12`）；`drizzle.config.ts` 在 f4280c3（2026-07-21）补入 `dbCredentials` 时直接指向 `.sqlite`，**从未指向过 `.db`**。全 git 历史 grep `"aegisx.db"` 作为 DB 文件名零命中。所谓「双命名并存」并非一次改名迁移的中间态，就是一个无主文件。前次审计（code-audit-2026-08-20.md:116）同样已判删。
- **影响**：极低，但它会让人误以为存在第二套数据库。

### H-4 · P3 · knip 配置两处盲区

- **位置**：`knip.json`
- **证据**：
  1. `workspaces["apps/server"].project = ["src/**/*.ts", "test/**/*.ts"]`，不含 `scripts/**` —— `scripts/relay.ts` 和 `scripts/sdk-contract.ts`（分别由根脚本 `relay`、`test:sdk` 调用）对 knip 完全不可见，其独占依赖若存在死代码不会被报。code-audit-2026-08-20.md:216 的 P2 项「knip 加 scripts globs」未落地。
  2. `ignoreDependencies: ["react-day-picker"]`：该包唯一的引用点是 `apps/web/src/components/ui/calendar.tsx:9`，而 `ui/**` 整体被 knip ignore 且 grep 确认 `calendar` 组件在 `ui/**` 之外零导入——即这条 ignore 实际掩护着「无人使用的组件 + 无人使用的依赖」这一对死重（`ui/**` 是 coss 库 vendored 设计，AGENTS.md 允许组件闲置，但依赖本身留在 `dependencies` 里是实打实的安装面）。
  3. `ignoreBinaries: ["wait"]` 对应根脚本 `dev` 的 `& wait`，合理。
- **影响**：knip 作为硬门禁的可信度依赖其可见范围；两处盲区都在缩小它。

### H-5 · P3 · 全部 package.json 缺 `engines` / `packageManager`

- **位置**：根 `package.json`、`apps/{server,web,shared}/package.json`（`apps/sdk` 是 Python 项目，无 manifest）
- **证据**：四个 manifest 均无这两个字段。项目深度绑定 Bun（`workspace:*`、`bun run --filter`、`bun test --max-concurrency`），但没有任何机制声明最低 Bun 版本。
- **影响**：本地单用户场景风险低；换机器或 CI 时无护栏。

### H-6 · P3 · README 两处失实/过时

- **位置**：`README.md`
- **证据**：
  1. `README.md:51` 将 `bun run check` 注释为「oxlint (lint + type-check) + oxfmt (format)」，但实际脚本是 `oxfmt --check package.json .oxfmtrc.json && knip && bun run --filter '@aegisx/*' check`（`package.json:11`）——**knip 硬门禁完全没提**（commit 53516ca 特意把它做成门禁，文档没跟上）。
  2. `README.md:28` 「stores its SQLite database, attachments, and **run workspaces** under `data/`」——v19 已拆除 Run 层，实际路径是 `data/events/<eventId>/challenges/<challengeId>`（`apps/server/src/run/workspace-resolver.ts:29`）与 `.../orchestrator`（同文件 :35），"run workspaces" 是旧模型措辞。
- **其余核对通过**：端口 3000（`apps/server/src/index.ts` PORT ?? 3000 ↔ `apps/web/vite.config.ts:13` proxy）、relay 默认 8788（`scripts/relay.ts:17`）、`AEGISX_DATA_DIR`（index.ts:5）、`containers/solver` 存在、`apps/sdk/python/GUIDE.md` 存在、overrides 描述与实际一致。

### H-7 · P3 · Python SDK 的 `uv.lock` 被 gitignore

- **位置**：`.gitignore` 生效范围内 `apps/sdk/python/uv.lock`（`git status --ignored` 可见）
- **证据**：JS 侧单 lockfile（bun.lock）入库，Python 侧锁文件不入库。
- **影响**：单用户本地影响小，但 SDK 依赖无法复现锁定状态，与 JS 侧实践不一致。

### H-8 · PASS · Git 卫生与大文件普查（验证通过）

- `.DS_Store`：根 `.gitignore:8` 已覆盖（任意层级），磁盘上两处（根、`data/`）均被正确忽略；`git ls-files` 确认从未被 track。**不构成发现。**
- 工作区状态：`git status --porcelain` 输出为空，工作树干净；无 stash。
- LFS：客户端 3.7.1 已装但无 `.gitattributes`、零 LFS 对象——未启用，且下述数据表明也不需要。
- 大 blob 普查：`git rev-list --objects --all` 共 **7430 个对象**；`cat-file --batch-check` 过滤后 **>512KB 的 blob 数量为 0**，最大的 12 个 blob 全部是历版 `bun.lock`（230–269 KB）。**sqlite 二进制从未入库**：`data/` 目录自 db5e089（2026-07-15，仓库早期）起就在 `.gitignore` 里。`git count-objects -vH`：pack 仅 **3.22 MiB**。
- 结论：历史干净，无需 BFG/LFS 之类的清洗。

### H-9 · PASS · overrides 考古与幽灵依赖抽查（验证通过，附一条事实备注）

- **overrides 来历**：c27e7b0（2026-08-07，「convert to Bun workspaces monorepo」）随根 package.json 一并引入，commit message 明确动机是把 pi-coding-agent/pi-ai 的版本对齐收口到根；此后从未改动过钉版值。实测 npm registry：`@earendil-works/pi-ai` 与 `pi-coding-agent` 的 latest **均为 0.84.2**——钉版即最新，不存在落后。bun.lock 内 pi 家族（ai / coding-agent / agent-core）全部解析到同一 0.84.2，无分叉副本。备注：server/shared 的直依赖本就是 exact `0.84.2`（不带 caret），override 的增量价值只在防传递依赖分裂，属轻度冗余但无害。
- **幽灵依赖抽查**：`apps/server/src` + `scripts` + `test` 的全部 bare import（15 个包名，含 `drizzle-orm/bun-sqlite` 等子路径）与 dependencies 逐一对上；`apps/web/src` 全部 bare import（20 个包名）同样全部有声明。monorepo 化时曾直依赖的 katex（当时经 `@streamdown/math` 间接引用、css @import）如今 index.css 仅剩 `@import "tailwindcss"`，katex/streamdown 在 lock 中已零残留，移除干净。
- **scripts 引用**：根脚本所有 `--filter` 名（`@aegisx/server` / `@aegisx/web` / `'@aegisx/*'`）与各包 name 一致；`test:sdk` / `db:generate` / `relay` / `build` 目标脚本均真实存在。无坏引用。
- 备注（非问题）：lockfile 内 tarball 全部来自 `registry.npmmirror.com`（镜像源），完整性由 sha512 保证。

### H-10 · PASS · 杂项普查（基本干净）

- TODO / FIXME / HACK / XXX：ts/tsx/py 源码合计 **0 处**。
- `*.bak` / `*.orig` / `*.rej` / `*.tmp` / `*~` / `*.swp`：仓库内 0 处（`data/*.bak-*` ×3 各 26,165,248 B 是 `pruneBackups(keep=3)` 的设计产物，见 code-audit-2026-08-20.md:118，非债）。
- 空目录：排除 node_modules/data/.zcode 后仅 `docs/audit-2026-08-22/` 一个（见 H-11）。
- `.zcode/`（config.json + plans/）已被 ignore，属本地工具态；`data/.incoming`、`data/.trash` 为 `infrastructure/storage.ts:17-18` 运行时创建，非遗留。

### H-11 · P3 · `docs/audit-2026-08-22/` 空目录来历不明

- **位置**：`docs/audit-2026-08-22/`（0 个文件，dir mtime 2026-08-22 20:31）
- **证据**：`git log --all -- <path>` 为空——从未有任何提交触及；因空目录 git 本就不追踪，status 也不显示。同期的实际产出是 `docs/code-audit-2026-08-20.md`（在 docs/ 根，命名也不同）。
- **影响**：疑似某次审计会话预建目录后改用了别的输出路径。纯噪音，可删；若后续审计要归档到此命名模式，应先定一个并坚持。

### H-12 · PASS · oxfmt 配置核对（验证通过）

- `.oxfmtrc.json`：80 列 / 2 空格 / 无分号 / 双引号 / LF，与现有代码风格一致；`sortTailwindcss.entryPoint` 指向 `apps/web/src/index.css`（存在）；`ignorePatterns: ["apps/server/drizzle"]` 与两处 oxlint 的 `drizzle/**` ignore 口径一致；`sortPackageJson` 开启解释了 check 脚本先跑 `oxfmt --check package.json` 的顺序。无异议。

## 清扫清单

可直接执行的命令（均已确认目标存在、且不影响任何被跟踪文件）：

```sh
rm -rf pai-only/                 # H-2：5.8MB 孤儿构建产物
rm data/aegisx.db                # H-3：0 字节无主文件
rmdir docs/audit-2026-08-22      # H-11：空目录
rm .DS_Store data/.DS_Store      # 可选：已被 ignore，纯磁盘清洁
```

配置层动作（各一处小改）：

1. `knip.json`：server 的 `project` 追加 `"scripts/**/*.ts"`（H-4）。
2. 三份 `.oxlintrc.json`：择期加 `-D suspicious` 并清零存量（203 处，主体是 123 个 `no-unsafe-type-assertion`，可按目录渐进）（H-1）；顺带评估启用 `promise`/`node` 插件。
3. 根 `package.json`：加 `"packageManager": "bun@<本机版本>"`（H-5）。
4. `README.md:51` 补 knip 门禁说明；`:28` 把 "run workspaces" 改为 challenge/orchestrator workspaces 的实际路径描述（H-6）。
5. 决策项：`apps/web/src/components/ui/calendar.tsx` + `react-day-picker` 去留——要么接受现状并在 AGENTS.md 口径下沉默，要么连依赖一起移除（H-4）。
6. 决策项：`apps/sdk/python/uv.lock` 是否改为入库（H-7）。

## 建议

优先级排序：H-2/H-3/H-11 三条删除类动作一分钟内完成且零风险，建议立即做；H-1 的 suspicious 积压是唯一有实质代码量的项，建议作为独立清理轮（配合 `--fix` 先消掉 21+9+9 个可自动修复项）；H-4/H-6 属门禁与文档可信度问题，随手带上。整体而言本仓库卫生水平高于典型个人项目：历史无大文件、零 TODO、零临时文件、无幽灵依赖、钉版即最新——主要债是「上次审计判了没删」和「lint 类别偏保守」两类。

## 未确认事项

1. `data/aegisx.db` 的创建者：0 字节、mtime 2026-08-16 19:06，代码与配置历史上均无此文件名，无法定位是哪次实验产生（可能是手工 `sqlite3` 或某工具默认值）。
2. `docs/audit-2026-08-22/` 由哪个会话/工具创建：无任何 git 或文件内容线索。
3. H-1 中 203 个 suspicious 问题的修复成本未逐一评估（尤其 123 个 unsafe assertion 是否多数可通过收窄泛型解决），仅做了计数与规则分布统计。
4. `registry.npmmirror.com` 作为 tarball 源是否有需要调整的供应链策略：版本经 sha512 校验且与 npmjs latest 一致，本次仅记录事实，未做镜像一致性抽验。

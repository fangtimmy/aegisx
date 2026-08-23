# 数据层一致性审查

审查日期：2026-08-23。范围：`data/` 目录运行时产物归属、`apps/server/src/db/` 的 schema/migration/连接管理、`.gitignore` 覆盖情况与二进制入库历史、drizzle 配置与 schema 同步状态。

## 范围与方法

- 只读检查：`ls -la` / `stat` 观察 `data/` 时间戳与大小；`sqlite3 'file:data/aegisx.sqlite?mode=ro'` 查询表结构、`user_version`、迁移计数、`quick_check`；grep 遍历 server 源码中的连接创建点与 pragma；`git log --all`（含 `-S'aegisx.db'`、`--diff-filter=A`）考古；`git check-ignore -v` 验证忽略规则。
- 未运行 `drizzle-kit` 做全量 snapshot 比对（避免写文件），同步性结论基于：journal 计数 vs DB 实际计数、表集合比对、两处列级抽查、`git status` 干净 + schema 与 drizzle 目录同 commit 变更。
- 全程未启动任何服务，未做任何写操作。

## 发现

### F1 [P2] `data/aegisx.db` 是遗留空文件，此前审计已判死但未清理

- 位置：`data/aegisx.db`（0 字节，mtime 2026-08-16 19:06）
- 证据：
  - `apps/server/src/db/index.ts:167` — `const dbPath = join(dataDir, "aegisx.sqlite")`，代码中唯一 DB 路径；
  - 全仓库 grep `aegisx\.db` 无任何代码引用，仅命中文档 `docs/code-audit-2026-08-20.md:116`：「遗留空文件 | `data/aegisx.db` | 0 字节……现行 DB 是 `aegisx.sqlite`」，该文档 :216 行明确建议删除；
  - `git log --all -- 'data/'` 为空——从未入库。
- 影响：无功能影响，但属于已确认的待办残留，持续制造「哪个是真实库」的认知噪音。

### F2 [P0—无问题，确认为设计行为] 三个 `.bak-*` 是迁移安全快照，数量符合 `keep=3`

- 位置：`apps/server/src/db/index.ts:131-161`
- 证据：
  ```ts
  // index.ts:139
  const dst = join(dataDir, `aegisx.sqlite.bak-${stamp}`)
  // index.ts:150
  export function pruneBackups(dataDir: string, keep = 3): void
  ```
  现存恰好 3 个 bak（各约 26MB，时间戳对应 8 月 20 日 0014→0016 迁移窗口），与 keep=3 一致。仅在检测到 pending 迁移时才产生备份（`backupDatabase` 在 `pending <= 0` 时返回 null），日常重启零拷贝。
- 影响：非技术债。约 78MB 本地磁盘占用是可接受的保险成本。

### F3 [P0—无问题] 活跃库健康且三方同步：schema ↔ journal ↔ 实际 DB

- 位置：`apps/server/src/db/schema.ts:14`、`apps/server/drizzle/meta/_journal.json`、live DB
- 证据：
  - `SCHEMA_VERSION = 19`（schema.ts:14）；live DB `PRAGMA user_version` = 19；
  - journal 共 17 条（idx 0–16，tag `0000`–`0016`）；live DB `SELECT count(*) FROM __drizzle_migrations` = 17；
  - live DB 表集合 = schema.ts 定义的 16 张表（agents, attachments, challenge_flags, challenge_remote, challenges, channel_messages, channel_reads, event_platforms, events, platform_request_log, prompt_templates, queue_state, scheduler_config, session_entries, sessions, spawn_queue）+ `__drizzle_migrations`，无多无少；
  - 列级抽查：`scheduler_config` DDL 含 0010–0016 历次 ALTER 追加的全部开关列（含最新的 `block_spawn_on_solved integer DEFAULT true NOT NULL`，即 `0016_block_spawn_on_solved.sql`）；`spawn_queue` 13 列与 schema.ts:285-325 完全一致；
  - `git status` 干净；`git log` 显示 schema.ts 与 `drizzle/` 最近三次均同一 commit 变更（677dcfa、9a45a22、e0c1ba8），无「改了 schema 忘生成」迹象。
- 说明：`SCHEMA_VERSION`(19) ≠ journal 条数(17) 不是漂移——docs/migrations.md:11-16 明确其为手工维护的展示常量（user_version 仅作降级守卫与展示），19 号版本对应纯代码清理（index.ts:238 注释「v19 swept legacy execution data」）。

### F4 [P3] 未设置 `PRAGMA synchronous`，WAL 下沿用默认 FULL

- 位置：`apps/server/src/db/index.ts:169-171`
- 证据：
  ```ts
  sqlite.run("PRAGMA busy_timeout = 5000")
  sqlite.run("PRAGMA foreign_keys = ON")
  sqlite.run("PRAGMA journal_mode = WAL")
  ```
  全仓库无其他 pragma 设置点（仅 index.ts:137 的 `wal_checkpoint(TRUNCATE)`）。
- 影响：WAL 模式下惯例推荐 `synchronous = NORMAL`（每次 commit 不 fsync，掉电最多丢最后事务、不损坏库）。当前 FULL 更保守、写入更慢；本地单用户场景两者都安全。属可选优化，非性能瓶颈或正确性问题。

### F5 [P0—无问题] 连接管理为单例单连接，生命周期完整

- 位置：`apps/server/src/app.ts:23,130-132`、`apps/server/src/index.ts:5-8`
- 证据：
  - `bun:sqlite` 的 `new Database(...)` 在整个 server src/scripts 中仅出现于 db/index.ts:168 一处；`createApp` 启动时调用一次 `createDatabase(dataDir)`；
  - 默认 dataDir 解析为仓库根 `data/`（index.ts:5-8，可用 `AEGISX_DATA_DIR` 覆盖）；
  - 关闭路径完整：`instance.close()` 内 `agentService.close()` → `sqlite.close()` → `releaseLock()`（app.ts:130-132）；
  - 并发防护：`acquireDataDirLock` 用 `aegisx.lock` + pid 探活阻止双开（index.ts:21-61）；当前 data/ 下无 lock 文件，与服务未运行一致；
  - 测试与 SDK 契约脚本全部使用 `mkdtempSync(tmpdir())` 临时目录（migration-*.test.ts、scripts/sdk-contract.ts:26），不污染真实 data/。
- 附带观察：显式事务仅 3 处（platforms/service.ts:262、platforms/sync.ts:161/247），其余写路径依赖单语句原子性；本次未逐条审计是否存在需要事务包裹的多语句序列（见未确认事项）。

### F6 [P0—无问题] `.gitignore` 覆盖完整，历史上从未有二进制入库

- 位置：`.gitignore:3`
- 证据：
  - `git check-ignore -v` 对 aegisx.db / aegisx.sqlite / bak×3 / config.json / events/ / attachments/ 全部命中 `.gitignore:3:data/`（目录级规则天然覆盖未来新增产物，包括 -wal/-shm）；
  - `git log --all --diff-filter=A --name-only -- '*.sqlite*' '*.db' '*.bak*' 'data/**'` 输出为空——全历史零二进制提交；
  - `.dockerignore` 亦排除 `data`（另有一条 `.data` 匹配任何现有路径，属无害冗余）。
- 影响：git 卫生状况良好，无需动作。

### F7 [P3] `data/events/<uuid>/` 为每赛事挑战工作区，属正常运行时布局

- 位置：`apps/server/src/run/workspace-resolver.ts:29,35`
- 证据：`join(dataDir, "events", eventId, "challenges", challengeId)`；现存 4 个赛事目录，时间跨度 8/19–8/22，与活跃使用吻合。已被 `data/` 规则忽略，无需处理。

## 建议

按优先级排序：

1. **[P2] 删除 `data/aegisx.db`**。上一轮审计（2026-08-20）即已列入待办仍未执行：`rm data/aegisx.db`。一行命令，消除唯一的目录噪音源。
2. **[P3] 可选：在 index.ts:171 后补 `PRAGMA synchronous = NORMAL`**。本地单用户下收益有限，若当前写入无可感知延迟可不加。
3. **[P3] 可选：清理 `.dockerignore` 中无效的 `.data` 条目**（顺手项，不影响行为）。
4. **[P0] 其余一切维持现状**。bak 保留策略、锁机制、迁移守卫（backup→migrate→restore）、gitignore 规则均为合理设计，不要动。

## 未确认事项

- **schema↔snapshot 全量比对**：未运行 `drizzle-kit generate/check`（会产生写操作），同步结论基于计数核对、表集合比对与两处列级抽查。若需绝对确认，可在允许写的前提下跑一次 `bun run db:generate` 观察「no changes」。
- **事务盲区**：run/scheduler 写路径中是否有多语句序列缺少事务包裹，未逐一排查（超出本轮数据层一致性主轴）。
- **`bun:sqlite` 对 synchronous 的隐式默认值**：按 SQLite 库默认 FULL 推断，未实测验证。

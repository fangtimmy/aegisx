# 数据库迁移

AegisX 的 schema 演进是**基线制**：`apps/server/drizzle/` 下只有一份从当前
`schema.ts` 全新生成的基线迁移（完整 DDL），没有任何增量升级链。旧数据库
不做升级，开机即拒绝。

## 版本机制

- **基线迁移**：`drizzle/0000_*.sql` + `drizzle/meta/`（journal + 快照）。
  内容是「从空库到当前 schema」的全部 DDL，只应用于空库。
- **`SCHEMA_VERSION`**（`apps/server/src/db/schema.ts`）：写入 SQLite
  `user_version`，是开机协商的唯一闸门。每次 schema 变更随基线重建同步
  bump；它不再是「展示用」常量——版本不匹配的库直接拒绝打开。

## 开机三态（`createDatabase`）

| 状态 | 判定 | 行为 |
|---|---|---|
| fresh | 库中无用户表 | 应用基线 → 置 `user_version = SCHEMA_VERSION` → 打开 |
| current | `user_version == SCHEMA_VERSION` | 直接打开，不应用任何迁移 |
| stale | `user_version < SCHEMA_VERSION`（一切旧库，v1–v19 含历史链库） | **硬失败**，报错指导用户备份后迁移数据目录或删除 `aegisx.sqlite` 重来 |
| newer | `user_version > SCHEMA_VERSION` | 硬失败（降级不支持），换更新的二进制 |

`user_version` 在基线落地后立即盖章，因此它精确区分「本 schema 创建的库」
与「其他一切」。不存在预迁移库、部分迁移库等中间态。

## 无升级路径（有意为之）

- 不做自动升级、不做自动备份改名——静默改写用户数据不可接受。
- 不存在迁移前快照：没有 forward migration 就没有 pending，`backup-*` /
  回滚逻辑已随旧链删除。基线只在空库上运行，失败无可损失，重开即可重试。
- 旧库的处置由用户手动完成：`mv data data.old-<version>`（或删除
  `aegisx.sqlite`）后重启，从零建库。

## 工作流：变更 schema

1. 修改 `apps/server/src/db/schema.ts`。
2. 重建基线：
   ```sh
   rm -rf apps/server/drizzle
   cd apps/server && bun run db:generate
   ```
   drizzle-kit 的增量生成模式不使用——journal 里永远只有 idx 0 一个条目。
3. **人工审查生成的 SQL**：必须是从空库到当前 schema 的完整 DDL
   （全部 `CREATE TABLE/INDEX`），不得出现 `DROP` / `RENAME` / `ALTER`。
4. 同步 bump `SCHEMA_VERSION`（同一提交：基线 SQL + journal + 快照 +
   `schema.ts` + 版本号）。
5. 重启。所有既有库（包括上一个版本的）此后按 stale 拒绝，按上面的
   手动流程处理数据目录。

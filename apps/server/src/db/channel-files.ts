import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"

import type { Database } from "./index"
import { channelFiles } from "./schema"

/**
 * v17 post-migration reconciliation (docs/im-channels.md §11.6): migration
 * 0011 merges the run-scope group channels into per-challenge canonical
 * channels — the DB rows (channel_files.channel_id) move in SQL, but the
 * attachment directories on disk (data/channel-files/<channelId>/<messageId>/)
 * need a filesystem pass. Message ids are globally unique, so a row whose
 * expected path is missing is healed by relocating its <messageId> directory
 * from wherever it still lives into the canonical channel's tree.
 *
 * Idempotent and self-limiting: rows whose expected path already exists cost
 * one statSync; only mismatches trigger a directory scan. Also run on every
 * boot (heals any drift, e.g. a crash between the SQL commit and a prior
 * reconcile).
 */
export function reconcileChannelFileDirs(db: Database, dataDir: string): void {
  const root = join(dataDir, "channel-files")
  if (!existsSync(root)) return
  const rows = db.select().from(channelFiles).all()
  for (const row of rows) {
    const expected = join(
      root,
      row.channelId,
      String(row.messageId),
      row.filename
    )
    if (existsSync(expected)) continue
    // Find the message dir under a stale channel id and move it wholesale.
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, String(row.messageId))
      if (!existsSync(candidate)) continue
      mkdirSync(join(root, row.channelId), { recursive: true })
      renameSync(candidate, join(root, row.channelId, String(row.messageId)))
      break
    }
  }
}

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"

import type { Database } from "./index"
import { channelFiles } from "./schema"

/**
 * v18 post-migration reconciliation (docs/im-simplify-v18.md §六): migration
 * 0012 flattens the attachment directory layout from
 * data/channel-files/<channelId>/<messageId>/ to data/channel-files/
 * <messageId>/ in SQL (the channel_id column is dropped); the filesystem
 * side is healed here. Message ids are unique, so a file row whose expected
 * flat path is missing is healed by relocating it from whatever legacy
 * channel layer still holds it.
 *
 * Idempotent and self-limiting: rows whose expected path already exists cost
 * one existsSync; only mismatches trigger a scan. Also run on every boot
 * (heals any drift, e.g. a crash between the SQL commit and a prior
 * reconcile). Afterwards, now-empty legacy channel dirs are swept.
 */
export function reconcileChannelFileDirs(db: Database, dataDir: string): void {
  const root = join(dataDir, "channel-files")
  if (!existsSync(root)) return
  const rows = db.select().from(channelFiles).all()
  for (const row of rows) {
    const targetDir = join(root, String(row.messageId))
    if (existsSync(join(targetDir, row.filename))) continue
    // Find the file under a legacy <channelId>/<messageId>/ layer and move
    // it up into the flat <messageId>/ dir (per-file move: collision-safe
    // when a message dir was partially healed earlier).
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === String(row.messageId)) {
        continue
      }
      const legacyFile = join(
        root,
        entry.name,
        String(row.messageId),
        row.filename
      )
      if (!existsSync(legacyFile)) continue
      mkdirSync(targetDir, { recursive: true })
      renameSync(legacyFile, join(targetDir, row.filename))
      break
    }
  }
  sweepLegacyChannelDirs(root)
}

/** Remove leftover legacy `<channelId>` layer dirs that hold no files at any
 * depth (message dirs are numeric; anything else is a v17 channel uuid).
 * Conservative: a dir still holding ANY file is kept. */
function sweepLegacyChannelDirs(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (/^\d+$/.test(entry.name)) continue
    if (!dirHasFiles(join(root, entry.name))) {
      rmSync(join(root, entry.name), { recursive: true, force: true })
    }
  }
}

function dirHasFiles(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && dirHasFiles(join(dir, entry.name))) return true
  }
  return false
}

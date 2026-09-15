import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { gzipSync, gunzipSync } from "node:zlib"

import { isTerminalAgentStatus } from "@aegisx/shared"
import { and, asc, eq, gt, sql } from "drizzle-orm"

import type { Database } from "../../db"
import { agents, sessionEntries, sessions } from "../../db/schema"
import { parseJson } from "../../lib/guards"

/** One archived session-entry row — the full `session_entries` shape, so an
 * archived row is byte-equivalent to a database row for every reader (entry
 * codec, message lists, adapter resume). */
export type ArchivedEntryRow = typeof sessionEntries.$inferSelect

const ARCHIVE_SUFFIX = ".jsonl.gz"

/** Root of the session archive: <dataDir>/archive/sessions. */
function archiveDirOf(dataDir: string): string {
  return join(dataDir, "archive", "sessions")
}

/** The gzip jsonl file holding one session's entries, one JSON row per line
 * in canonical (seq) order. */
function archivePathOf(dataDir: string, sessionId: string): string {
  return join(archiveDirOf(dataDir), `${sessionId}${ARCHIVE_SUFFIX}`)
}

/** Write bytes to `finalPath` durably: temp file in the same directory →
 * write + fsync → atomic rename → directory fsync. A crash leaves either
 * the old file or the complete new one, never a partial. */
function writeFileDurable(finalPath: string, bytes: Uint8Array): void {
  const dir = dirname(finalPath)
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`)
  const fd = openSync(tmpPath, "w")
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, finalPath)
  let dirFd: number | null = null
  try {
    dirFd = openSync(dir, "r")
    fsyncSync(dirFd)
  } catch {
    // Directory fsync is best-effort on filesystems that refuse it.
  } finally {
    if (dirFd !== null) closeSync(dirFd)
  }
}

/**
 * Archive one session's entries: gzip every `session_entries` row into
 * `archive/sessions/<sessionId>.jsonl.gz` (file written + fsynced BEFORE the
 * database delete, so a crash between the two can lose nothing), then delete
 * the archived prefix from the database in a transaction that re-checks the
 * owner agent is still terminal (a dm cold-wake may revive it mid-sweep; a
 * revived agent's session keeps its rows). Usage rollups are untouched —
 * they already hold the session's stats, and archived sessions must keep
 * reporting their full history.
 *
 * The file write is a MERGE, not a replacement: existing archive rows are
 * unioned in by seq (database rows win the — crash-window-only — overlap)
 * before the durable write, so re-archiving a session that appended rows
 * since its last archive (dm cold-wake → new turns → terminal → sweep)
 * extends the file instead of silently dropping the archived prefix.
 *
 * Idempotent: a session with no rows is a no-op.
 */
export function archiveSession(
  db: Database,
  dataDir: string,
  sessionId: string
): void {
  mkdirSync(archiveDirOf(dataDir), { recursive: true })
  const dbRows = db
    .select()
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(asc(sessionEntries.seq))
    .all()
  if (dbRows.length === 0) return

  const bySeq = new Map<number, ArchivedEntryRow>()
  for (const row of readArchivedRows(dataDir, sessionId)) {
    bySeq.set(row.seq, row)
  }
  for (const row of dbRows) {
    bySeq.set(row.seq, row) // database wins the (should-be-empty) overlap
  }
  const merged = [...bySeq.values()].toSorted(
    (left, right) => left.seq - right.seq
  )
  const lines = merged.map((row) => JSON.stringify(row))
  const bytes = gzipSync(Buffer.from(`${lines.join("\n")}\n`, "utf8"))
  writeFileDurable(archivePathOf(dataDir, sessionId), bytes)

  const maxArchivedSeq = merged[merged.length - 1].seq
  db.transaction((tx) => {
    const owner = tx
      .select({ status: agents.status })
      .from(sessions)
      .innerJoin(agents, eq(agents.id, sessions.agentId))
      .where(eq(sessions.id, sessionId))
      .get()
    if (!owner || !isTerminalAgentStatus(owner.status)) return
    tx.delete(sessionEntries)
      .where(
        and(
          eq(sessionEntries.sessionId, sessionId),
          sql`${sessionEntries.seq} <= ${maxArchivedSeq}`
        )
      )
      .run()
  })
}

/** Read one session's archive file back to entry rows (corrupt lines are
 * skipped — rows are typed at archive time; parsing only guards against a
 * truncated file). */
function readArchivedRows(
  dataDir: string,
  sessionId: string
): ArchivedEntryRow[] {
  const path = archivePathOf(dataDir, sessionId)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = gunzipSync(readFileSync(path)).toString("utf8")
  } catch {
    return []
  }
  const rows: ArchivedEntryRow[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    const parsed = parseJson<ArchivedEntryRow>(line)
    if (
      parsed &&
      typeof parsed.id === "string" &&
      typeof parsed.seq === "number" &&
      typeof parsed.body === "string"
    ) {
      rows.push(parsed)
    }
  }
  return rows
}

/** Delete one session's archive file (idempotent). The archive module is the
 * only writer/remover of archive files. */
function deleteSessionArchive(dataDir: string, sessionId: string): void {
  rmSync(archivePathOf(dataDir, sessionId), { force: true })
}

/** Delete every archive file of one agent's sessions — wired into agent
 * deletion next to the DB's session cascade. */
export function deleteAgentSessionArchives(
  db: Database,
  dataDir: string,
  agentId: string
): void {
  const ids = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.agentId, agentId))
    .all()
  for (const { id } of ids) deleteSessionArchive(dataDir, id)
}

/**
 * The transparent merged read (correctness, not an optimization): archive +
 * database rows for one session, by seq. Archived rows are a seq-disjoint
 * PREFIX of the session (the archive-then-delete is crash-safe; the crash
 * window leaves file and rows coexisting, and the database side wins the
 * overlap). The file is only read when the cursor can still reach archived
 * rows (`after` below the database's first surviving seq). Also the shared
 * read behind timeline paging, adapter resume, backtrack targets and the
 * rollup recompute — every reader of a session's logical history.
 */
export function loadMergedEntryRows(
  db: Pick<Database, "select">,
  dataDir: string,
  sessionId: string,
  opts: { after?: number } = {}
): ArchivedEntryRow[] {
  const after = opts.after ?? 0
  const dbRows = db
    .select()
    .from(sessionEntries)
    .where(
      and(
        eq(sessionEntries.sessionId, sessionId),
        gt(sessionEntries.seq, after)
      )
    )
    .orderBy(asc(sessionEntries.seq))
    .all()
  const dbMinSeq = dbRows[0]?.seq
  if (dbMinSeq !== undefined && dbMinSeq <= after) return dbRows
  if (!existsSync(archivePathOf(dataDir, sessionId))) return dbRows
  const archived = readArchivedRows(dataDir, sessionId).filter(
    (row) => row.seq > after && (dbMinSeq === undefined || row.seq < dbMinSeq)
  )
  return [...archived, ...dbRows]
}

/**
 * The session's TRUE head: the merged (archive + database) max seq. The
 * messages/list endpoint stamps it on every response so a client holding a
 * cursor ABOVE the head (a backtrack or external truncation elsewhere) can
 * detect its own staleness — `nextAfter` only echoes rows it returned and
 * never drops below the request cursor. The file is consulted only when the
 * database side is empty: archived rows are a seq-prefix, so any surviving
 * database row already bounds the head above the file's.
 */
export function sessionHeadSeq(
  db: Pick<Database, "select">,
  dataDir: string,
  sessionId: string
): number {
  const dbHead =
    db
      .select({ head: sql<number | null>`max(${sessionEntries.seq})` })
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, sessionId))
      .get()?.head ?? 0
  if (dbHead > 0) return dbHead
  let head = 0
  for (const row of readArchivedRows(dataDir, sessionId)) {
    if (row.seq > head) head = row.seq
  }
  return head
}

/**
 * The retention sweep (daily cadence, facade-wired): archive terminal
 * agents' sessions whose newest entry is older than the horizon, then drop
 * archive files whose session rows are gone (event/challenge deletions
 * cascade sessions without a file-level hook — this is the self-heal).
 */
export function sweepSessionArchives(
  db: Database,
  dataDir: string,
  retentionDays: number,
  nowMs: number
): void {
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString()
  const candidates = db
    .select({
      id: sessions.id,
      status: agents.status,
      lastAt: sql<string | null>`max(${sessionEntries.createdAt})`,
    })
    .from(sessions)
    .innerJoin(agents, eq(agents.id, sessions.agentId))
    .leftJoin(sessionEntries, eq(sessionEntries.sessionId, sessions.id))
    .groupBy(sessions.id)
    .all()
    // Terminality is the shared predicate, not a second hardcoded status list.
    .filter(({ status }) => isTerminalAgentStatus(status))
  for (const { id, lastAt } of candidates) {
    try {
      if (lastAt !== null && lastAt >= cutoff) continue
      if (lastAt === null && existsSync(archivePathOf(dataDir, id))) continue
      archiveSession(db, dataDir, id)
    } catch (error) {
      console.error("session archive failed", {
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const dir = archiveDirOf(dataDir)
  if (!existsSync(dir)) return
  const known = new Set(
    db
      .select({ id: sessions.id })
      .from(sessions)
      .all()
      .map((row) => row.id)
  )
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(ARCHIVE_SUFFIX)) continue
    if (!known.has(entry.slice(0, -ARCHIVE_SUFFIX.length))) {
      rmSync(join(dir, entry), { force: true })
    }
  }
}

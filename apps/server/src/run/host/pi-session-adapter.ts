import { randomUUID } from "node:crypto"

import type { TimingMeta, SessionEntryView } from "@aegisx/shared"
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai"
import {
  type NewSessionOptions,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { eq } from "drizzle-orm"

import type { Database } from "../../db"
import { sessionEntries, sessions } from "../../db/schema"
import { entryUsageOf } from "./entry-usage"
import { loadMergedEntryRows } from "./session-archive"
import { entryFromRow, toCanonicalBody } from "./session-entry-codec"
import { applyRollupDelta, rollupDeltaOf } from "./usage-rollups"

/**
 * pi 0.85.1 declares a `private constructor`, which makes `extends
 * SessionManager` a compile error even though the runtime constructor and all
 * instance fields are public plain properties. This cast restates the runtime
 * constructor signature (the same one `SessionManager.inMemory` uses) so the
 * adapter can subclass the real manager — it IS a SessionManager; no bridging
 * cast anywhere else.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- private-constructor declaration vs public runtime constructor (verified against 0.85.1 dist); this is the adapter's founding boundary
const SessionManagerBase = SessionManager as unknown as new (
  cwd: string,
  sessionDir: string,
  sessionFile: string | undefined,
  persist: boolean,
  options: NewSessionOptions | undefined,
  entries: SessionEntry[] | undefined
) => SessionManager

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Queryable columns extracted from an entry at write time. Usage location
 * mirrors entryUsageOf (assistant/toolResult messages; compaction and
 * branch_summary carry their own); missing fields persist as NULL. */
function indexColumnsOf(entry: SessionEntry) {
  const usage = entryUsageOf(entry)
  let role: string | null = null
  let toolName: string | null = null
  if (entry.type === "message") {
    if (
      entry.message.role === "user" ||
      entry.message.role === "assistant" ||
      entry.message.role === "toolResult"
    ) {
      role = entry.message.role
    }
    if (entry.message.role === "toolResult") {
      toolName = entry.message.toolName ?? null
    }
  }
  return {
    role,
    toolName,
    inputTokens: usage ? numOrNull(usage.input) : null,
    outputTokens: usage ? numOrNull(usage.output) : null,
    cacheReadTokens: usage ? numOrNull(usage.cacheRead) : null,
    cacheWriteTokens: usage ? numOrNull(usage.cacheWrite) : null,
    reasoningTokens: usage ? numOrNull(usage.reasoning) : null,
    cost: usage ? numOrNull(usage.cost?.total) : null,
  }
}

/**
 * Owned session store adapter: a real pi `SessionManager` (in-memory tree)
 * that writes every settled entry through to `session_entries` as one
 * canonical row.
 *
 * Writes: the append and branch overrides call super first (pi owns id
 * generation, tree and label bookkeeping), then persist the settled entry —
 * canonical body + first-class columns — and fire `onAppend(entry, seq)`, the
 * signal the event pipeline drives `commitEntry` from. Reads stay pure pi:
 * tree, context and compaction semantics come from the real manager.
 *
 * Resume: rows are de-canonicalized back to pi entries and bulk-loaded via
 * the constructor's `entries` parameter (preserves entry ids and parent
 * chains — replaying through append* would regenerate ids and silently
 * truncate history), then the persisted leaf position
 * (`sessions.active_leaf_id`) is restored.
 */
export class PiSessionAdapter extends SessionManagerBase {
  private readonly db: Database
  private readonly agentId: string
  /** Set by close(): a disposed host session must never write again. pi's
   * abort does not interrupt an in-flight tool call, so a late message_end
   * can reach this manager after dispose — writing here would fork the seq
   * sequence against the reopened session's manager (UNIQUE(session_id, seq)
   * is the backstop). */
  private closed = false
  /** Flipped at the end of the constructor: the BASE constructor initializes
   * the session through `this.newSession()` (virtual dispatch), so the stub
   * guard must pass that call through and reject only later ones. */
  private ready = false
  private nextSeq: number
  /** Fired after every persisted entry (with its seq). pi emits no such event
   * for regular messages, so the storage layer owns it. Set by the
   * agent-session wiring. Consumers receive the owned wire view — the same
   * object the adapter settled, zero copy. */
  onAppend?: (entry: SessionEntryView, seq: number) => void
  /** Pre-persist timing provider: called BEFORE the row insert to compute the
   * `meta` column. Returns null for rows with no timing. Injected by the
   * agent-session wiring (the event pipeline). */
  metaProvider?: (entry: SessionEntryView) => TimingMeta | null

  private constructor(opts: {
    db: Database
    sessionId: string
    agentId: string
    cwd: string
    nextSeq: number
    entries: SessionEntry[]
    activeLeafId: string | null
  }) {
    super(opts.cwd, "", undefined, false, { id: opts.sessionId }, opts.entries)
    this.db = opts.db
    this.agentId = opts.agentId
    this.nextSeq = opts.nextSeq
    // Restore the persisted branch position. With rows present, a null
    // pointer means resetLeaf was the last leaf move; a stale pointer (the
    // tail was physically deleted by backtrack) falls back to the last
    // surviving row and is normalized below.
    if (opts.entries.length > 0) {
      const stored = opts.activeLeafId
      if (stored !== null && this.getEntry(stored)) {
        super.branch(stored)
      } else if (stored === null) {
        super.resetLeaf()
      } else {
        this.persistActiveLeaf(this.getLeafId())
      }
    }
    this.ready = true
  }

  /** Create a new session owned by one agent. */
  static create(opts: {
    agentId: string
    cwd: string
    db: Database
  }): PiSessionAdapter {
    const sessionId = randomUUID()
    opts.db
      .insert(sessions)
      .values({
        id: sessionId,
        agentId: opts.agentId,
        cwd: opts.cwd,
        createdAt: new Date().toISOString(),
      })
      .run()
    return new PiSessionAdapter({
      db: opts.db,
      sessionId,
      agentId: opts.agentId,
      cwd: opts.cwd,
      nextSeq: 0,
      entries: [],
      activeLeafId: null,
    })
  }

  /** Reopen an existing session (resume / cold-restore). Entry rows come
   * from the transparent merged read (database rows + the session archive's
   * seq-disjoint prefix), so a session whose history was archived to disk
   * reloads whole. */
  static open(
    sessionId: string,
    opts: { agentId: string; db: Database; dataDir: string }
  ): PiSessionAdapter {
    const row = opts.db
      .select({
        agentId: sessions.agentId,
        cwd: sessions.cwd,
        activeLeafId: sessions.activeLeafId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()
    if (!row) {
      throw new Error(`PiSessionAdapter: session ${sessionId} not found`)
    }
    if (row.agentId !== opts.agentId) {
      throw new Error(
        `PiSessionAdapter: session ${sessionId} belongs to agent ${row.agentId}, not ${opts.agentId}`
      )
    }
    const rows = loadMergedEntryRows(opts.db, opts.dataDir, sessionId)
    const entries: SessionEntry[] = []
    let nextSeq = 0
    for (const entryRow of rows) {
      if (entryRow.seq > nextSeq) nextSeq = entryRow.seq
      try {
        entries.push(entryFromRow(entryRow))
      } catch (error) {
        // Corrupt row: skip but still count its seq so the next write does
        // not collide.
        console.warn("Skipping corrupt session entry", {
          sessionId,
          seq: entryRow.seq,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return new PiSessionAdapter({
      db: opts.db,
      sessionId,
      agentId: opts.agentId,
      cwd: row.cwd,
      nextSeq,
      entries,
      activeLeafId: row.activeLeafId,
    })
  }

  /** Retire this manager (wired from HostAgentSession.dispose). Idempotent.
   * Writes afterwards throw; reads stay legal — pi touches them freely during
   * teardown. */
  close(): void {
    this.closed = true
  }

  private assertOpen(op: string): void {
    if (this.closed) {
      throw new Error(
        `PiSessionAdapter: ${op} on closed session ${this.getSessionId()}`
      )
    }
  }

  /** The entry super just appended — it is always the new leaf. */
  private settled(id: string): SessionEntry {
    const entry = this.getEntry(id)
    if (!entry) {
      throw new Error(`PiSessionAdapter: appended entry ${id} went missing`)
    }
    return entry
  }

  /** The session id — the database is the source of truth, not a file. */
  override getSessionFile(): string {
    return this.getSessionId()
  }

  override isPersisted(): boolean {
    return true
  }

  // --- appends ------------------------------------------------------------

  private persistEntry(entry: SessionEntry): void {
    const seq = ++this.nextSeq
    // Listeners consume the owned wire view — the same object, re-typed (the
    // view is the wire-side ownership of pi's entry shape, byte-identical).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi entry → wire view at the adapter boundary
    const view = entry as unknown as SessionEntryView
    // meta is computed pre-INSERT (NOT in onAppend, which is post-insert) so
    // it lands in the row itself and survives a refresh.
    const meta = this.metaProvider?.(view) ?? null
    // One explicit transaction: entry row + leaf pointer + usage-rollup
    // increments land together (crash-consistency — the rollup projections
    // are only exact if they can never lag the row they summarize).
    const indexColumns = indexColumnsOf(entry)
    this.db.transaction((tx) => {
      tx.insert(sessionEntries)
        .values({
          id: entry.id,
          sessionId: this.getSessionId(),
          agentId: this.agentId,
          parentId: entry.parentId,
          seq,
          type: entry.type,
          ...indexColumns,
          createdAt: entry.timestamp,
          ...(meta ? { meta: JSON.stringify(meta) } : {}),
          body: JSON.stringify(toCanonicalBody(entry)),
        })
        .run()
      tx.update(sessions)
        .set({ activeLeafId: entry.id })
        .where(eq(sessions.id, this.getSessionId()))
        .run()
      applyRollupDelta(tx, {
        sessionId: this.getSessionId(),
        agentId: this.agentId,
        toolName:
          entry.type === "message" && entry.message.role === "toolResult"
            ? (entry.message.toolName ?? null)
            : null,
        delta: rollupDeltaOf(indexColumns),
        at: new Date().toISOString(),
      })
    })
    this.onAppend?.(view, seq)
  }

  private persistActiveLeaf(id: string | null): void {
    this.db
      .update(sessions)
      .set({ activeLeafId: id })
      .where(eq(sessions.id, this.getSessionId()))
      .run()
  }

  override appendMessage(
    message: Parameters<SessionManager["appendMessage"]>[0]
  ): string {
    this.assertOpen("appendMessage")
    const id = super.appendMessage(message)
    this.persistEntry(this.settled(id))
    return id
  }

  override appendThinkingLevelChange(thinkingLevel: string): string {
    this.assertOpen("appendThinkingLevelChange")
    const id = super.appendThinkingLevelChange(thinkingLevel)
    this.persistEntry(this.settled(id))
    return id
  }

  override appendModelChange(provider: string, modelId: string): string {
    this.assertOpen("appendModelChange")
    const id = super.appendModelChange(provider, modelId)
    this.persistEntry(this.settled(id))
    return id
  }

  override appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage
  ): string {
    this.assertOpen("appendCompaction")
    const id = super.appendCompaction(
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
      usage
    )
    this.persistEntry(this.settled(id))
    return id
  }

  override appendCustomEntry(customType: string, data?: unknown): string {
    this.assertOpen("appendCustomEntry")
    const id = super.appendCustomEntry(customType, data)
    this.persistEntry(this.settled(id))
    return id
  }

  override appendCustomMessageEntry(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: unknown
  ): string {
    this.assertOpen("appendCustomMessageEntry")
    const id = super.appendCustomMessageEntry(
      customType,
      content,
      display,
      details
    )
    this.persistEntry(this.settled(id))
    return id
  }

  override appendSessionInfo(name: string): string {
    this.assertOpen("appendSessionInfo")
    const id = super.appendSessionInfo(name)
    this.persistEntry(this.settled(id))
    return id
  }

  override appendLabelChange(
    targetId: string,
    label: string | undefined
  ): string {
    this.assertOpen("appendLabelChange")
    const id = super.appendLabelChange(targetId, label)
    this.persistEntry(this.settled(id))
    return id
  }

  // --- branching ----------------------------------------------------------

  override branch(branchFromId: string): void {
    this.assertOpen("branch")
    super.branch(branchFromId)
    this.persistActiveLeaf(this.getLeafId())
  }

  override resetLeaf(): void {
    this.assertOpen("resetLeaf")
    super.resetLeaf()
    this.persistActiveLeaf(null)
  }

  override branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage
  ): string {
    this.assertOpen("branchWithSummary")
    const id = super.branchWithSummary(
      branchFromId,
      summary,
      details,
      fromHook,
      usage
    )
    this.persistEntry(this.settled(id))
    return id
  }

  // --- stubs (file/fork/list semantics; AegisX never reaches these) -------

  override newSession(options?: NewSessionOptions): string | undefined {
    if (this.ready) {
      throw new Error("PiSessionAdapter.newSession is not supported")
    }
    return super.newSession(options)
  }

  override setSessionFile(_sessionFile: string): void {
    throw new Error("PiSessionAdapter.setSessionFile is not supported")
  }

  override createBranchedSession(_leafId: string): string | undefined {
    throw new Error("PiSessionAdapter.createBranchedSession is not supported")
  }
}

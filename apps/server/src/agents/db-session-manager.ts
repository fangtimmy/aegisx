import { randomUUID } from "node:crypto"

import type { TimingMeta } from "@aegisx/shared"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai"
import {
  buildContextEntries,
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  type NewSessionOptions,
  type SessionEntry,
  type SessionHeader,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent"
import { asc, eq } from "drizzle-orm"

import type { Database } from "../db"
import { sessionEntries, sessions } from "../db/schema"
import { parseJson } from "../lib/guards"

/** Short unique id with collision check (mirrors pi's generateId). */
function generateId(byId: Map<string, unknown>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8)
    if (!byId.has(id)) return id
  }
  return randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Database-backed drop-in replacement for pi's `SessionManager`.
 *
 * pi writes its append-only session tree through the `sessionManager` it is
 * handed at construction. By injecting a `DbSessionManager` instead of the
 * default jsonl one, every `SessionEntry` pi produces is persisted as one row
 * of `session_entries` — byte-for-byte the JSON it would have written to a
 * jsonl line. The database becomes the single source of truth; no jsonl file
 * is created. Read paths (`buildSessionContext`, `getBranch`, ...) reuse pi's
 * own exported pure functions, so tree/compaction semantics stay identical to
 * upstream.
 *
 * The public surface mirrors {@link SessionManager}. pi's class carries private
 * state that defeats a TypeScript `implements` check, so the contract is locked
 * at runtime instead: `db-session-manager.test` runs DbSessionManager
 * side-by-side with `SessionManager.inMemory` on the same entry sequence and
 * asserts identical tree/context output. Methods AegisX never reaches
 * (file/fork/list) throw `unsupported` so an accidental call fails loudly
 * rather than silently no-op'ing.
 */
export class DbSessionManager {
  private readonly db: Database
  private readonly sessionId: string
  private readonly agentId: string
  private readonly cwd: string
  private readonly createdAt: string
  private nextSeq = 0
  private readonly fileEntries: SessionEntry[] = []
  private readonly byId = new Map<string, SessionEntry>()
  private leafId: string | null = null
  /** Fired at the end of commit() for every persisted entry (with its seq).
   * The event pipeline uses this as the authoritative "entry just persisted"
   * signal — pi emits no such event for regular messages, so the storage layer
   * owns it. Set by the agent-session wiring. */
  onAppend?: (entry: SessionEntry, seq: number) => void
  /** Pre-commit timing provider (v10): called inside commit() BEFORE db.insert
   * to compute the `meta` column for the row. Returns null for rows with no
   * timing (non-message kinds, or messages the pipeline didn't time — e.g.
   * legacy resumes). Injected by the agent-session wiring (the event pipeline). */
  metaProvider?: (entry: SessionEntry) => TimingMeta | null

  private constructor(opts: {
    sessionId: string
    agentId: string
    cwd: string
    createdAt: string
    db: Database
  }) {
    this.db = opts.db
    this.sessionId = opts.sessionId
    this.agentId = opts.agentId
    this.cwd = opts.cwd
    this.createdAt = opts.createdAt
  }

  /**
   * Create a new database session owned by one agent.
   */
  static create(opts: {
    agentId: string
    cwd: string
    db: Database
  }): DbSessionManager {
    const sessionId = randomUUID()
    const createdAt = nowIso()
    opts.db
      .insert(sessions)
      .values({
        id: sessionId,
        agentId: opts.agentId,
        cwd: opts.cwd,
        createdAt,
      })
      .run()
    return new DbSessionManager({
      sessionId,
      agentId: opts.agentId,
      cwd: opts.cwd,
      createdAt,
      db: opts.db,
    })
  }

  /** Reopen an existing database session (resume / cold-restore). */
  static open(
    sessionId: string,
    opts: { agentId: string; db: Database }
  ): DbSessionManager {
    const row = opts.db
      .select({ cwd: sessions.cwd, createdAt: sessions.createdAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()
    if (!row) {
      throw new Error(`DbSessionManager: session ${sessionId} not found`)
    }
    const sm = new DbSessionManager({
      sessionId,
      agentId: opts.agentId,
      cwd: row.cwd,
      createdAt: row.createdAt,
      db: opts.db,
    })
    sm.load()
    return sm
  }

  /** Rebuild in-memory indices from persisted entries (resume path). */
  private load(): void {
    const rows = this.db
      .select()
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, this.sessionId))
      .orderBy(asc(sessionEntries.seq))
      .all()
    for (const row of rows) {
      let entry: SessionEntry
      try {
        // Written by this class (typed at commit time); parse only guards
        // against corrupt/truncated rows.
        entry = parseJson<SessionEntry>(row.data)
      } catch (error) {
        // Corrupt row: skip but still count its seq so the next commit
        // does not collide.
        console.warn("Skipping corrupt session entry", {
          sessionId: this.sessionId,
          seq: row.seq,
          error: error instanceof Error ? error.message : String(error),
        })
        if (row.seq > this.nextSeq) this.nextSeq = row.seq
        continue
      }
      this.fileEntries.push(entry)
      this.byId.set(entry.id, entry)
      this.leafId = entry.id
      if (row.seq > this.nextSeq) this.nextSeq = row.seq
    }
  }

  /** Append an entry: assign id/parentId/timestamp, update memory, persist. */
  private commit(type: string, payload: Record<string, unknown>): SessionEntry {
    // Payload pieces are typed at each append* call site; the union cannot be
    // expressed as a single spread parameter.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const entry = {
      ...payload,
      type,
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: nowIso(),
    } as unknown as SessionEntry
    this.fileEntries.push(entry)
    this.byId.set(entry.id, entry)
    this.leafId = entry.id
    const seq = ++this.nextSeq
    // meta is injected pre-commit (NOT onAppend, which is post-insert) so it
    // lands in the row itself and survives a refresh.
    const meta = this.metaProvider?.(entry) ?? null
    this.db
      .insert(sessionEntries)
      .values({
        id: entry.id,
        sessionId: this.sessionId,
        agentId: this.agentId,
        parentId: entry.parentId,
        seq,
        type: entry.type,
        data: JSON.stringify(entry),
        ...(meta ? { meta: JSON.stringify(meta) } : {}),
        createdAt: entry.timestamp,
      })
      .run()
    this.onAppend?.(entry, seq)
    return entry
  }

  // --- appends ------------------------------------------------------------

  appendMessage(message: AgentMessage): string {
    return this.commit("message", { message }).id
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    return this.commit("thinking_level_change", { thinkingLevel }).id
  }

  appendModelChange(provider: string, modelId: string): string {
    return this.commit("model_change", { provider, modelId }).id
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage
  ): string {
    return this.commit("compaction", {
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      usage,
      fromHook,
    }).id
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.commit("custom", { customType, data }).id
  }

  appendCustomMessageEntry(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: unknown
  ): string {
    return this.commit("custom_message", {
      customType,
      content,
      display,
      details,
    }).id
  }

  appendSessionInfo(name: string): string {
    const sanitized = name.replace(/[\r\n]+/g, " ").trim()
    return this.commit("session_info", { name: sanitized }).id
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`)
    }
    // The label entry is persisted (resume + getTree/getLabel derive from it).
    // The two in-memory maps are gone; labels are read on demand.
    return this.commit("label", { targetId, label }).id
  }

  // --- reads --------------------------------------------------------------

  getCwd(): string {
    return this.cwd
  }

  getSessionId(): string {
    return this.sessionId
  }

  /** Returns the session id — the database is the source of truth, not a file. */
  getSessionFile(): string {
    return this.sessionId
  }

  getSessionName(): string | undefined {
    for (let i = this.fileEntries.length - 1; i >= 0; i--) {
      const entry = this.fileEntries[i]
      if (entry.type === "session_info") {
        return entry.name?.trim() || undefined
      }
    }
    return undefined
  }

  getEntries(): SessionEntry[] {
    return [...this.fileEntries]
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id)
  }

  getLeafId(): string | null {
    return this.leafId
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined
  }

  getChildren(parentId: string): SessionEntry[] {
    const children: SessionEntry[] = []
    for (const entry of this.byId.values()) {
      if (entry.parentId === parentId) children.push(entry)
    }
    return children
  }

  getLabel(id: string): string | undefined {
    return this.labelFor(id).label
  }

  /** Latest label applied to an entry id, scanning entries in append order
   * (the last set wins; an explicit clear → undefined). Replaces the two
   * in-memory maps; labels are rare so this is acceptable. */
  private labelFor(targetId: string): {
    label?: string
    labelTimestamp?: string
  } {
    let label: string | undefined
    let labelTimestamp: string | undefined
    for (const entry of this.fileEntries) {
      if (entry.type === "label" && entry.targetId === targetId) {
        if (entry.label) {
          label = entry.label
          labelTimestamp = entry.timestamp
        } else {
          label = undefined
          labelTimestamp = undefined
        }
      }
    }
    return label !== undefined ? { label, labelTimestamp } : {}
  }

  /** Walk from an entry (default: leaf) to root, in path order. */
  getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = []
    const startId = fromId ?? this.leafId
    let current = startId ? this.byId.get(startId) : undefined
    while (current) {
      path.push(current)
      current = current.parentId ? this.byId.get(current.parentId) : undefined
    }
    path.reverse()
    return path
  }

  buildContextEntries(): SessionEntry[] {
    return buildContextEntries(this.fileEntries, this.leafId, this.byId)
  }

  buildSessionContext() {
    return buildSessionContext(this.fileEntries, this.leafId, this.byId)
  }

  getHeader(): SessionHeader {
    return {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp: this.createdAt,
      cwd: this.cwd,
    }
  }

  getTree(): SessionTreeNode[] {
    const entries = this.getEntries()
    // Latest label per target id in one pass (replaces the two maps).
    const labels = new Map<string, { label: string; labelTimestamp: string }>()
    for (const entry of entries) {
      if (entry.type === "label") {
        if (entry.label) {
          labels.set(entry.targetId, {
            label: entry.label,
            labelTimestamp: entry.timestamp,
          })
        } else {
          labels.delete(entry.targetId)
        }
      }
    }
    const nodeMap = new Map<string, SessionTreeNode>()
    const roots: SessionTreeNode[] = []
    const created: SessionTreeNode[] = []
    for (const entry of entries) {
      const l = labels.get(entry.id)
      const node: SessionTreeNode = {
        entry,
        children: [],
        ...(l ? { label: l.label, labelTimestamp: l.labelTimestamp } : {}),
      }
      nodeMap.set(entry.id, node)
      created.push(node)
    }
    for (const [i, entry] of entries.entries()) {
      const node = created[i]
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node)
      } else {
        const parent = nodeMap.get(entry.parentId)
        if (parent) parent.children.push(node)
        else roots.push(node)
      }
    }
    const stack: SessionTreeNode[] = [...roots]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node) break
      node.children.sort(
        (a, b) =>
          new Date(a.entry.timestamp).getTime() -
          new Date(b.entry.timestamp).getTime()
      )
      stack.push(...node.children)
    }
    return roots
  }

  // --- branching ----------------------------------------------------------

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`)
    }
    this.leafId = branchFromId
  }

  resetLeaf(): void {
    this.leafId = null
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage
  ): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`)
    }
    this.leafId = branchFromId
    const entry = this.commit("branch_summary", {
      fromId: branchFromId ?? "root",
      summary,
      details,
      usage,
      fromHook,
    })
    return entry.id
  }

  // --- stubs (file/fork/list semantics; AegisX never reaches these) -------

  isPersisted(): boolean {
    return true
  }

  usesDefaultSessionDir(): boolean {
    return false
  }

  getSessionDir(): string {
    return ""
  }

  newSession(_options?: NewSessionOptions): string {
    throw new Error("DbSessionManager.newSession is not supported")
  }

  setSessionFile(_sessionFile: string): void {
    throw new Error("DbSessionManager.setSessionFile is not supported")
  }

  createBranchedSession(_leafId: string): string {
    throw new Error("DbSessionManager.createBranchedSession is not supported")
  }
}

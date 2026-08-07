import { randomUUID } from "node:crypto"

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

import type { createDatabase } from "../db"
import { sessionEntries, sessions } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

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
  private readonly ownerType: "run" | "orchestrator"
  private readonly ownerId: string
  /** Runs/agents FK target for run-owned sessions; undefined for orchestrator. */
  private readonly runId: string | undefined
  private readonly agentId: string | undefined
  private readonly cwd: string
  private readonly createdAt: string
  private readonly fileEntries: SessionEntry[] = []
  private readonly byId = new Map<string, SessionEntry>()
  private readonly labelsById = new Map<string, string>()
  private readonly labelTimestampsById = new Map<string, string>()
  private leafId: string | null = null
  /** Fired at the end of commit() for every persisted entry (with its seq).
   * The event pipeline uses this as the authoritative "entry just persisted"
   * signal — pi emits no such event for regular messages, so the storage layer
   * owns it. Set by the agent-session wiring. */
  onAppend?: (entry: SessionEntry, seq: number) => void

  private constructor(opts: {
    sessionId: string
    ownerType: "run" | "orchestrator"
    ownerId: string
    runId?: string
    agentId?: string
    cwd: string
    createdAt: string
    db: Database
  }) {
    this.db = opts.db
    this.sessionId = opts.sessionId
    this.ownerType = opts.ownerType
    this.ownerId = opts.ownerId
    this.runId = opts.runId
    this.agentId = opts.agentId
    this.cwd = opts.cwd
    this.createdAt = opts.createdAt
  }

  /**
   * Create a new database session. `ownerType` defaults to 'run' for back-compat
   * (run callers pass runId/agentId and get ownerType='run', ownerId=runId).
   * Orchestrator sessions pass ownerType='orchestrator', ownerId=eventId and
   * omit runId/agentId.
   */
  static create(opts: {
    cwd: string
    ownerType?: "run" | "orchestrator"
    /** The run id (run) or event id (orchestrator). Defaults to runId. */
    ownerId?: string
    /** Run-owned sessions: the runs/agents FK targets. */
    runId?: string
    agentId?: string
    db: Database
  }): DbSessionManager {
    const ownerType = opts.ownerType ?? "run"
    const ownerId = opts.ownerId ?? opts.runId
    if (!ownerId) {
      throw new Error("DbSessionManager.create requires ownerId (or runId)")
    }
    const sessionId = randomUUID()
    const createdAt = nowIso()
    opts.db
      .insert(sessions)
      .values({
        id: sessionId,
        ownerType,
        ownerId,
        runId: opts.runId ?? null,
        agentId: opts.agentId ?? null,
        cwd: opts.cwd,
        createdAt,
      })
      .run()
    return new DbSessionManager({
      sessionId,
      ownerType,
      ownerId,
      runId: opts.runId,
      agentId: opts.agentId,
      cwd: opts.cwd,
      createdAt,
      db: opts.db,
    })
  }

  /** Reopen an existing database session (resume / cold-restore). Same
   * owner-dimension convention as create(). */
  static open(
    sessionId: string,
    opts: {
      ownerType?: "run" | "orchestrator"
      ownerId?: string
      runId?: string
      agentId?: string
      db: Database
    }
  ): DbSessionManager {
    const ownerType = opts.ownerType ?? "run"
    const ownerId = opts.ownerId ?? opts.runId
    if (!ownerId) {
      throw new Error("DbSessionManager.open requires ownerId (or runId)")
    }
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
      ownerType,
      ownerId,
      runId: opts.runId,
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
        entry = JSON.parse(row.data) as SessionEntry
      } catch {
        continue
      }
      this.fileEntries.push(entry)
      this.byId.set(entry.id, entry)
      this.leafId = entry.id
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label)
          this.labelTimestampsById.set(entry.targetId, entry.timestamp)
        } else {
          this.labelsById.delete(entry.targetId)
          this.labelTimestampsById.delete(entry.targetId)
        }
      }
    }
  }

  /** Append an entry: assign id/parentId/timestamp, update memory, persist. */
  private commit(type: string, payload: Record<string, unknown>): SessionEntry {
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
    const seq = this.fileEntries.length
    this.db
      .insert(sessionEntries)
      .values({
        id: entry.id,
        sessionId: this.sessionId,
        ownerType: this.ownerType,
        ownerId: this.ownerId,
        runId: this.runId ?? null,
        agentId: this.agentId ?? null,
        parentId: entry.parentId,
        seq,
        type: entry.type,
        data: JSON.stringify(entry),
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

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
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

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: T
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
    const entry = this.commit("label", { targetId, label })
    if (label) {
      this.labelsById.set(targetId, label)
      this.labelTimestampsById.set(targetId, entry.timestamp)
    } else {
      this.labelsById.delete(targetId)
      this.labelTimestampsById.delete(targetId)
    }
    return entry.id
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
    return this.labelsById.get(id)
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
    const nodeMap = new Map<string, SessionTreeNode>()
    const roots: SessionTreeNode[] = []
    for (const entry of entries) {
      const label = this.labelsById.get(entry.id)
      const labelTimestamp = this.labelTimestampsById.get(entry.id)
      const node: SessionTreeNode = {
        entry,
        children: [],
        ...(label !== undefined ? { label } : {}),
        ...(labelTimestamp !== undefined ? { labelTimestamp } : {}),
      }
      nodeMap.set(entry.id, node)
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id) as SessionTreeNode
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
      const node = stack.pop() as SessionTreeNode
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

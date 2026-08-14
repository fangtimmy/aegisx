import type { AgentStatus } from "./run-status"

/** One active tool's definition snapshot (for the timeline 工具定义 panel).
 * `parameters` is the tool's TypeBox schema serialized to JSON Schema. */
/** One session of an agent (multi-session v12): a `sessions` row + its message
 * count + the active flag (whether it is the agent's current sessionFile
 * pointer). Sessions are per-agent conversation threads; exactly one is active
 * at a time. Display name is derived client-side by creation order. */
export type AgentSessionSummary = {
  id: string
  createdAt: string
  messageCount: number
  isActive: boolean
}

export type ToolDefinitionSnapshot = {
  name: string
  description: string
  parameters: unknown
  promptGuidelines?: string[]
}

/** v8 agent: a pi session + role + model + prompt + tools, snapshotted on the
 * row at createAgent time. A run declares N agents (classic = 1 solver);
 * spawn adds child agents (parentAgentId set). */
export type AgentSummary = {
  id: string
  runId: string
  /** Run-unique createAgent idempotency key; spawn child = `child-<8char>`. */
  slot: string
  /** Free-form role ('solver' / 'observer' / 'orchestrator' / 'child' ...). */
  role: string
  /** Non-null = spawn child; references the delegating parent agent. */
  parentAgentId: string | null
  /** Entry agent (run-level default conversation target); at most one per run. */
  isEntry: boolean
  name: string | null
  /** Delegated task text (spawn children). */
  task: string | null
  /** Canonical model ref snapshot (`<providerKey>/<modelId>:<effort>` | alias),
   * persisted on the agent row at createAgent/switch time. */
  model: string | null
  /** Full system prompt snapshot (createAgent writes once; cold-restore
   * reuses). Exposed so the timeline can render a system-config card. */
  systemPrompt: string
  /** Tool allowlist snapshot (real tool names; file tools always on, not
   * listed). JSON-parsed from the agents row. */
  tools: string[]
  /** Active tool-definition snapshots (name/description/JSON-schema), incl.
   * the always-on file tools. Empty for pre-v11 rows without a snapshot. */
  toolDefinitions: ToolDefinitionSnapshot[]
  status: AgentStatus
  /** Session id (DB) or legacy jsonl path for this agent (resume + audit). */
  sessionFile: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
  error: string | null
}

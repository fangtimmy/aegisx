import type { AgentStatus } from "./run-status"

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
  status: AgentStatus
  /** Session id (DB) or legacy jsonl path for this agent (resume + audit). */
  sessionFile: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
  error: string | null
}

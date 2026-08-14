import { DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE } from "@aegisx/shared/prompt-defaults"

import { defineOrchestration, type EventHandle, type RunHandle } from "./types"

/** Scheduler wiring (spec §7.5): wake the orchestrator on child-run lifecycle
 * events. Each wake-up sends the orchestrator a fresh turn to read + decide.
 * `run.finished` covers finish_run/force-finish completions — without it a run
 * that closes without ever settling idle (solver finishes in its first turn)
 * would never wake the orchestrator. `run.resumed` covers cold-restores of
 * closed runs (user reopens a solver) so the orchestrator never decides on
 * stale state; `run.started` confirms external/manual launches. */
function wire(run: RunHandle, event: EventHandle): void {
  const orch = run.agent("orchestrator")
  event.on("run.started", (e) => orch.send(`Run ${e.runId} 已启动。`))
  event.on("run.idle", (e) =>
    orch.send(
      `Run ${e.runId} 转入 idle${e.failed ? "（有 agent 失败）" : ""}。`
    )
  )
  event.on("run.flagAccepted", (e) => orch.send(`Run ${e.runId} 解出 flag。`))
  event.on("run.finished", (e) => orch.send(`Run ${e.runId} 已完成。`))
  event.on("run.timedOut", (e) =>
    orch.send(`Run ${e.runId} 超时（${e.outcome}），决定延长/关闭/重排。`)
  )
  event.on("run.resumed", (e) => orch.send(`Run ${e.runId} 已恢复。`))
}

/**
 * scheduler — the event-scoped orchestrator run (spec §7.5). One 'orchestrator'
 * agent holds the event's strategy; it manages the task queue + sibling
 * challenge runs via the scheduler tools, and is woken on child-run lifecycle
 * events (started / idle / flagAccepted / finished / timedOut / resumed) to
 * read + decide.
 *
 * The orchestrator's model defaults to the global orchestration setting
 * (`agentModels.scheduler.orchestrator`); a per-event `scheduler_config.model`
 * overrides it.
 */
export default defineOrchestration({
  id: "scheduler",
  scope: "event",
  agents: [
    {
      slot: "orchestrator",
      role: "orchestrator",
      name: "Scheduler",
      entry: true,
      systemPrompt: "orchestratorSystem",
      tools: [
        // Queue CRUD (the plan = queue content).
        "enqueue_run",
        "list_queue",
        "remove_queue",
        "clear_queue",
        "reorder_queue",
        // Direct run management (escape hatch + read).
        "start_run",
        "stop_run",
        "message_run",
        "close_run",
        "read_run",
        "set_run_timeout",
        // Read-only inventory.
        "list_challenges",
        "get_challenge",
        "list_runs",
        "get_status",
        "list_agents",
      ],
      prime: true,
    },
  ],
  // Event-scope runs have no challenge context; the builtin `initial` template
  // renders {{challenge.*}}, so the scheduler overrides `initial` with an
  // event + instruction variant (render order: plugin → builtin).
  templates: { initial: DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE },
  wire,
})

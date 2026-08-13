import { DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE } from "@aegisx/shared/prompt-defaults"
import { Type } from "typebox"

import {
  defineOrchestration,
  ModelRefSchema,
  type EventHandle,
  type ModelRef,
  type RunHandle,
} from "./types"

/** Scheduler wiring (spec §7.5): wake the orchestrator on child-run lifecycle
 * events. Each wake-up sends the orchestrator a fresh turn to read + decide. */
function wire(run: RunHandle, event: EventHandle): void {
  const orch = run.agent("orchestrator")
  event.on("run.idle", (e) => orch.send(`Run ${e.runId} 转入 idle。`))
  event.on("run.flagAccepted", (e) => orch.send(`Run ${e.runId} 解出 flag。`))
  event.on("run.timedOut", (e) =>
    orch.send(`Run ${e.runId} 超时（${e.outcome}），决定延长/关闭/重排。`)
  )
}

/**
 * scheduler — the event-scoped orchestrator run (spec §7.5). One 'orchestrator'
 * agent holds the event's strategy; child-run lifecycle events wake it to
 * read + decide. The queue/run-management tools (enqueue_run, start_run,
 * message_run, ...) land with the P3 scheduler-queue work; P2 grants only the
 * tools that exist today (list_agents; file tools are always on), so the run
 * can be created and its event loop exercised end-to-end.
 */
export default defineOrchestration<{ model: ModelRef }>({
  id: "scheduler",
  scope: "event",
  params: Type.Object({ model: ModelRefSchema }),
  // Event-scope runs have no challenge context; the builtin `initial` template
  // renders {{challenge.*}}, so the scheduler overrides `initial` with an
  // event + instruction variant (render order: plugin → builtin).
  templates: { initial: DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE },
  setup(run, event) {
    run.createAgent({
      slot: "orchestrator",
      role: "orchestrator",
      name: "Scheduler",
      entry: true,
      systemPrompt: "orchestratorSystem",
      tools: ["list_agents"],
      model: run.params.model,
      prime: run.initialPrompt,
    })
    wire(run, event)
  },
})

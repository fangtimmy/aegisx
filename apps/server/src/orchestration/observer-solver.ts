import { DEFAULT_OBSERVER_SYSTEM_PROMPT_TEMPLATE } from "@aegisx/shared/prompt-defaults"
import { Type } from "typebox"

import { solverTools } from "./common"
import {
  defineOrchestration,
  ModelRefSchema,
  type ModelRef,
  type RunHandle,
} from "./types"

/** Observer-solver wiring (spec §7.2): every solver turn ends (or a flag is
 * accepted), the observer is woken to review with read_agent and steer with
 * message_agent when the solver goes off track. */
function wire(run: RunHandle): void {
  const solver = run.agent("solver")
  solver.on("turnEnded", () =>
    run
      .agent("observer")
      .send("Solver 结束一轮。用 read_agent 看进展，需要纠偏就 message_agent。")
  )
  solver.on("flagAccepted", () =>
    run.agent("observer").send("Solver 提交了 flag，复核一下。")
  )
}

/**
 * observer-solver — supervised solving (spec §7.2). A full solver drives the
 * challenge; a separate observer (its own model, no finish/flag/target/spawn
 * capability) reviews each turn and steers via message_agent.
 */
export default defineOrchestration<{ observerModel: ModelRef }>({
  id: "observer-solver",
  label: "Observer-Solver",
  description: "求解者 + 观察者，观察者按轮复查并纠偏。",
  scope: "challenge",
  params: Type.Object({ observerModel: ModelRefSchema }),
  templates: { observerSystem: DEFAULT_OBSERVER_SYSTEM_PROMPT_TEMPLATE },
  setup(run) {
    run.createAgent({
      slot: "solver",
      name: "Solver",
      entry: true,
      systemPrompt: "mainSystem",
      tools: solverTools(run.ctx),
      model: "default",
      prime: run.initialPrompt,
    })
    run.createAgent({
      slot: "observer",
      name: "Observer",
      systemPrompt: "observerSystem",
      tools: ["message_agent", "read_agent", "list_agents"],
      model: run.params.observerModel,
    })
    wire(run)
  },
  spawn: { systemPrompt: "childSystem", tools: [], model: "default" },
})

import { DEFAULT_TRIO_SYSTEM_PROMPT_TEMPLATE } from "@aegisx/shared/prompt-defaults"
import { Type } from "typebox"

import { trioTools } from "./common"
import { defineOrchestration, ModelRefSchema, type ModelRef } from "./types"

/**
 * trio — three peer solvers on one container/workspace (spec §7.4). Each gets
 * its own model from params (exactly 3), all prime the run's initial prompt,
 * and peers coordinate via message_agent/read_agent/list_agents. solver-a is
 * the entry agent (run-level default conversation target). Finish is racy by
 * design: the first finish_run wins the atomic teardown; the rest no-op.
 */
export default defineOrchestration<{ models: ModelRef[] }>({
  id: "trio",
  scope: "challenge",
  params: Type.Object({
    models: Type.Array(ModelRefSchema, { minItems: 3, maxItems: 3 }),
  }),
  templates: { trioSystem: DEFAULT_TRIO_SYSTEM_PROMPT_TEMPLATE },
  setup(run) {
    const slots = ["solver-a", "solver-b", "solver-c"] as const
    slots.forEach((slot, i) =>
      run.createAgent({
        slot,
        role: "solver",
        name: `Solver ${i + 1}`,
        systemPrompt: "trioSystem",
        tools: trioTools(run.ctx),
        model: run.params.models[i],
        prime: run.initialPrompt,
        ...(i === 0 ? { entry: true } : {}),
      })
    )
  },
  spawn: { systemPrompt: "childSystem", tools: [], model: "default" },
})

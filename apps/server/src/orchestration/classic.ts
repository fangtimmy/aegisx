import { Type } from "typebox"

import { solverTools } from "./common"
import { defineOrchestration } from "./types"

/**
 * classic — the single-solver orchestration (spec §7.1).
 *
 * One entry agent ("solver") with the full CTF tool set. The tool list is
 * assembled conditionally from the run's challenge context so it matches v7
 * behavior exactly: `submit_flag` only when the challenge is platform-
 * integrated, the four `*_target` tools only when a remote target is
 * supported. Per-agent capabilities are then DERIVED from this list (§3.7) and
 * injected into the rendered `mainSystem` prompt — so a non-platform run's
 * prompt advertises no flag capability, identical to before.
 *
 * The spec's §7.1 literal shows a fixed full tool array; that is simplified.
 * The conditional assembly here preserves single-solver parity (the explicit
 * P1c goal) while keeping capabilities tool-derived.
 */
export default defineOrchestration({
  id: "classic",
  label: "Classic",
  description: "单个求解者，适合大多数题目。",
  scope: "challenge",
  params: Type.Object({}),
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
  },
  spawn: { systemPrompt: "childSystem", tools: [], model: "default" },
})

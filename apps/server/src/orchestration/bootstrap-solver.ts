import { DEFAULT_BOOTSTRAP_SYSTEM_PROMPT_TEMPLATE } from "@aegisx/shared/prompt-defaults"

import { bootstrapTools, solverTools } from "./common"
import { defineOrchestration, type RunHandle } from "./types"

/**
 * bootstrap-solver — serial recon then solve (spec §7.3). The bootstrap agent
 * (prime, no finish_run → canFinish derives false) runs one full recon turn,
 * staging everything in the workspace; on its turn end the solver is driven to
 * finish the job (entry, the run-level default conversation target).
 */
export default defineOrchestration({
  id: "bootstrap-solver",
  label: "Bootstrap-Solver",
  description: "先探测再解题：单独探测 agent 先摸清攻击面，再交给求解者。",
  scope: "challenge",
  agents: [
    {
      slot: "bootstrap",
      name: "Bootstrap",
      systemPrompt: "bootstrapSystem",
      tools: bootstrapTools,
      prime: true,
    },
    {
      slot: "solver",
      name: "Solver",
      entry: true,
      systemPrompt: "mainSystem",
      tools: solverTools,
    },
  ],
  templates: { bootstrapSystem: DEFAULT_BOOTSTRAP_SYSTEM_PROMPT_TEMPLATE },
  spawn: { systemPrompt: "childSystem", tools: [] },
  wire(run: RunHandle) {
    run
      .agent("bootstrap")
      .on("turnEnded", () =>
        run
          .agent("solver")
          .send("Bootstrap 探测完成，结果在 /workspace。开始解题。")
      )
  },
})

import { DEFAULT_TRIO_SYSTEM_PROMPT_TEMPLATE } from "@aegisx/shared/prompt-defaults"

import { trioTools } from "./common"
import { defineOrchestration } from "./types"

/**
 * trio — three peer solvers on one container/workspace (spec §7.4). All three
 * prime the run's initial prompt and coordinate via
 * message_agent/read_agent/list_agents. solver-a is the entry agent (run-level
 * default conversation target). Finish is racy by design: the first
 * finish_run wins the atomic teardown; the rest no-op.
 *
 * Each solver's model is configured independently in the orchestration
 * settings (`agentModels.trio.{solver-a,solver-b,solver-c}`) — the typical
 * setup uses three different models.
 */
export default defineOrchestration({
  id: "trio",
  label: "Trio",
  description: "三个并行求解者（不同模型），共享容器与工作区。",
  scope: "challenge",
  agents: [
    {
      slot: "solver-a",
      role: "solver",
      name: "Solver 1",
      entry: true,
      systemPrompt: "trioSystem",
      tools: trioTools,
      prime: true,
    },
    {
      slot: "solver-b",
      role: "solver",
      name: "Solver 2",
      systemPrompt: "trioSystem",
      tools: trioTools,
      prime: true,
    },
    {
      slot: "solver-c",
      role: "solver",
      name: "Solver 3",
      systemPrompt: "trioSystem",
      tools: trioTools,
      prime: true,
    },
  ],
  templates: { trioSystem: DEFAULT_TRIO_SYSTEM_PROMPT_TEMPLATE },
  spawn: { systemPrompt: "childSystem", tools: [] },
})

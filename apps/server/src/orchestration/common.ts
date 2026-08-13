import type { PromptContext } from "./types"

/** Target tools, granted conditionally from the challenge context
 * (target-capable → the four target tools). submit_flag is granted to every
 * solver unconditionally (spec §7.1–§7.4): a non-platform challenge records
 * the flag as locally accepted (spec §6 / flags.ts), a platform challenge
 * verifies remotely — the tool itself branches, not the grant. */
function platformTools(ctx: PromptContext): string[] {
  const tools: string[] = ["submit_flag"]
  if (ctx.run?.targetSupported) {
    tools.push("get_target", "start_target", "extend_target", "stop_target")
  }
  return tools
}

/** The classic single-solver set: finish + spawn + read, plus conditional
 * platform/target tools. Shared by classic / observer-solver / bootstrap-solver
 * so every "main solver" grants the same baseline (spec §7.1/§7.2/§7.3). */
export function solverTools(ctx: PromptContext): string[] {
  return ["finish_run", "spawn_agent", "read_agent", ...platformTools(ctx)]
}

/** Trio variant: peers coordinate via message_agent/list_agents; no spawn
 * (three parallel solvers are enough — spec §7.4). */
export function trioTools(ctx: PromptContext): string[] {
  return [
    "finish_run",
    "message_agent",
    "read_agent",
    "list_agents",
    ...platformTools(ctx),
  ]
}

/** Probe set for the bootstrap agent: platform/target tools only — no
 * finish_run (canFinish derives false) and no spawn; it hands off to the
 * solver, which owns the finish (spec §7.3). */
export function bootstrapTools(ctx: PromptContext): string[] {
  return platformTools(ctx)
}

import type { PromptContext } from "./types"

/** Target tools, granted conditionally from the challenge context
 * (target-capable → the four target tools). submit_flag is granted to every
 * solver unconditionally: a non-platform challenge records
 * the flag as locally accepted (flags.ts), a platform challenge
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
 * so every "main solver" grants the same baseline. */
export function solverTools(ctx: PromptContext): string[] {
  return ["finish_run", "spawn_agent", "read_agent", ...platformTools(ctx)]
}

/** Trio variant: peers coordinate via message_agent/list_agents; no spawn
 * (three parallel solvers are enough). */
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
 * solver, which owns the finish. */
export function bootstrapTools(ctx: PromptContext): string[] {
  return platformTools(ctx)
}

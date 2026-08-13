import type { createDatabase } from "../db"
import bootstrapSolver from "./bootstrap-solver"
import classic from "./classic"
import observerSolver from "./observer-solver"
import {
  seedBuiltinTemplates,
  seedPluginTemplates,
} from "./prompt-templates-store"
import scheduler from "./scheduler"
import trio from "./trio"
import type { OrchestrationPlugin } from "./types"

type Database = ReturnType<typeof createDatabase>["db"]

/**
 * Orchestration plugin registry. Plugins register an id + scope + setup; the
 * run service resolves a run's plugin by `runs.orchestration` and runs its
 * `setup` for both create and cold-restore (spec §4.2).
 *
 * The registry is process-global (one set of plugins per server). Registration
 * is idempotent; app boot calls {@link registerOrchestrationPlugins} once.
 */
const plugins = new Map<string, OrchestrationPlugin>()

export function registerPlugin(plugin: OrchestrationPlugin): void {
  plugins.set(plugin.id, plugin)
}

export function getPlugin(id: string): OrchestrationPlugin | undefined {
  return plugins.get(id)
}

export function requirePlugin(id: string): OrchestrationPlugin {
  const plugin = plugins.get(id)
  if (!plugin) throw new Error(`Unknown orchestration plugin: ${id}`)
  return plugin
}

export function listPlugins(): OrchestrationPlugin[] {
  return [...plugins.values()]
}

let builtinRegistered = false

/** Register the built-in orchestration plugins. Idempotent — safe to call on
 * every app boot. P1c registered `classic`; P2 adds observer-solver /
 * bootstrap-solver / trio / scheduler. */
export function registerOrchestrationPlugins(): void {
  if (builtinRegistered) return
  for (const plugin of [
    classic,
    observerSolver,
    bootstrapSolver,
    trio,
    scheduler,
  ]) {
    registerPlugin(plugin)
  }
  builtinRegistered = true
}

/** Boot orchestration for a database: register built-in plugins and seed their
 * default prompt templates (idempotent). Called from {@link createRunService}
 * construction so the service is self-sufficient (and from app boot). */
export function bootOrchestration(db: Database): void {
  registerOrchestrationPlugins()
  seedBuiltinTemplates(db)
  for (const plugin of listPlugins()) seedPluginTemplates(db, plugin)
}

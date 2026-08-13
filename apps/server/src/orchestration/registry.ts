import {
  LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
} from "@aegisx/shared/prompt-defaults"

import type { createDatabase } from "../db"
import bootstrapSolver from "./bootstrap-solver"
import classic from "./classic"
import observerSolver from "./observer-solver"
import {
  seedBuiltinTemplates,
  seedPluginTemplates,
  upgradeBuiltinTemplate,
} from "./prompt-templates-store"
import scheduler from "./scheduler"
import trio from "./trio"
import type {
  ChallengePlugin,
  OrchestrationInfo,
  OrchestrationPlugin,
} from "./types"
import { pluginNeedsModels } from "./types"

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

/** Compact catalog of challenge-scope orchestrations for the scheduler's prompt
 * (spec §3.7 `orchestrations`). Filters out the event-scope scheduler itself
 * and collapses to {id,label,description,needsModels} so the scheduler never
 * has to guess a plugin name or invent params. */
export function challengeOrchestrationCatalog(): OrchestrationInfo[] {
  return listPlugins()
    .filter((plugin): plugin is ChallengePlugin => plugin.scope === "challenge")
    .map((plugin) => ({
      id: plugin.id,
      label: plugin.label ?? plugin.id,
      description: plugin.description ?? "",
      needsModels: pluginNeedsModels(plugin.params),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
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
  // Refresh the scheduler system prompt on existing DBs that still carry the
  // pre-catalog default (adds the orchestration catalog + enqueue-first
  // guidance). User edits are preserved (upgrade skips non-matching rows).
  upgradeBuiltinTemplate(
    db,
    "orchestratorSystem",
    LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
    DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE
  )
  for (const plugin of listPlugins()) seedPluginTemplates(db, plugin)
}

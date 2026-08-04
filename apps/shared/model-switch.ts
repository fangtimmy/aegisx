import type { ThinkingLevel } from "./thinking"

/**
 * Body for a runtime model switch (run main agent + per-event orchestrator).
 *
 * `modelId` is the `ProviderModel.id` (UUID) of the new model. `thinkingLevel`
 * is optional; the SDK clamps it to the new model's supported levels. Both
 * fields are persisted by the SDK as `model_change` / `thinking_level_change`
 * session entries, so the switch is visible in the timeline.
 */
export type SwitchModelInput = {
	modelId: string
	thinkingLevel?: ThinkingLevel
}

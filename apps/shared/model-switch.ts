import type { ModelRef } from "./model-ref"

/**
 * Body for a runtime model switch (run entry agent + per-agent + event
 * orchestrator). `model` is a canonical model ref string
 * (`<providerKey>/<modelId>:<effort>` or `alias:<id>`) — the resolved provider
 * + model + effort are snapshotted onto the agent row, and the SDK model is
 * swapped on the live session. Both are persisted by the SDK as
 * `model_change` / `thinking_level_change` session entries, so the switch is
 * visible in the timeline.
 */
export type SwitchModelInput = {
  model: ModelRef
}

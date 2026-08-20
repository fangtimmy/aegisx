import type { ProviderModel } from "@/api"

export function formatContext(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(value / 1_000)}K`
}

export function formatPrice(metadata: ProviderModel["metadata"]) {
  return `$${metadata.cost.input}/M $${metadata.cost.output}/M`
}

export function formatPriceCompact(metadata: ProviderModel["metadata"]) {
  return `$${metadata.cost.input}/$${metadata.cost.output}`
}

const LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

/** Mirror of pi-ai's getSupportedThinkingLevels over plain metadata, so
 * previews render the levels a metadata JSON actually enables (non-reasoning
 * → off only; null-mapped levels are out; xhigh/max need an explicit map
 * entry). */
export function supportedLevelsOf(
  metadata: ProviderModel["metadata"]
): string[] {
  if (!metadata.reasoning) return ["off"]
  return LEVELS.filter((level) => {
    const mapped = metadata.thinkingLevelMap[level]
    if (mapped === null) return false
    if (level === "xhigh" || level === "max") return mapped !== undefined
    return true
  })
}

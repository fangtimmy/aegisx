import type { ProviderModel } from "@/api"

export function formatContext(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(value / 1_000)}K`
}

export function formatPrice(metadata: ProviderModel["metadata"]) {
  return `$${metadata.cost.input}/M $${metadata.cost.output}/M`
}

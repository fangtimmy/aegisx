import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Usage } from "@earendil-works/pi-ai"

export type UsageSummary = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number | null
}

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
})

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

export function summarizeUsage(
  messages: AgentMessage[],
  costKnown = true
): UsageSummary {
  return summarizeUsageRecords(
    messages.flatMap((message) =>
      message.role === "assistant" ? [message.usage] : []
    ),
    costKnown
  )
}

export function summarizeUsageRecords(
  usages: Array<Partial<Usage>>,
  costKnown = true
): UsageSummary {
  const total = zeroUsage()
  for (const usage of usages) {
    total.input += number(usage.input)
    total.output += number(usage.output)
    total.cacheRead += number(usage.cacheRead)
    total.cacheWrite += number(usage.cacheWrite)
    total.totalTokens += number(usage.totalTokens)
    total.cost += number(usage.cost?.total)
  }
  return {
    ...total,
    cost: costKnown ? total.cost : null,
  }
}

export function sumUsage(items: UsageSummary[]): UsageSummary {
  const total = zeroUsage()
  let unknownCost = false
  for (const item of items) {
    total.input += item.input
    total.output += item.output
    total.cacheRead += item.cacheRead
    total.cacheWrite += item.cacheWrite
    total.totalTokens += item.totalTokens
    if (item.cost === null) unknownCost = true
    else total.cost += item.cost
  }
  return { ...total, cost: unknownCost ? null : total.cost }
}

import type { SessionEntry } from "@earendil-works/pi-coding-agent"

/**
 * Token/cost accumulation shared by the live stat strip (events.ts) and the
 * persisted Overview (queries.ts). One definition of "session totals" so the
 * two never drift.
 *
 * Parity target: the pi-TUI footer (modes/interactive/components/footer.js),
 * which walks ALL `sessionManager.getEntries()` and folds in assistant +
 * toolResult message usage plus compaction AND branch-summary usage. (pi's own
 * `createUsageTotals`/`addUsageToTotals` helper is not part of the public
 * package surface — the package `exports` map blocks deep imports — so this
 * mirrors it; entry-usage.test pins the rules for upgrade cross-check.)
 *
 * `totalTokens` follows pi's `getSessionStats` formula
 * (input + output + cacheRead + cacheWrite), NOT the provider-reported
 * `usage.totalTokens` field, which can diverge across providers.
 */
export type EntryUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  totalTokens?: number
  cost?: { total?: number }
}

export type EntryUsageTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  totalTokens: number
  cost: number
}

export type SessionUsageSample = EntryUsageTotals & {
  /** Assistant messages that reported usage. */
  turns: number
  /** Latest assistant cache-hit rate (cacheRead / prompt tokens) * 100. */
  cacheHitRate: number | null
}

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Per-entry usage, or undefined when the entry carries none. Mirrors the
 * pi-TUI footer: assistant + toolResult message usage, plus compaction and
 * branch-summary usage. */
export function entryUsageOf(entry: SessionEntry): EntryUsage | undefined {
  if (entry.type === "message") {
    const message = entry.message
    if (message.role === "assistant" || message.role === "toolResult") {
      return message.usage
    }
    return undefined
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage
  }
  return undefined
}

/** Walk ALL session entries (including history compacted away, plus
 * compaction/branch-summary usage) and accumulate tokens/cost + the latest
 * assistant cache-hit rate. */
export function accumulateEntryUsage(
  entries: readonly SessionEntry[]
): SessionUsageSample {
  const totals: SessionUsageSample = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
    cacheHitRate: null,
  }
  for (const entry of entries) {
    // pi getSessionStats counts EVERY assistant message as a turn, including
    // aborted/error ones that carry no usage — count before the usage guard.
    const isAssistant =
      entry.type === "message" &&
      (entry.message as { role?: string }).role === "assistant"
    if (isAssistant) totals.turns += 1

    const usage = entryUsageOf(entry)
    if (!usage) continue
    totals.input += toNum(usage.input)
    totals.output += toNum(usage.output)
    totals.cacheRead += toNum(usage.cacheRead)
    totals.cacheWrite += toNum(usage.cacheWrite)
    // reasoning is a SUBSET of output (see pi-ai `Usage`); tracked separately
    // for the Overview breakdown only — it must NOT feed totalTokens, which
    // follows pi's getSessionStats formula (input + output + cacheRead +
    // cacheWrite) and so already includes it via output.
    totals.reasoning += toNum(usage.reasoning)
    totals.cost += toNum(usage.cost?.total)

    if (isAssistant) {
      const prompt =
        toNum(usage.input) + toNum(usage.cacheRead) + toNum(usage.cacheWrite)
      if (prompt > 0) {
        totals.cacheHitRate = (toNum(usage.cacheRead) / prompt) * 100
      }
    }
  }
  // pi getSessionStats total — not the provider-reported `usage.totalTokens`
  // field, which can diverge across providers.
  totals.totalTokens =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  return totals
}

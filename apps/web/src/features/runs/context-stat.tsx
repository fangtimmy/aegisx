import { IconTooltip } from "@/components/shell/icon-tooltip"
import { cn } from "@/lib/utils"
import { ConversationStore } from "@/stream/conversation-store"
import { useStoreValue } from "@/stream/use-store-value"

/** Format token counts for the context readout, matching the pi-TUI footer
 * rules. */
function formatStatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

type ContextSnapshot = ReturnType<ConversationStore["getContext"]>

/** Live per-agent context readout (pi-TUI footer parity):
 * ↑input ↓output RcacheRead WcacheWrite CH% $cost percent/window. */
function statParts(snapshot: NonNullable<ContextSnapshot>) {
  const t = snapshot.totals
  const parts: Array<{ label: string; tone?: "warn" | "danger" }> = []
  if (t.input) parts.push({ label: `↑${formatStatTokens(t.input)}` })
  if (t.output) parts.push({ label: `↓${formatStatTokens(t.output)}` })
  if (t.cacheRead) parts.push({ label: `R${formatStatTokens(t.cacheRead)}` })
  if (t.cacheWrite) parts.push({ label: `W${formatStatTokens(t.cacheWrite)}` })
  if (snapshot.cacheHitRate !== null && (t.cacheRead > 0 || t.cacheWrite > 0))
    parts.push({ label: `CH${snapshot.cacheHitRate.toFixed(1)}%` })
  if (t.cost > 0) parts.push({ label: `$${t.cost.toFixed(3)}` })
  const percent = snapshot.percent
  parts.push({
    label:
      percent === null
        ? `?/${formatStatTokens(snapshot.contextWindow)}`
        : `${percent.toFixed(1)}%/${formatStatTokens(snapshot.contextWindow)}`,
    tone:
      percent !== null && percent > 90
        ? "danger"
        : percent !== null && percent > 70
          ? "warn"
          : undefined,
  })
  return parts
}

const selectContext = (store: ConversationStore, agentId: string) =>
  store.getContext(agentId)

const RING_RADIUS = 5.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** Compact context meter for the composer toolbar: a small ring showing the
 * context-window fill, with the full stat readout on hover. */
export function ContextRing({
  agentId,
  stream,
}: {
  agentId: string
  stream: ConversationStore
}) {
  const snapshot = useStoreValue(stream, agentId, selectContext)
  if (!snapshot) return null
  const percent = snapshot.percent
  const tone =
    percent !== null && percent > 90
      ? "danger"
      : percent !== null && percent > 70
        ? "warn"
        : undefined
  return (
    <span
      aria-label={`上下文占用 ${percent === null ? "未知" : `${Math.round(percent)}%`}`}
      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
    >
      <IconTooltip
        label={statParts(snapshot)
          .map((part) => part.label)
          .join("  ")}
      >
        <svg aria-hidden="true" className="size-3.5" viewBox="0 0 14 14">
          <circle
            className="fill-none stroke-input"
            cx="7"
            cy="7"
            r={RING_RADIUS}
            strokeWidth="2"
          />
          <circle
            className={cn(
              "fill-none transition-[stroke-dashoffset] duration-500",
              tone === "danger"
                ? "stroke-destructive"
                : tone === "warn"
                  ? "stroke-warning"
                  : "stroke-primary"
            )}
            cx="7"
            cy="7"
            r={RING_RADIUS}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - (percent ?? 0) / 100)}
            strokeLinecap="round"
            strokeWidth="2"
            transform="rotate(-90 7 7)"
          />
        </svg>
      </IconTooltip>
      <span
        className={cn(
          tone === "danger" && "text-destructive",
          tone === "warn" && "text-warning"
        )}
      >
        {percent === null ? "?" : Math.round(percent)}%
      </span>
    </span>
  )
}

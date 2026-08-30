import { formatSize } from "@aegisx/shared"
import type { ChannelFileMeta } from "@aegisx/shared/channels"

import { DEFAULT_CHANNEL_DELIVERY_TEMPLATE } from "../orchestration/prompt-defaults"
import {
  type DeliveryRenderContext,
  renderTemplateBody,
} from "../orchestration/prompt-templates"

/** Deliver merged-text cap (characters); overflow folds to a catch-up line. */
export const MAX_DELIVER_CHARS = 8_000

export type RenderGroup = {
  label: string
  messages: Array<{
    authorName: string
    createdAt: string
    body: string
    urgent: boolean
    files: ChannelFileMeta[]
  }>
}

function timeOf(iso: string): string {
  const date = new Date(iso)
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

function deliveryCtx(
  messages: DeliveryRenderContext["messages"],
  dropped: number
): DeliveryRenderContext {
  return { dropped, messages }
}

/** Render the merged delivery text via the channelDelivery template:
 * per-message header lines (⚠ prefix on urgent) + 📎 lines carrying the
 * shared-relative path; 8K cap with oldest-message folding. The folding
 * math stays in code (per-message size measured through the SAME template,
 * so a custom template folds accurately). Attachment CONTENT never enters
 * the text — readers open the shared path directly. */
export function renderDelivery(
  body: string,
  groups: RenderGroup[],
  maxChars: number
): string {
  const messages: DeliveryRenderContext["messages"] = groups.flatMap((group) =>
    group.messages.map((message) => ({
      urgent: message.urgent,
      label: group.label,
      authorName: message.authorName,
      time: timeOf(message.createdAt),
      body: message.body.trim() || "(空)",
      files: message.files.map((file) => ({
        filename: file.filename,
        size: formatSize(file.size),
        path: file.path,
      })),
    }))
  )
  const render = (c: DeliveryRenderContext) => renderTemplateBody(body, c)
  const plain = render(deliveryCtx(messages, 0))
  if (plain.length <= maxChars) return plain
  // Over budget: keep the NEWEST messages that fit; fold the dropped count.
  // Fixed prefix (header lines) measured through the same template so a
  // custom template budgets against its own prefix.
  const prefixLen = render(deliveryCtx([], 0)).length
  const budget = maxChars - prefixLen - 120
  let used = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const size = render(deliveryCtx([messages[i]], 0)).length - prefixLen
    if (used + size > budget) break
    used += size
    start = i
  }
  return render(deliveryCtx(messages.slice(start), start))
}

/** Default-template render (the pure/exported face — same output the
 * service produces with unedited builtin rows). */
export function renderMerged(groups: RenderGroup[]): string {
  return renderDelivery(
    DEFAULT_CHANNEL_DELIVERY_TEMPLATE,
    groups,
    MAX_DELIVER_CHARS
  )
}

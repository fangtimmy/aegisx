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
    /** Channel-message id — the delivery cursor advances to the last
     * DELIVERED id per group (the engine reads it back from the render). */
    id: number
    authorName: string
    createdAt: string
    body: string
    urgent: boolean
    files: ChannelFileMeta[]
  }>
}

/** A render plus, per group, the id of the last message it actually
 * delivered (null = nothing from that group made the cut). */
export type RenderedDelivery = { text: string; lastIds: Array<number | null> }

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function timeOf(iso: string): string {
  const date = new Date(iso)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Wall-clock stamp for delivery headers (`YYYY-MM-DD HH:MM`, local). Every
 * wake carries one so the reader can place itself in time without inferring
 * "now" from the newest message. */
export function fmtClock(at: number): string {
  const date = new Date(at)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/** Render the merged delivery text via the channelDelivery template:
 * per-message header lines (⚠ prefix on urgent) + 📎 lines carrying the
 * shared-relative path; 8K cap with NEWEST-message folding. The folding
 * math stays in code (per-message size measured through the SAME template,
 * so a custom template folds accurately). Attachment CONTENT never enters
 * the text — readers open the shared path directly.
 *
 * Over budget, the OLDEST messages win: the earliest findings on a channel
 * are its ground truth (entry points, credentials) and the common overflow
 * case is a fresh agent's onboarding sweep of the whole history. The
 * newer overflow folds to a count line and stays unread — the next flush
 * delivers it (the cursor only advances past what was rendered). At least
 * one message is always delivered so the cursor never stalls. */
export function renderDelivery(
  body: string,
  groups: RenderGroup[],
  maxChars: number,
  nowMs: number = Date.now()
): RenderedDelivery {
  const messages = groups.flatMap((group, groupIndex) =>
    group.messages.map((message) => ({
      group,
      groupIndex,
      id: message.id,
      urgent: message.urgent,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt,
      files: message.files,
    }))
  )
  const toCtx = (
    list: typeof messages,
    dropped: number
  ): DeliveryRenderContext => ({
    now: fmtClock(nowMs),
    dropped,
    messages: list.map((message) => ({
      urgent: message.urgent,
      label: message.group.label,
      authorName: message.authorName,
      time: timeOf(message.createdAt),
      body: message.body.trim() || "(空)",
      files: message.files.map((file) => ({
        filename: file.filename,
        size: formatSize(file.size),
        path: file.path,
      })),
    })),
  })
  const lastIdsOf = (kept: number): Array<number | null> => {
    const lastIds: Array<number | null> = groups.map(() => null)
    for (let i = 0; i < kept; i += 1) {
      lastIds[messages[i].groupIndex] = messages[i].id
    }
    return lastIds
  }
  const render = (c: DeliveryRenderContext) => renderTemplateBody(body, c)
  const plain = render(toCtx(messages, 0))
  if (plain.length <= maxChars) {
    return { text: plain, lastIds: lastIdsOf(messages.length) }
  }
  // Fixed prefix (header lines) measured through the same template so a
  // custom template budgets against its own prefix.
  const prefixLen = render(toCtx([], 0)).length
  const budget = maxChars - prefixLen - 120
  let used = 0
  let kept = 0
  for (const message of messages) {
    const size = render(toCtx([message], 0)).length - prefixLen
    if (used + size > budget) break
    used += size
    kept += 1
  }
  if (kept === 0 && messages.length > 0) kept = 1
  return {
    text: render(toCtx(messages.slice(0, kept), messages.length - kept)),
    lastIds: lastIdsOf(kept),
  }
}

/** Default-template render (the pure/exported face — same output the
 * service produces with unedited builtin rows). */
export function renderMerged(groups: RenderGroup[]): string {
  return renderDelivery(
    DEFAULT_CHANNEL_DELIVERY_TEMPLATE,
    groups,
    MAX_DELIVER_CHARS
  ).text
}

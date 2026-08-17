import { apiRequest } from "./client"
import type { ChannelInfo, ChannelMessageList } from "./types"

/** A run's channel tree (#announce / #team / DM per solver) — the IM view's
 * left rail. Unread is CLIENT-side session state (design §5.2): the server's
 * per-agent cursors are the functional state for agents, not the UI. */
export function getRunChannels(runId: string) {
  return apiRequest<{ items: ChannelInfo[] }>(`/runs/${runId}/channels`)
}

/** A challenge's group channels (#team / #announce) — the challenge-level
 * IM view (v17 knowledge base; get-or-create server-side, works with no
 * run on the challenge). */
export function getChallengeChannels(challengeId: string) {
  return apiRequest<{ items: ChannelInfo[] }>(
    `/challenges/${challengeId}/channels`
  )
}

/** Channel timeline, paginated by the global message-id cursor. */
export function listChannelMessages(channelId: string, after = 0, limit = 100) {
  const params = new URLSearchParams()
  if (after > 0) params.set("after", String(after))
  if (limit !== 100) params.set("limit", String(limit))
  const query = params.toString() ? `?${params.toString()}` : ""
  return apiRequest<ChannelMessageList>(
    `/channels/${channelId}/messages${query}`
  )
}

/** User post (multipart: text + files[]) — same ledger + delivery policy as
 * SDK/system posts (发 #team = steer 全部 live 成员；发调度者 DM = 立即 flush)。 */
export function postChannelMessage(
  channelId: string,
  input: { text: string; files?: File[] }
) {
  const form = new FormData()
  form.set("text", input.text)
  for (const file of input.files ?? []) form.append("files", file)
  return fetch(`/api/channels/${channelId}/messages`, {
    method: "POST",
    body: form,
  }).then(async (response) => {
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`
      try {
        const body = (await response.json()) as {
          error?: { message?: string }
        }
        if (body.error?.message) message = body.error.message
      } catch {
        // keep the HTTP status text
      }
      throw new Error(message)
    }
    return response.json()
  })
}

/** Attachment download / preview URL. */
export function channelFileUrl(fileId: string) {
  return `/api/channel-files/${fileId}`
}

import { apiRequest } from "./client"
import type {
  ChannelMessageList,
  ChannelMessagePublic,
  ChannelPublic,
} from "./types"

/** The challenge's channel tree: #team + one DM per agent that ever attacked
 * the challenge (the IM view's left rail). Unread is CLIENT-side session
 * state: the server's per-agent cursors are the functional state for
 * agents, not the UI. */
export function getChallengeChannels(challengeId: string) {
  return apiRequest<{ items: ChannelPublic[] }>(
    `/challenges/${challengeId}/channels`
  )
}

/** SDK channels.list: the agent's visible channels + unread counts. */
export function getAgentChannels(agentId: string) {
  return apiRequest<{ items: ChannelPublic[] }>(`/agents/${agentId}/channels`)
}

/** Channel timeline. Forward: `after` is the global message-id cursor — 0
 * returns the latest window. Backward: `before` pages history older than a
 * message id. `channelKey` is a derived key (`team:<cid>` / `dm:<aid>` /
 * `orch:<eid>`) — ':' is a legal path character. */
export function listChannelMessages(
  channelKey: string,
  after = 0,
  limit = 100,
  before?: number
) {
  const params = new URLSearchParams()
  if (after > 0) params.set("after", String(after))
  if (limit !== 100) params.set("limit", String(limit))
  if (before !== undefined && before > 0) params.set("before", String(before))
  const query = params.toString() ? `?${params.toString()}` : ""
  return apiRequest<ChannelMessageList>(
    `/channels/${channelKey}/messages${query}`
  )
}

/** User post (multipart: text + files[] + urgent) — same ledger + delivery
 * policy as SDK/system posts. `urgent` defaults on (a user IM post is rare
 * and intended → immediate delivery); off defers to the flush tick. */
export function postChannelMessage(
  channelKey: string,
  input: { text: string; files?: File[]; urgent?: boolean }
) {
  const form = new FormData()
  form.set("text", input.text)
  form.set("urgent", String(input.urgent ?? true))
  for (const file of input.files ?? []) form.append("files", file)
  return fetch(`/api/channels/${channelKey}/messages`, {
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
    return response.json() as Promise<ChannelMessagePublic>
  })
}

import { apiRequest } from "./client"
import type {
  ChannelMessageList,
  ChannelMessagePublic,
  ChannelPublic,
} from "./types"

/** A run's channel tree (#team + one DM per solver) — the IM view's left
 * rail. Unread is CLIENT-side session state: the server's per-agent
 * cursors are the functional state for agents, not the UI. */
export function getRunChannels(runId: string) {
  return apiRequest<{ items: ChannelPublic[] }>(`/runs/${runId}/channels`)
}

/** The challenge's #team (exactly one channel — the challenge-level IM
 * view, works with no run on the challenge). */
export function getChallengeChannels(challengeId: string) {
  return apiRequest<{ items: ChannelPublic[] }>(
    `/challenges/${challengeId}/channels`
  )
}

/** Channel timeline, paginated by the global message-id cursor. `channelKey`
 * is a derived key (`team:<cid>` / `dm:<aid>` / `orch:<eid>`) — ':' is a
 * legal path character. */
export function listChannelMessages(
  channelKey: string,
  after = 0,
  limit = 100
) {
  const params = new URLSearchParams()
  if (after > 0) params.set("after", String(after))
  if (limit !== 100) params.set("limit", String(limit))
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

/** Attachment download / preview URL. */
export function channelFileUrl(fileId: string) {
  return `/api/channel-files/${fileId}`
}

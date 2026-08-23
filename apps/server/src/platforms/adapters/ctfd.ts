import {
  BaseAdapter,
  type JsonRecord,
  jsonText,
  nullableNumber,
  nullableString,
  type PlatformConfig,
  type PlatformRequestError,
  type RemoteChallengeSummary,
  type SubmissionResult,
} from "../core"

/** Hard cap on paginated listings; a platform returning a bad pagination
 * payload must not spin the loop forever. */
const MAX_PAGES = 50

export class CtfdAdapter extends BaseAdapter {
  constructor(
    config: PlatformConfig,
    onError?: (info: PlatformRequestError) => void,
    timeoutMs?: number
  ) {
    super(
      config,
      {
        Authorization: `Token ${config.credential}`,
        "Content-Type": "application/json",
      },
      undefined,
      onError,
      timeoutMs
    )
  }

  async testConnection() {
    await this.http.json<unknown>("/api/v1/users/me")
  }

  async listEvents() {
    await this.listChallenges()
    return [{ id: "site", name: new URL(this.config.baseUrl).hostname }]
  }

  async listChallenges() {
    const items: RemoteChallengeSummary[] = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.http.json<{
        data?: JsonRecord[]
        meta?: { pagination?: { pages?: number; next?: number | null } }
      }>(`/api/v1/challenges?page=${page}&per_page=100`)
      items.push(
        ...(body.data ?? []).map((challenge) => ({
          id: String(challenge.id),
          name: jsonText(
            challenge.name ?? `Challenge ${jsonText(challenge.id)}`
          ),
          category: nullableString(challenge.category),
          points: nullableNumber(challenge.value),
          solved: challenge.solved_by_me === true,
        }))
      )
      const pagination = body.meta?.pagination
      if (
        !pagination ||
        (!pagination.next && page >= (pagination.pages ?? page))
      )
        return items
    }
    return items
  }

  async getChallenge(remoteId: string) {
    const body = await this.http.json<{ data: JsonRecord }>(
      `/api/v1/challenges/${encodeURIComponent(remoteId)}`
    )
    const value = body.data
    const files = Array.isArray(value.files) ? value.files : []
    return {
      id: String(value.id),
      name: jsonText(value.name ?? "Untitled challenge"),
      description: jsonText(value.description ?? ""),
      category: nullableString(value.category),
      points: nullableNumber(value.value),
      solved: value.solved_by_me === true,
      targetSupported: false,
      targetCount: 0,
      targets: [],
      attachments: files.flatMap((file) => {
        if (typeof file !== "string") return []
        const path = new URL(file, `${this.config.baseUrl}/`)
        const rawName = path.pathname.split("/").pop() ?? "attachment"
        let filename = rawName
        try {
          filename = decodeURIComponent(rawName) || "attachment"
        } catch {
          // Malformed percent-encoding; keep the raw segment.
        }
        return [
          {
            id: path.toString(),
            filename,
            url: path.toString(),
          },
        ]
      }),
    }
  }

  async getSolveState(remoteId: string): Promise<boolean> {
    const body = await this.http.json<{ data: JsonRecord }>(
      `/api/v1/challenges/${encodeURIComponent(remoteId)}`
    )
    return body.data?.solved_by_me === true
  }

  async submitFlag(
    remoteId: string,
    flag: string,
    signal?: AbortSignal
  ): Promise<SubmissionResult> {
    const body = await this.http.json<{
      data?: { status?: string; message?: string }
    }>("/api/v1/challenges/attempt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: remoteId, submission: flag }),
      signal,
    })
    const statuses: Record<string, SubmissionResult["status"]> = {
      correct: "accepted",
      incorrect: "rejected",
      partial: "partial",
      already_solved: "already_solved",
      ratelimited: "rate_limited",
      paused: "error",
      authentication_required: "error",
    }
    return {
      status: statuses[body.data?.status ?? ""] ?? "error",
      message: body.data?.message,
    }
  }
}

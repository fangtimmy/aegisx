import {
  absentTarget,
  BaseAdapter,
  isRecord,
  type JsonRecord,
  nullableNumber,
  nullableString,
  type PlatformConfig,
  PlatformError,
  type PlatformRequestError,
  type SubmissionResult,
  targetDefinitions,
  targetEndpoint,
} from "../core"

export class A1CtfAdapter extends BaseAdapter {
  constructor(
    config: PlatformConfig,
    onError?: (info: PlatformRequestError) => void,
    timeoutMs?: number
  ) {
    super(
      config,
      { Cookie: `a1token=${config.credential}` },
      undefined,
      onError,
      timeoutMs
    )
  }

  async testConnection() {
    await this.http.json<unknown>("/api/account/profile")
  }

  async listEvents() {
    const body = await this.http.json<{ data?: JsonRecord[] }>("/api/game/list")
    return (body.data ?? []).map((game) => ({
      id: String(game.game_id),
      name: String(game.name ?? `Game ${game.game_id}`),
    }))
  }

  async listChallenges() {
    const body = await this.http.json<{
      data?: { challenges?: JsonRecord[]; solved_challenges?: JsonRecord[] }
    }>(`/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenges`)
    const solved = new Set(
      (body.data?.solved_challenges ?? []).map((challenge) =>
        String(challenge.challenge_id)
      )
    )
    return (body.data?.challenges ?? []).map((challenge) => {
      const id = String(challenge.challenge_id)
      return {
        id,
        name: String(
          challenge.challenge_name ?? challenge.name ?? `Challenge ${id}`
        ),
        category: nullableString(challenge.category),
        points: nullableNumber(challenge.cur_score ?? challenge.score),
        solved: solved.has(id),
      }
    })
  }

  async getChallenge(remoteId: string) {
    const body = await this.http.json<{ data: JsonRecord }>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenge/${encodeURIComponent(remoteId)}`
    )
    const value = body.data
    const attachments = Array.isArray(value.attachments)
      ? value.attachments.filter(isRecord)
      : []
    const targets = targetDefinitions(value.containers)
    const containerType = String(value.container_type ?? "")
    const hasTarget =
      targets.length > 0 ||
      !["", "NO_CONTAINER", "NoContainer"].includes(containerType)
    if (hasTarget && targets.length === 0) {
      targets.push({ name: "Challenge target", services: [] })
    }
    return {
      id: String(value.challenge_id),
      name: String(value.challenge_name ?? "Untitled challenge"),
      description: String(value.description ?? ""),
      category: nullableString(value.category),
      points: nullableNumber(value.cur_score),
      solved: false,
      targetSupported: hasTarget,
      targetCount: targets.length,
      targets,
      attachments: attachments.flatMap((attachment) => {
        const type = String(attachment.attach_type ?? "")
        const hash = nullableString(attachment.attach_hash)
        const remoteUrl = nullableString(attachment.attach_url)
        const url =
          type === "STATICFILE" && hash
            ? `/api/file/download/${encodeURIComponent(hash)}`
            : remoteUrl
        if (!url) return []
        return [
          {
            id: `${type}:${hash ?? url}`,
            filename: String(attachment.attach_name ?? "attachment"),
            url,
            authenticated:
              type !== "REMOTEFILE" ||
              new URL(url, `${this.config.baseUrl}/`).origin ===
                this.http.origin,
          },
        ]
      }),
    }
  }

  async submitFlag(
    remoteId: string,
    flag: string,
    signal?: AbortSignal
  ): Promise<SubmissionResult> {
    const body = await this.http.json<{ data?: { judge_id?: string } }>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/flag/${encodeURIComponent(remoteId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag }),
        signal,
      }
    )
    const remoteIdValue = body.data?.judge_id
    return remoteIdValue
      ? { status: "pending", remoteId: remoteIdValue }
      : { status: "error", message: "Platform did not return a judge ID" }
  }

  async getSubmission(
    _remoteId: string,
    submissionId: string,
    signal?: AbortSignal
  ) {
    const body = await this.http.json<{
      data?: { judge_status?: string }
    }>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/flag/${encodeURIComponent(submissionId)}`,
      { signal }
    )
    const statuses: Record<string, SubmissionResult["status"]> = {
      JudgeQueueing: "pending",
      JudgeRunning: "pending",
      JudgeAC: "accepted",
      JudgeWA: "rejected",
      JudgeError: "error",
      JudgeTimeout: "error",
    }
    return {
      status: statuses[body.data?.judge_status ?? ""] ?? "error",
      remoteId: submissionId,
      message: body.data?.judge_status,
    }
  }

  async getTarget(remoteId: string, signal?: AbortSignal) {
    try {
      const body = await this.http.json<{ data: JsonRecord }>(
        `/api/game/${encodeURIComponent(this.config.remoteEventId)}/container/${encodeURIComponent(remoteId)}`,
        { signal }
      )
      const value = body.data
      const statuses = {
        ContainerRunning: "running",
        ContainerStarting: "starting",
        ContainerQueueing: "starting",
        ContainerStopping: "stopping",
        ContainerStopped: "absent",
        NoContainer: "absent",
        ContainerError: "failed",
      } as const
      const containers = Array.isArray(value.containers)
        ? value.containers.filter(isRecord)
        : []
      return {
        status:
          statuses[String(value.container_status) as keyof typeof statuses] ??
          "failed",
        endpoints: containers.flatMap((container) => {
          const ports = Array.isArray(container.container_ports)
            ? container.container_ports.filter(isRecord)
            : []
          return ports.flatMap((port) => {
            if (typeof port.ip !== "string" || typeof port.port !== "number")
              return []
            return [
              targetEndpoint(
                String(port.port_name ?? container.container_name ?? "service"),
                `${port.ip}:${port.port}`
              ),
            ]
          })
        }),
        expiresAt: nullableString(
          value.container_expiretime ?? value.container_expire_time
        ),
      }
    } catch (error) {
      if (
        error instanceof PlatformError &&
        [400, 404].includes(error.status ?? 0)
      ) {
        return absentTarget()
      }
      throw error
    }
  }

  async targetAction(
    remoteId: string,
    method: "POST" | "PATCH" | "DELETE",
    signal?: AbortSignal
  ) {
    await this.http.request(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/container/${encodeURIComponent(remoteId)}`,
      { method, signal }
    )
    return this.getTarget(remoteId, signal)
  }

  startTarget(remoteId: string, signal?: AbortSignal) {
    return this.targetAction(remoteId, "POST", signal)
  }

  extendTarget(remoteId: string, signal?: AbortSignal) {
    return this.targetAction(remoteId, "PATCH", signal)
  }

  stopTarget(remoteId: string, signal?: AbortSignal) {
    return this.targetAction(remoteId, "DELETE", signal)
  }
}

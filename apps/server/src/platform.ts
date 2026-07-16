export type PlatformType = "ctfd" | "ret2shell" | "a1ctf"

export type PlatformConfig = {
  type: PlatformType
  baseUrl: string
  credential: string
  remoteEventId: string
}

export type RemoteEvent = { id: string; name: string }

export type RemoteAttachment = {
  id: string
  filename: string
  url: string
  authenticated?: boolean
}

export type RemoteChallengeSummary = {
  id: string
  name: string
  category: string | null
  points: number | null
  solved: boolean
}

export type RemoteTargetInfo = {
  name: string
  services: string[]
}

export type RemoteChallenge = RemoteChallengeSummary & {
  description: string
  targetSupported: boolean
  targetCount: number
  targets: RemoteTargetInfo[]
  attachments: RemoteAttachment[]
}

export type TargetState = {
  status: "absent" | "starting" | "running" | "stopping" | "failed"
  endpoints: Array<{
    name: string
    address: string
    protocol: "http" | "https" | "tcp" | "udp"
  }>
  expiresAt: string | null
  message?: string
}

export type SubmissionResult = {
  status:
    | "pending"
    | "accepted"
    | "rejected"
    | "partial"
    | "already_solved"
    | "rate_limited"
    | "error"
  remoteId?: string
  message?: string
}

export interface CtfPlatformAdapter {
  listEvents(): Promise<RemoteEvent[]>
  listChallenges(): Promise<RemoteChallengeSummary[]>
  getChallenge(remoteId: string): Promise<RemoteChallenge>
  downloadAttachment(attachment: RemoteAttachment): Promise<Response>
  submitFlag(remoteId: string, flag: string): Promise<SubmissionResult>
  getSubmission?(
    remoteId: string,
    submissionId: string
  ): Promise<SubmissionResult>
  getTarget?(remoteId: string): Promise<TargetState>
  startTarget?(remoteId: string): Promise<TargetState>
  extendTarget?(remoteId: string): Promise<TargetState>
  stopTarget?(remoteId: string): Promise<TargetState>
}

type JsonRecord = Record<string, unknown>

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

class PlatformHttp {
  readonly origin: string

  constructor(
    baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly onResponse?: (response: Response) => void
  ) {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PlatformError("Platform URL must use HTTP or HTTPS")
    }
    this.origin = url.origin
    this.baseUrl = url.toString().replace(/\/$/, "")
  }

  private readonly baseUrl: string

  async request(path: string, init: RequestInit = {}, authenticated = true) {
    const url = new URL(path, `${this.baseUrl}/`)
    const sameOrigin = url.origin === this.origin
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(authenticated && sameOrigin ? this.headers : {}),
        ...init.headers,
      },
      redirect: "follow",
      signal: init.signal ?? AbortSignal.timeout(30_000),
    })
    this.onResponse?.(response)
    if (!response.ok) {
      let message = `Platform request failed (${response.status})`
      try {
        const body = (await response.clone().json()) as JsonRecord
        message = String(
          body.message ??
            body.detail ??
            (isRecord(body.error) ? body.error.message : body.error) ??
            message
        )
      } catch {
        // Keep the HTTP status when the platform does not return JSON.
      }
      throw new PlatformError(message, response.status)
    }
    return response
  }

  async json<T>(path: string, init: RequestInit = {}) {
    return (await this.request(path, init)).json() as Promise<T>
  }
}

abstract class BaseAdapter implements CtfPlatformAdapter {
  protected readonly http: PlatformHttp

  constructor(
    protected readonly config: PlatformConfig,
    headers: Record<string, string>,
    onResponse?: (response: Response) => void
  ) {
    this.http = new PlatformHttp(config.baseUrl, headers, onResponse)
  }

  abstract listEvents(): Promise<RemoteEvent[]>
  abstract listChallenges(): Promise<RemoteChallengeSummary[]>
  abstract getChallenge(remoteId: string): Promise<RemoteChallenge>
  abstract submitFlag(remoteId: string, flag: string): Promise<SubmissionResult>

  downloadAttachment(attachment: RemoteAttachment) {
    return this.http.request(
      attachment.url,
      { headers: { Accept: "application/octet-stream" } },
      attachment.authenticated !== false
    )
  }
}

class CtfdAdapter extends BaseAdapter {
  constructor(config: PlatformConfig) {
    super(config, {
      Authorization: `Token ${config.credential}`,
      "Content-Type": "application/json",
    })
  }

  async listEvents() {
    await this.http.json("/api/v1/challenges")
    return [{ id: "site", name: new URL(this.config.baseUrl).hostname }]
  }

  async listChallenges() {
    const body = await this.http.json<{ data?: JsonRecord[] }>(
      "/api/v1/challenges"
    )
    return (body.data ?? []).map((challenge) => ({
      id: String(challenge.id),
      name: String(challenge.name ?? `Challenge ${challenge.id}`),
      category: nullableString(challenge.category),
      points: nullableNumber(challenge.value),
      solved: challenge.solved_by_me === true,
    }))
  }

  async getChallenge(remoteId: string) {
    const body = await this.http.json<{ data: JsonRecord }>(
      `/api/v1/challenges/${encodeURIComponent(remoteId)}`
    )
    const value = body.data
    const files = Array.isArray(value.files) ? value.files : []
    return {
      id: String(value.id),
      name: String(value.name ?? "Untitled challenge"),
      description: String(value.description ?? ""),
      category: nullableString(value.category),
      points: nullableNumber(value.value),
      solved: value.solved_by_me === true,
      targetSupported: false,
      targetCount: 0,
      targets: [],
      attachments: files.flatMap((file) => {
        if (typeof file !== "string") return []
        const path = new URL(file, `${this.config.baseUrl}/`)
        return [
          {
            id: path.toString(),
            filename:
              decodeURIComponent(
                path.pathname.split("/").pop() ?? "attachment"
              ) || "attachment",
            url: path.toString(),
          },
        ]
      }),
    }
  }

  async submitFlag(remoteId: string, flag: string): Promise<SubmissionResult> {
    const body = await this.http.json<{
      data?: { status?: string; message?: string }
    }>("/api/v1/challenges/attempt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: remoteId, submission: flag }),
    })
    const status = body.data?.status
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
      status: statuses[status ?? ""] ?? "error",
      message: body.data?.message,
    }
  }
}

class Ret2ShellAdapter extends BaseAdapter {
  constructor(
    config: PlatformConfig,
    onCredential?: (credential: string) => void
  ) {
    super(
      config,
      { Authorization: `Bearer ${config.credential}` },
      (response) => {
        const token = response.headers.get("Set-Token")
        if (token) onCredential?.(token)
      }
    )
  }

  async listEvents() {
    const body = await this.http.json<[JsonRecord[], number]>(
      "/api/game?page=1&page_size=100"
    )
    return body[0].map((game) => ({
      id: String(game.id),
      name: String(game.name ?? `Game ${game.id}`),
    }))
  }

  async listChallenges() {
    const body = await this.http.json<[JsonRecord[], number]>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenge?page=1&page_size=1000`
    )
    return body[0].map((challenge) => ({
      id: String(challenge.id),
      name: String(challenge.name ?? `Challenge ${challenge.id}`),
      category: challengeCategory(challenge),
      points: nullableNumber(challenge.score),
      solved: challenge.solved === true,
    }))
  }

  async getChallenge(remoteId: string) {
    const root = `/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenge/${encodeURIComponent(remoteId)}`
    const [value, files, environment, solve] = await Promise.all([
      this.http.json<JsonRecord>(root),
      this.http.json<Array<{ folder: string; file: string }>>(`${root}/file`),
      this.http.json<JsonRecord | null>(`${root}/env`),
      this.http.json<JsonRecord>(`${root}/submit`),
    ])
    const targets = targetDefinitions(environment?.images)
    return {
      id: String(value.id),
      name: String(value.name ?? "Untitled challenge"),
      description: String(value.content ?? ""),
      category: challengeCategory(value),
      points: nullableNumber(value.score),
      solved: solve.solved === true,
      targetSupported: targets.length > 0,
      targetCount: targets.length,
      targets,
      attachments: files.map(({ folder, file }) => ({
        id: `${folder}:${file}`,
        filename: file,
        url: `${root}/file?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`,
      })),
    }
  }

  async submitFlag(remoteId: string, flag: string) {
    const root = `/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenge/${encodeURIComponent(remoteId)}/submit`
    const value = await this.http.json<JsonRecord>(root, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: flag }),
    })
    return ret2Submission(value)
  }

  async getSubmission(remoteId: string, submissionId: string) {
    const value = await this.http.json<JsonRecord>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenge/${encodeURIComponent(remoteId)}/submit?id=${encodeURIComponent(submissionId)}`
    )
    return ret2Submission(value)
  }

  async getTarget(remoteId: string) {
    const values = await this.http.json<JsonRecord[]>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/instance`
    )
    const value = values.find(
      (instance) => String(instance.challenge_id) === remoteId
    )
    if (!value) return absentTarget()
    const state = String(value.state ?? "Unknown")
    const endpoints = Array.isArray(value.exposed_ports)
      ? value.exposed_ports.flatMap((endpoint) => {
          if (!isRecord(endpoint) || typeof endpoint.address !== "string")
            return []
          return [
            targetEndpoint(
              String(endpoint.name ?? "service"),
              endpoint.address
            ),
          ]
        })
      : []
    return {
      status:
        state === "Running"
          ? ("running" as const)
          : state === "Pending"
            ? ("starting" as const)
            : ("failed" as const),
      endpoints,
      expiresAt: null,
    }
  }

  async targetAction(remoteId: string, method: "POST" | "PATCH" | "DELETE") {
    await this.http.request(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenge/${encodeURIComponent(remoteId)}/instance`,
      { method }
    )
    return this.getTarget(remoteId)
  }

  startTarget(remoteId: string) {
    return this.targetAction(remoteId, "POST")
  }

  extendTarget(remoteId: string) {
    return this.targetAction(remoteId, "PATCH")
  }

  stopTarget(remoteId: string) {
    return this.targetAction(remoteId, "DELETE")
  }
}

class A1CtfAdapter extends BaseAdapter {
  constructor(config: PlatformConfig) {
    super(config, { Cookie: `a1token=${config.credential}` })
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

  async submitFlag(remoteId: string, flag: string): Promise<SubmissionResult> {
    const body = await this.http.json<{
      data?: { judge_id?: string }
    }>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/flag/${encodeURIComponent(remoteId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag }),
      }
    )
    const remoteIdValue = body.data?.judge_id
    return remoteIdValue
      ? { status: "pending", remoteId: remoteIdValue }
      : { status: "error", message: "Platform did not return a judge ID" }
  }

  async getSubmission(_remoteId: string, submissionId: string) {
    const body = await this.http.json<{
      data?: { judge_status?: string }
    }>(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/flag/${encodeURIComponent(submissionId)}`
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

  async getTarget(remoteId: string) {
    try {
      const body = await this.http.json<{ data: JsonRecord }>(
        `/api/game/${encodeURIComponent(this.config.remoteEventId)}/container/${encodeURIComponent(remoteId)}`
      )
      const value = body.data
      const statuses: Record<string, TargetState["status"]> = {
        ContainerRunning: "running",
        ContainerStarting: "starting",
        ContainerQueueing: "starting",
        ContainerStopping: "stopping",
        ContainerStopped: "absent",
        NoContainer: "absent",
        ContainerError: "failed",
      }
      const containers = Array.isArray(value.containers)
        ? value.containers.filter(isRecord)
        : []
      return {
        status: statuses[String(value.container_status)] ?? "failed",
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

  async targetAction(remoteId: string, method: "POST" | "PATCH" | "DELETE") {
    await this.http.request(
      `/api/game/${encodeURIComponent(this.config.remoteEventId)}/container/${encodeURIComponent(remoteId)}`,
      { method }
    )
    return this.getTarget(remoteId)
  }

  startTarget(remoteId: string) {
    return this.targetAction(remoteId, "POST")
  }

  extendTarget(remoteId: string) {
    return this.targetAction(remoteId, "PATCH")
  }

  stopTarget(remoteId: string) {
    return this.targetAction(remoteId, "DELETE")
  }
}

export function createPlatformAdapter(
  config: PlatformConfig,
  onCredential?: (credential: string) => void
): CtfPlatformAdapter {
  if (config.type === "ctfd") return new CtfdAdapter(config)
  if (config.type === "ret2shell") {
    return new Ret2ShellAdapter(config, onCredential)
  }
  return new A1CtfAdapter(config)
}

function ret2Submission(value: JsonRecord): SubmissionResult {
  const id = value.id === undefined ? undefined : String(value.id)
  if (value.solved === null || value.solved === undefined) {
    return { status: "pending", remoteId: id }
  }
  return {
    status: value.solved === true ? "accepted" : "rejected",
    remoteId: id,
    message: nullableString(value.result) ?? undefined,
  }
}

function absentTarget(): TargetState {
  return { status: "absent", endpoints: [], expiresAt: null }
}

function targetEndpoint(name: string, address: string) {
  const lower = address.toLowerCase()
  const protocol = lower.startsWith("https://")
    ? ("https" as const)
    : lower.startsWith("http://")
      ? ("http" as const)
      : ("tcp" as const)
  return { name, address, protocol }
}

function challengeCategory(value: JsonRecord) {
  const tags = Array.isArray(value.tag) ? value.tag : []
  const primary = tags.find((tag) => isRecord(tag) && tag.primary === true) as
    | JsonRecord
    | undefined
  return nullableString(primary?.name ?? tags.find(isRecord)?.name)
}

function targetDefinitions(value: unknown): RemoteTargetInfo[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (!isRecord(item)) {
      return { name: String(item || `Target ${index + 1}`), services: [] }
    }
    const rawServices = item.container_ports ?? item.exposed_ports ?? item.ports
    const services = Array.isArray(rawServices)
      ? rawServices.map((service) => {
          if (!isRecord(service)) return String(service)
          return String(
            service.port_name ??
              service.name ??
              service.port ??
              service.container_port ??
              "service"
          )
        })
      : []
    return {
      name: String(
        item.container_name ??
          item.name ??
          item.image ??
          item.service ??
          `Target ${index + 1}`
      ),
      services,
    }
  })
}

function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

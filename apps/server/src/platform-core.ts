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
    protocol: "http" | "https" | "ws" | "wss" | "tcp" | "udp"
    guidance?: string[]
  }>
  expiresAt: string | null
  message?: string
}

export function isActiveTarget(target: TargetState) {
  return (
    target.status === "starting" ||
    target.status === "running" ||
    target.status === "stopping"
  )
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

export type JsonRecord = Record<string, unknown>

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export class PlatformHttp {
  readonly origin: string
  private readonly baseUrl: string

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
    const response = await this.request(path, init)
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType && !contentType.toLowerCase().includes("json")) {
      throw new PlatformError(
        `Platform returned ${contentType} instead of JSON; check the platform base URL`
      )
    }
    try {
      return (await response.json()) as T
    } catch {
      throw new PlatformError(
        "Platform returned invalid JSON; check the platform base URL"
      )
    }
  }
}

export abstract class BaseAdapter implements CtfPlatformAdapter {
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

export function absentTarget(): TargetState {
  return { status: "absent", endpoints: [], expiresAt: null }
}

export function targetEndpoint(name: string, address: string) {
  const lower = address.toLowerCase()
  const protocol = lower.startsWith("https://")
    ? ("https" as const)
    : lower.startsWith("http://")
      ? ("http" as const)
      : lower.startsWith("wss://")
        ? ("wss" as const)
        : lower.startsWith("ws://")
          ? ("ws" as const)
          : ("tcp" as const)
  return { name, address, protocol }
}

export function challengeCategory(value: JsonRecord) {
  const tags = Array.isArray(value.tag) ? value.tag : []
  const primary = tags.find((tag) => isRecord(tag) && tag.primary === true) as
    | JsonRecord
    | undefined
  return nullableString(primary?.name ?? tags.find(isRecord)?.name)
}

export function targetDefinitions(value: unknown): RemoteTargetInfo[] {
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

export function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null
}

export function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

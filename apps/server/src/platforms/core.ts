import type {
  PlatformType,
  RemoteEvent,
  RemoteTargetInfo,
  TargetState,
} from "@aegisx/shared"
import { isRecord } from "@aegisx/shared"
import { isActiveTarget } from "@aegisx/shared/domain"

import { normalizeHttpBaseUrl } from "../infrastructure/urls"
import {
  jsonText,
  nullableNumber,
  nullableString,
  parseJson,
  responseJson,
} from "../lib/guards"

export type { PlatformType, RemoteEvent, RemoteTargetInfo, TargetState }
export { isActiveTarget, isRecord, jsonText, nullableNumber, nullableString }

export type PlatformConfig = {
  type: PlatformType
  baseUrl: string
  credential: string
  remoteEventId: string
}

export type RemoteAttachment = {
  id: string
  filename: string
  url: string
  authenticated?: boolean
}

export type RemoteChallengeListItem = {
  id: string
  name: string
  category: string | null
  points: number | null
  solved: boolean
}

export type RemoteChallenge = RemoteChallengeListItem & {
  description: string
  targetSupported: boolean
  targetCount: number
  targets: RemoteTargetInfo[]
  attachments: RemoteAttachment[]
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
  testConnection(): Promise<void>
  listEvents(): Promise<RemoteEvent[]>
  listChallenges(): Promise<RemoteChallengeListItem[]>
  getChallenge(remoteId: string): Promise<RemoteChallenge>
  /**
   * Authoritative per-challenge solve verdict for single-challenge refresh.
   * Throws PlatformError(404) when the challenge no longer exists on the
   * platform. Each adapter picks its most reliable source — some platforms
   * only expose solves on the list endpoint (a1ctf), others only on the
   * detail / submit endpoint (ret2shell).
   */
  getSolveState(remoteId: string): Promise<boolean>
  downloadAttachment(attachment: RemoteAttachment): Promise<Response>
  submitFlag(
    remoteId: string,
    flag: string,
    signal?: AbortSignal
  ): Promise<SubmissionResult>
  getSubmission?(
    remoteId: string,
    submissionId: string,
    signal?: AbortSignal
  ): Promise<SubmissionResult>
  getTarget?(remoteId: string, signal?: AbortSignal): Promise<TargetState>
  startTarget?(remoteId: string, signal?: AbortSignal): Promise<TargetState>
  extendTarget?(remoteId: string, signal?: AbortSignal): Promise<TargetState>
  stopTarget?(remoteId: string, signal?: AbortSignal): Promise<TargetState>
}

export type JsonRecord = Record<string, unknown>

export class PlatformError extends Error {
  /** HTTP status from the response, when one was received. */
  readonly status?: number
  /** Machine-readable error code from the platform body (e.g. "duplicate"),
   * when the platform exposes one. Lets adapters distinguish cases that share
   * an HTTP status (TSecBench's 409 duplicate vs invalid_state). */
  readonly code?: string

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type PlatformRequestError = {
  method: string
  url: string
  requestHeaders: Record<string, string>
  requestBody: string | null
  // HTTP status when a response was received; null for network-layer failures.
  status: number | null
  // null when no response was received (network failure).
  responseHeaders: Record<string, string> | null
  responseBody: string | null
  // Populated only for network-layer failures; null for HTTP errors.
  error: string | null
}

/**
 * Flatten any HeadersInit into a plain record. In-repo callers pass plain
 * objects; the Headers/array forms are handled for completeness instead of
 * being silently dropped by a spread.
 */
function headerRecord(init?: HeadersInit): Record<string, string> {
  if (!init) return {}
  if (init instanceof Headers) return Object.fromEntries(init.entries())
  if (Array.isArray(init)) return Object.fromEntries(init)
  return init
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

export class PlatformHttp {
  readonly origin: string
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly onResponse?: (response: Response) => void,
    private readonly onError?: (info: PlatformRequestError) => void,
    private readonly timeoutMs = 30_000
  ) {
    try {
      const normalized = normalizeHttpBaseUrl(baseUrl)
      this.origin = new URL(normalized).origin
      this.baseUrl = normalized
    } catch {
      throw new PlatformError("Platform URL must use HTTP or HTTPS")
    }
  }

  async request(path: string, init: RequestInit = {}, authenticated = true) {
    const method = init.method ?? "GET"
    const extraHeaders = headerRecord(init.headers)
    const requestBody = typeof init.body === "string" ? init.body : null

    const mergedHeaders = (url: URL): Record<string, string> => ({
      Accept: "application/json",
      // Platform credentials never cross origins, including via redirects.
      ...(authenticated && url.origin === this.origin ? this.headers : {}),
      ...extraHeaders,
    })

    let url = new URL(path, `${this.baseUrl}/`)
    let requestHeaders!: Record<string, string>
    let response!: Response
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      requestHeaders = mergedHeaders(url)
      const timeout = AbortSignal.timeout(this.timeoutMs)
      try {
        response = await fetch(url, {
          ...init,
          headers: requestHeaders,
          redirect: "manual",
          signal: init.signal
            ? AbortSignal.any([init.signal, timeout])
            : timeout,
        })
      } catch (rawError) {
        // Network-layer failure: DNS, connection refused, timeout, abort.
        // No HTTP response exists; record what failed and rethrow.
        const error =
          rawError instanceof Error ? rawError.message : String(rawError)
        this.onError?.({
          method,
          url: url.toString(),
          requestHeaders,
          requestBody,
          status: null,
          responseHeaders: null,
          responseBody: null,
          error,
        })
        throw rawError
      }
      const location = response.headers.get("location")
      if (!REDIRECT_STATUSES.has(response.status) || !location) break
      const next = new URL(location, url)
      // Cross-origin redirects are surfaced as a non-ok response below; the
      // credentials were only ever attached to same-origin hops.
      if (next.origin !== this.origin) break
      url = next
    }

    this.onResponse?.(response)
    if (!response.ok) {
      let responseBody: string | null = null
      try {
        responseBody = await response.text()
      } catch {
        // Body unreadable; leave null.
      }
      let message = `Platform request failed (${response.status})`
      let code: string | undefined
      if (responseBody) {
        try {
          const body = parseJson<JsonRecord>(responseBody)
          const extracted =
            body.message ??
            body.detail ??
            (isRecord(body.error) ? body.error.message : body.error)
          if (extracted !== undefined && extracted !== null) {
            message = jsonText(extracted)
          }
          if (typeof body.code === "string") code = body.code
        } catch {
          // Non-JSON body; keep the status-line message.
        }
      }
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      this.onError?.({
        method,
        url: url.toString(),
        requestHeaders,
        requestBody,
        status: response.status,
        responseHeaders,
        responseBody,
        error: null,
      })
      throw new PlatformError(message, response.status, code)
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
      return await responseJson<T>(response)
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
    onResponse?: (response: Response) => void,
    onError?: (info: PlatformRequestError) => void,
    timeoutMs?: number
  ) {
    this.http = new PlatformHttp(
      config.baseUrl,
      headers,
      onResponse,
      onError,
      timeoutMs
    )
  }

  abstract listEvents(): Promise<RemoteEvent[]>
  abstract testConnection(): Promise<void>
  abstract listChallenges(): Promise<RemoteChallengeListItem[]>
  abstract getChallenge(remoteId: string): Promise<RemoteChallenge>
  abstract getSolveState(remoteId: string): Promise<boolean>
  abstract submitFlag(
    remoteId: string,
    flag: string,
    signal?: AbortSignal
  ): Promise<SubmissionResult>

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
  const primary = tags.find(
    (tag): tag is JsonRecord => isRecord(tag) && tag.primary === true
  )
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
          return jsonText(
            service.port_name ??
              service.name ??
              service.port ??
              service.container_port ??
              "service"
          )
        })
      : []
    return {
      name: jsonText(
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

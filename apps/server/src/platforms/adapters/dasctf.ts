import {
  absentTarget,
  BaseAdapter,
  nullableNumber,
  nullableString,
  type PlatformConfig,
  PlatformError,
  type PlatformRequestError,
  type SubmissionResult,
  type TargetState,
  targetEndpoint,
} from "../core"

/**
 * DASCTF AI Agent API types. All endpoints share the
 * `/slab-match/api/v1/agent` prefix and the `{code, message, data}` envelope;
 * `code === "00000"` is the only success value.
 */
const API_PREFIX = "/slab-match/api/v1/agent"

type ApiEnvelope<T> = {
  code?: string
  message?: string
  data?: T
}

type DasctfCategory = {
  id?: number
  name?: string
  corpus?: DasctfExerciseSummary[]
}

type DasctfExerciseSummary = {
  id?: number
  name?: string
  isOpen?: boolean
  hasSolved?: boolean
}

type DasctfFile = {
  name?: string
  url?: string
  ext?: string
}

type DasctfEndpoint = {
  exposeIps?: string[]
  ports?: string[]
  users?: { username?: string; password?: string }[]
  portMappings?: { type?: string; port?: string; proxy?: string }[]
  proxyIps?: string[]
  isProxy?: boolean
  expireTime?: number
}

type DasctfExercise = {
  id?: number
  name?: string
  description?: string
  hasSolved?: boolean
  score?: string
  difficulty?: string
  attachment?: { files?: DasctfFile[] }
  endpoints?: DasctfEndpoint[]
  isNeedInit?: boolean
  isNeedCheck?: boolean
}

/**
 * Adapter for the DASCTF competition platform (default
 * https://pro.dasctf.com).
 *
 * - Authenticates every request with an `X-Agent-AccessKey` header. One key
 *   identifies one match, so `listEvents` returns a single synthetic "match"
 *   event after verifying the key against the notice endpoint.
 * - Success is an envelope `code` of "00000"; any other code is a failure
 *   whose `message` explains why (including wrong-flag verdicts).
 * - The exercise detail endpoint doubles as the target state source:
 *   `isNeedInit` → not provisioned, `isNeedCheck` → still preparing,
 *   `endpoints` → connection info (direct or proxy per `isProxy`).
 * - Environment start is asynchronous (`build-exercise-env`); the shared
 *   service layer already polls the "starting" state we return until it
 *   resolves. There is no extend/refresh API, so `extendTarget` is not
 *   implemented.
 */
export class DasCtfAdapter extends BaseAdapter {
  constructor(
    config: PlatformConfig,
    onError?: (info: PlatformRequestError) => void,
    timeoutMs?: number
  ) {
    super(
      config,
      { "X-Agent-AccessKey": config.credential },
      undefined,
      onError,
      timeoutMs
    )
  }

  /** GET a path and unwrap the envelope, failing on non-"00000" codes. */
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const body = await this.http.json<ApiEnvelope<T>>(path, init)
    if (body.code !== "00000") {
      throw new PlatformError(
        nullableString(body.message) ?? `DASCTF API error (${body.code})`,
        undefined,
        body.code
      )
    }
    return body.data as T
  }

  async testConnection() {
    await this.api<unknown>(`${API_PREFIX}/match/notice/match-info`)
  }

  async listEvents() {
    // One access key = one match; verify the key, then synthesize the event.
    await this.testConnection()
    return [{ id: "match", name: "DASCTF Match" }]
  }

  async listChallenges() {
    const categories = await this.api<DasctfCategory[] | null>(
      `${API_PREFIX}/ctf/exercise-list`
    )
    return (categories ?? []).flatMap((category) =>
      (category.corpus ?? [])
        .filter((exercise) => exercise.isOpen !== false)
        .map((exercise) => ({
          id: String(exercise.id),
          name: String(exercise.name ?? `Exercise ${exercise.id}`),
          category: nullableString(category.name),
          points: null,
          solved: exercise.hasSolved === true,
        }))
    )
  }

  /** Fetch the exercise detail; a payload without an exercise id means the
   * challenge no longer exists on the platform. */
  private async fetchDetail(
    remoteId: string,
    signal?: AbortSignal
  ): Promise<DasctfExercise> {
    const detail = await this.api<DasctfExercise | null>(
      `${API_PREFIX}/ctf/exercise?exerciseId=${encodeURIComponent(remoteId)}`,
      { signal }
    )
    if (!detail || detail.id === undefined) {
      throw new PlatformError("Challenge not found on platform", 404)
    }
    return detail
  }

  async getChallenge(remoteId: string) {
    const detail = await this.fetchDetail(remoteId)
    const score = Number(detail.score)
    return {
      id: String(detail.id),
      name: String(detail.name ?? "Untitled challenge"),
      description: String(detail.description ?? ""),
      category: nullableString(detail.difficulty),
      points: Number.isFinite(score) ? score : null,
      solved: detail.hasSolved === true,
      targetSupported:
        (detail.endpoints?.length ?? 0) > 0 ||
        detail.isNeedInit === true ||
        detail.isNeedCheck === true,
      targetCount: 0,
      targets: [],
      attachments: (detail.attachment?.files ?? []).flatMap((file) => {
        const url = nullableString(file.url)
        if (!url) return []
        let sameOrigin = false
        try {
          sameOrigin =
            new URL(url, `${this.config.baseUrl}/`).origin === this.http.origin
        } catch {
          // Unparseable URL; download will fail loudly later.
        }
        return [
          {
            id: url,
            filename:
              nullableString(file.name) ??
              `attachment${file.ext ? `.${file.ext}` : ""}`,
            url,
            authenticated: sameOrigin,
          },
        ]
      }),
    }
  }

  async getSolveState(remoteId: string): Promise<boolean> {
    const detail = await this.fetchDetail(remoteId)
    return detail.hasSolved === true
  }

  async submitFlag(
    remoteId: string,
    flag: string,
    signal?: AbortSignal
  ): Promise<SubmissionResult> {
    try {
      const data = await this.api<{ isCorrect?: boolean }>(
        `${API_PREFIX}/answer-panel/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exerciseId: Number(remoteId), flag }),
          signal,
        }
      )
      return data?.isCorrect === true
        ? { status: "accepted" }
        : { status: "rejected", message: "答案错误" }
    } catch (error) {
      // A platform verdict arrived as an envelope error code (HTTP 200):
      // usually "wrong flag". Map it to a definitive rejection so the run
      // layer does not retry. HTTP-level failures keep their error status
      // (status !== undefined) and propagate as retryable errors.
      if (error instanceof PlatformError && error.status === undefined) {
        return { status: "rejected", message: error.message }
      }
      throw error
    }
  }

  async getTarget(
    remoteId: string,
    signal?: AbortSignal
  ): Promise<TargetState> {
    let detail: DasctfExercise
    try {
      detail = await this.fetchDetail(remoteId, signal)
    } catch (error) {
      if (error instanceof PlatformError && error.status === 404) {
        return absentTarget()
      }
      throw error
    }
    if (detail.isNeedInit === true) return absentTarget()
    if (detail.isNeedCheck === true) {
      return { status: "starting", endpoints: [], expiresAt: null }
    }
    const platformEndpoints = detail.endpoints ?? []
    if (platformEndpoints.length === 0) return absentTarget()
    const expireTimes = platformEndpoints
      .map((endpoint) => endpoint.expireTime)
      .filter((time): time is number => typeof time === "number")
    return {
      status: "running",
      endpoints: platformEndpoints.flatMap((endpoint, index) =>
        endpointAddresses(endpoint, index)
      ),
      expiresAt: expireTimes.length
        ? new Date(Math.max(...expireTimes)).toISOString()
        : null,
    }
  }

  async startTarget(remoteId: string, signal?: AbortSignal) {
    await this.envAction("build-exercise-env", remoteId, signal)
    return this.getTarget(remoteId, signal)
  }

  async stopTarget(remoteId: string, signal?: AbortSignal) {
    await this.envAction("recover-exercise-env", remoteId, signal)
    return this.getTarget(remoteId, signal)
  }

  private async envAction(
    action: "build-exercise-env" | "recover-exercise-env",
    remoteId: string,
    signal?: AbortSignal
  ) {
    await this.api<unknown>(`${API_PREFIX}/ctf/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exerciseId: Number(remoteId) }),
      signal,
    })
  }
}

/**
 * Expand one platform endpoint into host:port addresses. When `isProxy` is
 * set and proxy data exists, prefer `proxyIps` × mapped `proxy` ports;
 * otherwise use `exposeIps` × `ports`. Account credentials ride along as
 * endpoint guidance so the agent sees them next to the address.
 */
function endpointAddresses(
  endpoint: DasctfEndpoint,
  index: number
): TargetState["endpoints"] {
  const useProxy =
    endpoint.isProxy === true &&
    (endpoint.proxyIps?.length ?? 0) > 0 &&
    (endpoint.portMappings?.length ?? 0) > 0
  const hosts = useProxy ? endpoint.proxyIps! : (endpoint.exposeIps ?? [])
  const ports = useProxy
    ? endpoint.portMappings!.map((mapping) => mapping.proxy)
    : (endpoint.ports ?? [])
  const guidance = (endpoint.users ?? [])
    .filter((user) => user.username || user.password)
    .map(
      (user) => `credentials: ${user.username ?? ""} / ${user.password ?? ""}`
    )
  return hosts.flatMap((host) =>
    ports
      .filter((port): port is string => Boolean(port))
      .map((port) => ({
        ...targetEndpoint(`endpoint ${index + 1}:${port}`, `${host}:${port}`),
        ...(guidance.length > 0 ? { guidance } : {}),
      }))
  )
}

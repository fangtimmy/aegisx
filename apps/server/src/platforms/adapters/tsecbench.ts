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
 * TSecBench challenge list item (GET /openapi/v1/challenges). The endpoint
 * returns a bare array of these; there is no per-challenge detail endpoint.
 */
type TsecChallenge = {
  unique_code: string
  description: string | null
  difficulty: string
  level: number
  total_score: number
  flag_count: number
  correct_flag_count: number
  is_completed: boolean
  container_status: string
  container_addr: string[]
}

/** TSecBench submit response (POST /openapi/v1/challenges/submit). */
type TsecSubmitResponse = {
  correct: boolean
  awarded: number
  cumulative_score: number
  correct_flag_count: number
  total_flag_count: number
  matched_flag_index: number | null
}

/** Maps TSecBench container_status → the shared TargetStatus vocabulary. */
const containerStatusMap: Record<string, TargetState["status"]> = {
  pending: "starting",
  available: "running",
  stop_pending: "stopping",
  stopped: "absent",
}

/** The platform rejects every challenge-scoped call once its task is
 * finished — the event is over and all containers are reclaimed. */
const TASK_FINISHED_MESSAGE = "平台任务已结束，靶机已回收"

function isTaskFinishedError(error: unknown): boolean {
  return (
    error instanceof PlatformError && /already finished/i.test(error.message)
  )
}

/** Read-path list cache window (agents poll get_target every few seconds
 * while an instance transitions; each poll must not re-pull all 63 rows). */
const LIST_CACHE_TTL_MS = 3_000

/**
 * Adapter for the TSecBench Benchmark Platform.
 *
 * Notable differences from the other adapters:
 * - Authenticates with a `BENCHMARK_TOKEN` request header (UUID); one token
 *   identifies exactly one benchmark task, so there is no event list —
 *   `listEvents` returns a single synthetic "task" event.
 * - There is no per-challenge detail endpoint; `getChallenge` re-reads the
 *   list endpoint and filters by `unique_code`. Agents poll `get_target`
 *   heavily, so read paths share a short-lived list cache; lifecycle
 *   actions invalidate it so they observe their own effect.
 * - Challenges may have multiple flags (`flag_count`). A correct but non-final
 *   flag maps to `partial` so the challenge is only marked solved once all
 *   flags are in; only the final correct submission returns `accepted`.
 * - The platform has no extend/refresh lifecycle, so `extendTarget` is not
 *   implemented (the service layer reports it as unsupported).
 */
export class TsecBenchAdapter extends BaseAdapter {
  /** Short-lived list-cache (see class doc); verdict reads stay uncached. */
  private listCache: { at: number; data: TsecChallenge[] } | null = null

  constructor(
    config: PlatformConfig,
    onError?: (info: PlatformRequestError) => void,
    timeoutMs?: number
  ) {
    super(
      config,
      { BENCHMARK_TOKEN: config.credential },
      undefined,
      onError,
      timeoutMs
    )
  }

  async testConnection() {
    await this.http.json<unknown>("/openapi/v1/challenges")
  }

  async listEvents() {
    // TSecBench has no event concept; one token = one task. Still hit the
    // list endpoint so a bad token fails bind/discover with a proper error.
    await this.http.json<unknown>("/openapi/v1/challenges")
    return [{ id: "task", name: "TSecBench Task" }]
  }

  private async fetchList(
    signal?: AbortSignal,
    maxAgeMs = 0
  ): Promise<TsecChallenge[]> {
    if (this.listCache && Date.now() - this.listCache.at <= maxAgeMs) {
      return this.listCache.data
    }
    const body = await this.http.json<TsecChallenge[] | null>(
      "/openapi/v1/challenges",
      { signal }
    )
    this.listCache = { at: Date.now(), data: body ?? [] }
    return this.listCache.data
  }

  private async fetchChallenge(
    remoteId: string,
    signal?: AbortSignal
  ): Promise<TsecChallenge | undefined> {
    // Verdict-grade reads (getSolveState, submit-duplicate re-check) bypass
    // the cache: a stale is_completed would mis-tier an acceptance.
    return (await this.fetchList(signal)).find(
      (challenge) => challenge.unique_code === remoteId
    )
  }

  async listChallenges() {
    const list = await this.fetchList()
    return list.map((challenge) => ({
      id: challenge.unique_code,
      name: challenge.unique_code,
      category: nullableString(challenge.difficulty),
      points: nullableNumber(challenge.total_score),
      solved: challenge.is_completed,
    }))
  }

  async getChallenge(remoteId: string) {
    const list = await this.fetchList(undefined, LIST_CACHE_TTL_MS)
    const challenge = list.find((item) => item.unique_code === remoteId)
    if (!challenge) {
      throw new PlatformError("Challenge not found on platform", 404)
    }
    return {
      id: challenge.unique_code,
      name: challenge.unique_code,
      description: describeChallenge(challenge),
      category: nullableString(challenge.difficulty),
      points: nullableNumber(challenge.total_score),
      solved: challenge.is_completed,
      targetSupported: true,
      targetCount: 1,
      targets: [{ name: challenge.unique_code, services: [] }],
      attachments: [],
    }
  }

  async getSolveState(remoteId: string): Promise<boolean> {
    const challenge = await this.fetchChallenge(remoteId)
    if (!challenge) {
      throw new PlatformError("Challenge not found on platform", 404)
    }
    return challenge.is_completed
  }

  async submitFlag(
    remoteId: string,
    flag: string,
    signal?: AbortSignal
  ): Promise<SubmissionResult> {
    try {
      const body = await this.http.json<TsecSubmitResponse>(
        "/openapi/v1/challenges/submit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unique_code: remoteId, flag }),
          signal,
        }
      )
      if (!body.correct) return { status: "rejected" }
      const total = body.total_flag_count ?? 0
      const done = total > 0 && body.correct_flag_count >= total
      if (done) {
        return {
          status: "accepted",
          message: `+${body.awarded} 分（累计 ${body.cumulative_score}）`,
        }
      }
      return {
        status: "partial",
        message: `flag ${body.correct_flag_count}/${total} 已确认（+${body.awarded} 分），仍有未提交的 flag`,
      }
    } catch (error) {
      // Cross-run duplicate: the same flag_index was already accepted (e.g. by
      // another run). Re-check completion so we don't falsely mark the whole
      // challenge solved while flags remain.
      if (error instanceof PlatformError && error.code === "duplicate") {
        let completed = false
        try {
          completed =
            (await this.fetchChallenge(remoteId))?.is_completed === true
        } catch {
          // Couldn't determine completion; treat as not-yet-complete.
        }
        return completed
          ? { status: "already_solved", message: "该 flag 此前已提交" }
          : {
              status: "partial",
              message: "该 flag 此前已提交，仍有未完成的 flag",
            }
      }
      throw error
    }
  }

  async getTarget(
    remoteId: string,
    signal?: AbortSignal
  ): Promise<TargetState> {
    try {
      const list = await this.fetchList(signal, LIST_CACHE_TTL_MS)
      const challenge = list.find((item) => item.unique_code === remoteId)
      if (!challenge) return absentTarget()
      const status = containerStatusMap[challenge.container_status] ?? "failed"
      return {
        status,
        endpoints:
          status === "running"
            ? challenge.container_addr.map((address, index) =>
                targetEndpoint(`endpoint ${index + 1}`, address)
              )
            : [],
        expiresAt: null,
      }
    } catch (error) {
      // Once the platform task is finished every challenge-scoped call fails;
      // that is the event-over norm, not a fault — report the reclaimed
      // target as an explained absent state instead of a permanent error.
      if (isTaskFinishedError(error))
        return {
          status: "absent",
          endpoints: [],
          expiresAt: null,
          message: TASK_FINISHED_MESSAGE,
        }
      throw error
    }
  }

  async startTarget(remoteId: string, signal?: AbortSignal) {
    await this.http.request(
      `/openapi/v1/challenges/start?unique_code=${encodeURIComponent(remoteId)}`,
      { method: "POST", signal }
    )
    // The action's own effect must be visible to the read that follows.
    this.listCache = null
    return this.getTarget(remoteId, signal)
  }

  async stopTarget(remoteId: string, signal?: AbortSignal) {
    await this.http.request(
      `/openapi/v1/challenges/close?unique_code=${encodeURIComponent(remoteId)}`,
      { method: "POST", signal }
    )
    this.listCache = null
    return this.getTarget(remoteId, signal)
  }
}

/**
 * Build the stored challenge description, appending a multi-flag hint when the
 * challenge carries more than one flag so the agent knows to keep solving.
 */
function describeChallenge(challenge: TsecChallenge): string {
  const base = nullableString(challenge.description) ?? ""
  const note =
    challenge.flag_count > 1
      ? `\n\n> 本题共有 ${challenge.flag_count} 个 flag，需逐个获取并提交（当前已正确 ${challenge.correct_flag_count} 个）。`
      : ""
  return (base + note).trim()
}

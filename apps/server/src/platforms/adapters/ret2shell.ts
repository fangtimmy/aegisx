import {
  absentTarget,
  BaseAdapter,
  challengeCategory,
  isRecord,
  type JsonRecord,
  nullableNumber,
  nullableString,
  type PlatformConfig,
  type PlatformRequestError,
  type RemoteChallengeSummary,
  type RemoteEvent,
  type SubmissionResult,
  targetDefinitions,
  targetEndpoint,
} from "../core"

export class Ret2ShellAdapter extends BaseAdapter {
  constructor(
    config: PlatformConfig,
    onCredential?: (credential: string) => void,
    onError?: (info: PlatformRequestError) => void
  ) {
    super(
      config,
      { Authorization: `Bearer ${config.credential}` },
      (response) => {
        const token = response.headers.get("Set-Token")
        if (token) onCredential?.(token)
      },
      onError
    )
  }

  async listEvents() {
    const items: RemoteEvent[] = []
    for (let page = 1; ; page += 1) {
      const body = await this.http.json<[JsonRecord[], number]>(
        `/api/game?page=${page}&page_size=100`
      )
      items.push(
        ...body[0].map((game) => ({
          id: String(game.id),
          name: String(game.name ?? `Game ${game.id}`),
        }))
      )
      if (items.length >= body[1] || body[0].length === 0) return items
    }
  }

  async listChallenges() {
    const items: RemoteChallengeSummary[] = []
    for (let page = 1; ; page += 1) {
      const body = await this.http.json<[JsonRecord[], number]>(
        `/api/game/${encodeURIComponent(this.config.remoteEventId)}/challenge?page=${page}&page_size=100`
      )
      items.push(
        ...body[0].map((challenge) => ({
          id: String(challenge.id),
          name: String(challenge.name ?? `Challenge ${challenge.id}`),
          category: challengeCategory(challenge),
          points: nullableNumber(challenge.score),
          solved: challenge.solved === true,
        }))
      )
      if (items.length >= body[1] || body[0].length === 0) return items
    }
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
    const exposed = Array.isArray(value.exposed_ports)
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
    const endpoints = exposed.length
      ? exposed
      : wsrxEndpoints(value, this.config.baseUrl)
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

function wsrxEndpoints(value: JsonRecord, baseUrl: string) {
  if (typeof value.traffic !== "string" || !Array.isArray(value.ports)) {
    return []
  }
  const traffic = value.traffic
  return value.ports.flatMap((rawPort) => {
    const port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return []
    const url = new URL(`/api/traffic/${encodeURIComponent(traffic)}`, baseUrl)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("port", String(port))
    const address = url.toString()
    return [
      {
        ...targetEndpoint(`port ${port}`, address),
        guidance: [
          "This is a Ret2Shell WSRX tunnel endpoint, not a directly reachable WebSocket service.",
          `Start a local tunnel with: wsrx connect '${address}' --host 127.0.0.1 --port <local-port>`,
          "Then connect curl, nc, or other tools to 127.0.0.1:<local-port>.",
        ],
      },
    ]
  })
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

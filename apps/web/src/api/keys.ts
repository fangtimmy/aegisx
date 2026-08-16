export const keys = {
  events: {
    all: ["events"] as const,
    detail: (id: string) => ["events", id] as const,
    usage: (id: string) => ["events", id, "usage"] as const,
  },
  runs: {
    byEvent: (eventId: string) => ["runs", "event", eventId] as const,
    /** Runs + per-run agent details for the event overview (fleet view). */
    fleet: (eventId: string) => ["runs", "event", eventId, "fleet"] as const,
    detail: (runId: string) => ["runs", runId] as const,
    files: (runId: string, path: string) =>
      ["runs", runId, "files", path] as const,
    messages: (runId: string, agentId?: string) =>
      ["runs", runId, "messages", agentId ?? "all"] as const,
  },
  scheduler: {
    detail: (eventId: string) => ["events", eventId, "scheduler"] as const,
    queue: (eventId: string) => ["events", eventId, "queue"] as const,
  },
  challenges: {
    target: (challengeId: string) =>
      ["challenges", challengeId, "target"] as const,
  },
  providers: {
    all: ["providers"] as const,
    piModels: ["providers", "pi-models"] as const,
  },
  settings: {
    all: ["settings"] as const,
  },
  promptTemplates: {
    all: ["prompt-templates"] as const,
  },
}

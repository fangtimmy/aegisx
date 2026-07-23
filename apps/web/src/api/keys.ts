export const keys = {
  events: {
    all: ["events"] as const,
    detail: (id: string) => ["events", id] as const,
    stats: (id: string) => ["events", id, "stats"] as const,
  },
  runs: {
    byEvent: (eventId: string) => ["runs", "event", eventId] as const,
    detail: (runId: string) => ["runs", runId] as const,
    conversation: (runId: string, agentId: string) =>
      ["runs", runId, "agents", agentId] as const,
    inspector: (runId: string, agentId: string) =>
      ["runs", runId, "agents", agentId, "inspector"] as const,
    files: (runId: string, path: string) =>
      ["runs", runId, "files", path] as const,
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
}

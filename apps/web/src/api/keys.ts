export const keys = {
  events: {
    all: ["events"] as const,
    detail: (id: string) => ["events", id] as const,
  },
  runs: {
    byEvent: (eventId: string) => ["runs", "event", eventId] as const,
    detail: (runId: string) => ["runs", runId] as const,
    files: (runId: string, path: string) =>
      ["runs", runId, "files", path] as const,
    messages: (runId: string, agentId?: string) =>
      ["runs", runId, "messages", agentId ?? "all"] as const,
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
  orchestrator: {
    detail: (eventId: string) => ["orchestrator", eventId] as const,
    messages: (eventId: string) =>
      ["orchestrator", eventId, "messages"] as const,
    files: (eventId: string, path: string) =>
      ["orchestrator", eventId, "files", path] as const,
  },
}

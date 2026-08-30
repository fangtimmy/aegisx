export const keys = {
  activity: {
    all: ["activity"] as const,
  },
  events: {
    all: ["events"] as const,
    detail: (id: string) => ["events", id] as const,
    usage: (id: string) => ["events", id, "usage"] as const,
    stats: (id: string) => ["events", id, "stats"] as const,
  },
  agents: {
    /** Per-challenge agents + the scheduler agent (the fleet view). */
    fleet: (eventId: string) => ["agents", "event", eventId, "fleet"] as const,
    detail: (agentId: string) => ["agents", agentId] as const,
    messages: (agentId: string, sessionId?: string) =>
      ["agents", agentId, "messages", sessionId ?? "active"] as const,
    channels: (agentId: string) => ["agents", agentId, "channels"] as const,
  },
  challenges: {
    files: (challengeId: string, path: string) =>
      ["challenges", challengeId, "files", path] as const,
    channels: (challengeId: string) =>
      ["challenges", challengeId, "channels"] as const,
    target: (challengeId: string) =>
      ["challenges", challengeId, "target"] as const,
  },
  channels: {
    messages: (channelKey: string) =>
      ["channels", channelKey, "messages"] as const,
  },
  scheduler: {
    detail: (eventId: string) => ["events", eventId, "scheduler"] as const,
    queue: (eventId: string) => ["events", eventId, "queue"] as const,
    inbox: (eventId: string) => ["events", eventId, "inbox"] as const,
  },
  providers: {
    all: ["providers"] as const,
  },
  models: {
    all: ["models"] as const,
  },
  settings: {
    all: ["settings"] as const,
  },
  promptTemplates: {
    all: ["prompt-templates"] as const,
  },
}

export type {
  AgentInspector,
  AgentPublic,
  AgentRuntimeSnapshot,
  AgentStatus,
  AgentSummary,
  AgentToolStats,
  Attachment,
  Challenge,
  ChallengeInput,
  ChallengeSyncResult,
  EventInput,
  EventPlatform,
  EventStats,
  EventSummary,
  ModelMetadata,
  PiModelProfile,
  PlatformType,
  ProviderConnection,
  ProviderModel,
  ProviderType,
  RemoteChallengeSummary,
  RemoteEvent,
  RunFile,
  RunFileEntry,
  RunPublic,
  RunStatus,
  RunStreamEvent,
  SessionEntry,
  SettingsPublic,
  TargetState,
  ThinkingLevel,
  UsageSummary,
} from "../../../shared/api"

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`/api${path}`, init)

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`

    try {
      const body = (await response.json()) as {
        error?: { message?: string }
      }
      if (body.error?.message) message = body.error.message
    } catch {
      // Keep the HTTP status when the server does not return its JSON error shape.
    }

    throw new Error(message || "The request failed")
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function jsonRequest(method: "POST" | "PUT" | "PATCH", body: object) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } satisfies RequestInit
}

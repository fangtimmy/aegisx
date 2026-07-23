import type { QueryClient } from "@tanstack/react-query"
import type {
  AgentConversation,
  RunDetail,
  RunPublic,
  RunStreamEvent,
} from "@/api"
import { keys } from "@/api"

export function applyRunMetaFromStream(
  queryClient: QueryClient,
  eventId: string,
  runId: string,
  event: Extract<RunStreamEvent, { type: "run.updated" | "agent.updated" }>
) {
  if (event.type === "run.updated") {
    queryClient.setQueryData<RunDetail>(keys.runs.detail(runId), (value) =>
      value
        ? {
            ...value,
            run: event.run,
            ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
          }
        : value
    )
    queryClient.setQueryData<{ items: RunPublic[] }>(
      keys.runs.byEvent(eventId),
      (value) =>
        value
          ? {
              ...value,
              items: value.items.map((run) =>
                run.id === event.run.id ? event.run : run
              ),
            }
          : value
    )
    return
  }

  queryClient.setQueryData<RunDetail>(keys.runs.detail(runId), (value) =>
    value
      ? {
          ...value,
          agents: value.agents.some((agent) => agent.id === event.agent.id)
            ? value.agents.map((agent) =>
                agent.id === event.agent.id
                  ? { ...agent, ...event.agent }
                  : agent
              )
            : [...value.agents, event.agent],
          ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
        }
      : value
  )
}

export function invalidateRunQueries(
  queryClient: QueryClient,
  eventId: string,
  runId: string,
  agentId?: string
) {
  const tasks = [
    queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) }),
    queryClient.invalidateQueries({ queryKey: keys.runs.byEvent(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.all }),
  ]
  if (agentId) {
    tasks.push(
      queryClient.invalidateQueries({
        queryKey: keys.runs.conversation(runId, agentId),
      })
    )
  }
  return Promise.all(tasks)
}

export type { AgentConversation }

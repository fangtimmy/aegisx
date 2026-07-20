import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import type {
  AgentSummary,
  ConversationMessage,
  RunPublic,
  RunStatus,
  RunStreamEvent,
  UsageSummary,
} from "@/lib/api"
import { apiRequest, jsonRequest } from "@/lib/api"
import { eventKeys } from "../events/shared"
import { RunStreamStore } from "./run-stream-store"

const terminalStatuses: RunStatus[] = ["completed", "failed", "stopped"]

type RunDetail = {
  run: RunPublic
  agents: AgentSummary[]
  messages: ConversationMessage[]
  stats: UsageSummary
  cursor: number
}

type AgentConversation = {
  runId: string
  agentId: string
  messages: ConversationMessage[]
  cursor: number
}

export function useRunController({
  eventId,
  runId,
  requestedAgentId,
  onMessageSent,
}: {
  eventId: string
  runId?: string
  requestedAgentId: string | null
  onMessageSent: () => void
}) {
  const queryClient = useQueryClient()
  const streamStore = useRef(new RunStreamStore()).current
  const retryMessage = useRef<{ id: string; text: string } | null>(null)
  const [streamDisconnected, setStreamDisconnected] = useState(false)
  const [streamCursor, setStreamCursor] = useState<number | null>(null)
  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: ["runs", runId ?? ""],
    refetchOnWindowFocus: false,
    queryFn: () => apiRequest<RunDetail>(`/runs/${runId}`),
  })
  useEffect(() => {
    if (
      streamCursor === null &&
      detail.data &&
      !terminalStatuses.includes(detail.data.run.status)
    ) {
      setStreamCursor(detail.data.cursor)
    }
  }, [detail.data, streamCursor])
  const selectedAgent =
    detail.data?.agents.find((agent) => agent.id === requestedAgentId) ??
    detail.data?.agents.find((agent) => agent.parentAgentId === null) ??
    detail.data?.agents[0]
  const agentDetail = useQuery({
    enabled: Boolean(
      runId && selectedAgent && selectedAgent.parentAgentId !== null
    ),
    queryKey: ["runs", runId ?? "", "agents", selectedAgent?.id ?? ""],
    queryFn: () =>
      apiRequest<AgentConversation>(
        `/runs/${runId}/conversation?agentId=${encodeURIComponent(selectedAgent?.id ?? "")}`
      ),
  })
  useEffect(() => {
    const main = detail.data?.agents.find(
      (agent) => agent.parentAgentId === null
    )
    if (main && detail.data) {
      streamStore.applySnapshot(main.id, detail.data.messages)
    }
    if (agentDetail.data) {
      streamStore.applySnapshot(
        agentDetail.data.agentId,
        agentDetail.data.messages
      )
    }
  }, [agentDetail.data, detail.data, streamStore])
  const control = useMutation({
    mutationFn: ({
      action,
      body,
    }: {
      action: "message" | "pause" | "resume" | "stop"
      body: { message?: string; clientMessageId?: string }
      agentId?: string
    }) =>
      apiRequest<void>(`/runs/${runId}/${action}`, jsonRequest("POST", body)),
    onSuccess: async (_, variables) => {
      if (variables.action === "message" || variables.action === "resume") {
        onMessageSent()
        if (retryMessage.current?.id === variables.body.clientMessageId) {
          retryMessage.current = null
        }
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs", runId ?? ""] }),
        queryClient.invalidateQueries({
          queryKey: ["runs", "event", eventId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["runs", runId ?? "", "agents", selectedAgent?.id ?? ""],
        }),
        queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
    },
    onError: (_error, variables) => {
      if (variables.agentId && variables.body.clientMessageId) {
        streamStore.removePendingMessage(
          variables.agentId,
          variables.body.clientMessageId
        )
      }
    },
  })

  useEffect(() => {
    setStreamDisconnected(false)
    if (!runId || streamCursor === null) return
    const stop = streamStore.connect(
      runId,
      streamCursor,
      (event: RunStreamEvent) => {
        if (event.type === "run.updated") {
          queryClient.setQueryData<RunDetail>(["runs", runId], (value) =>
            value
              ? {
                  ...value,
                  run: event.run,
                  ...(event.cursor !== undefined
                    ? { cursor: event.cursor }
                    : {}),
                }
              : value
          )
          queryClient.setQueryData<{ items: RunPublic[] }>(
            ["runs", "event", eventId],
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
          if (
            streamStore.closeOnTerminal(event.run.status, () =>
              queryClient.invalidateQueries({ queryKey: ["runs", runId] })
            )
          ) {
            setStreamDisconnected(false)
            void queryClient.invalidateQueries({ queryKey: eventKeys.all })
            void queryClient.invalidateQueries({
              queryKey: eventKeys.detail(eventId),
            })
          }
          return
        }
        if (event.type === "agent.updated") {
          queryClient.setQueryData<RunDetail>(["runs", runId], (value) =>
            value
              ? {
                  ...value,
                  agents: value.agents.some(
                    (agent) => agent.id === event.agent.id
                  )
                    ? value.agents.map((agent) =>
                        agent.id === event.agent.id
                          ? { ...agent, ...event.agent }
                          : agent
                      )
                    : [...value.agents, event.agent],
                  ...(event.cursor !== undefined
                    ? { cursor: event.cursor }
                    : {}),
                }
              : value
          )
        }
      },
      setStreamDisconnected,
      () => {
        streamStore.resetForReconnect()
        void queryClient.invalidateQueries({ queryKey: ["runs", runId] })
      }
    )
    return stop
  }, [eventId, queryClient, runId, streamCursor, streamStore])

  return {
    detail,
    agentDetail,
    selectedAgent,
    control,
    retryMessage,
    streamDisconnected,
    streamStore,
  }
}

export type { RunDetail }

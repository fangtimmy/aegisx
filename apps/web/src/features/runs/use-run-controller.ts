import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import {
  keys,
  type RunDetail,
  type RunStatus,
  type RunStreamEvent,
  runsApi,
} from "@/api"
import { toast } from "@/lib/toast"
import {
  applyRunMetaFromStream,
  invalidateRunQueries,
} from "@/stream/apply-run-meta"
import { ConversationStore } from "@/stream/conversation-store"

const terminalStatuses: RunStatus[] = ["completed", "failed", "stopped"]

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
  const streamStore = useRef(new ConversationStore()).current
  const retryMessage = useRef<{ id: string; text: string } | null>(null)
  const [streamDisconnected, setStreamDisconnected] = useState(false)
  const [streamCursor, setStreamCursor] = useState<number | null>(null)

  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: keys.runs.detail(runId ?? ""),
    refetchOnWindowFocus: false,
    queryFn: () => runsApi.getRun(runId ?? ""),
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
    queryKey: keys.runs.conversation(runId ?? "", selectedAgent?.id ?? ""),
    queryFn: () =>
      runsApi.getAgentConversation(runId ?? "", selectedAgent?.id ?? ""),
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
    }) => runsApi.controlRun(runId ?? "", action, body),
    onSuccess: async (_, variables) => {
      if (variables.action === "message" || variables.action === "resume") {
        onMessageSent()
        if (retryMessage.current?.id === variables.body.clientMessageId) {
          retryMessage.current = null
        }
      }
      await invalidateRunQueries(
        queryClient,
        eventId,
        runId ?? "",
        selectedAgent?.id
      )
    },
    onError: (error, variables) => {
      const actionLabel =
        variables.action === "message"
          ? "send message"
          : variables.action === "stop"
            ? "stop run"
            : variables.action
      toast.error(`Failed to ${actionLabel}`, error.message)
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
        if (event.type === "run.updated" || event.type === "agent.updated") {
          applyRunMetaFromStream(queryClient, eventId, runId, event)
        }
        if (event.type === "run.updated") {
          if (
            streamStore.closeOnTerminal(event.run.status, () =>
              queryClient.invalidateQueries({
                queryKey: keys.runs.detail(runId),
              })
            )
          ) {
            setStreamDisconnected(false)
            void queryClient.invalidateQueries({ queryKey: keys.events.all })
            void queryClient.invalidateQueries({
              queryKey: keys.events.detail(eventId),
            })
          }
        }
      },
      setStreamDisconnected,
      () => {
        streamStore.resetForReconnect()
        void queryClient.invalidateQueries({
          queryKey: keys.runs.detail(runId),
        })
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import {
  keys,
  type LiveEvent,
  type RunDetail,
  type RunStatus,
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
  const [streamReady, setStreamReady] = useState(false)

  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: keys.runs.detail(runId ?? ""),
    refetchOnWindowFocus: false,
    queryFn: () => runsApi.getRun(runId ?? ""),
  })

  useEffect(() => {
    setStreamReady(false)
    setStreamDisconnected(false)
  }, [])

  useEffect(() => {
    if (
      !streamReady &&
      detail.data &&
      !terminalStatuses.includes(detail.data.run.status)
    ) {
      setStreamReady(true)
    }
  }, [detail.data, streamReady])

  const selectedAgent =
    detail.data?.agents.find((agent) => agent.id === requestedAgentId) ??
    detail.data?.agents.find((agent) => agent.parentAgentId === null) ??
    detail.data?.agents[0]

  const mainAgent = detail.data?.agents.find(
    (agent) => agent.parentAgentId === null
  )

  const agentMessages = useQuery({
    enabled: Boolean(runId && selectedAgent),
    queryKey: keys.runs.messages(runId ?? "", selectedAgent?.id ?? ""),
    queryFn: () =>
      runsApi.getAgentMessages(runId ?? "", selectedAgent?.id ?? ""),
  })

  useEffect(() => {
    if (agentMessages.data) {
      streamStore.applySnapshot(
        agentMessages.data.agentId,
        agentMessages.data.messages
      )
    }
  }, [agentMessages.data, streamStore])

  // Prefetch main transcript when viewing a child so handoff context is ready
  // when switching back (optional lightweight).
  useEffect(() => {
    if (!runId || !mainAgent || selectedAgent?.id === mainAgent.id) return
    void runsApi.getAgentMessages(runId, mainAgent.id).then((page) => {
      streamStore.applySnapshot(page.agentId, page.messages)
    })
  }, [mainAgent, runId, selectedAgent?.id, streamStore])

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
    if (!runId || !streamReady) return
    const stop = streamStore.connect(
      runId,
      (event: LiveEvent) => {
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
        if (event.type === "message.committed") {
          void queryClient.invalidateQueries({
            queryKey: keys.runs.messages(runId, event.agentId),
          })
        }
      },
      setStreamDisconnected,
      () => {
        streamStore.resetForReconnect()
        void queryClient.invalidateQueries({
          queryKey: keys.runs.detail(runId),
        })
        if (selectedAgent) {
          void queryClient.invalidateQueries({
            queryKey: keys.runs.messages(runId, selectedAgent.id),
          })
        }
      }
    )
    return stop
  }, [eventId, queryClient, runId, selectedAgent, streamReady, streamStore])

  return {
    detail,
    agentDetail: agentMessages,
    selectedAgent,
    control,
    retryMessage,
    streamDisconnected,
    streamStore,
  }
}

export type { RunDetail }

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
  const [streamClosed, setStreamClosed] = useState(false)
  const [streamReady, setStreamReady] = useState(false)

  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: keys.runs.detail(runId ?? ""),
    refetchOnWindowFocus: false,
    queryFn: () => runsApi.getRun(runId ?? ""),
  })

  // Reset store when navigating between runs (runId is intentionally a dependency).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on runId change
  useEffect(() => {
    streamStore.reset()
    setStreamReady(false)
    setStreamDisconnected(false)
    setStreamClosed(false)
    retryMessage.current = null
  }, [runId, streamStore])

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
  const selectedAgentId = selectedAgent?.id

  const mainAgent = detail.data?.agents.find(
    (agent) => agent.parentAgentId === null
  )

  const agentMessages = useQuery({
    enabled: Boolean(runId && selectedAgentId),
    queryKey: keys.runs.messages(runId ?? "", selectedAgentId ?? ""),
    queryFn: () => runsApi.getAgentMessages(runId ?? "", selectedAgentId ?? ""),
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
    if (!runId || !mainAgent || selectedAgentId === mainAgent.id) return
    void runsApi.getAgentMessages(runId, mainAgent.id).then((page) => {
      streamStore.applySnapshot(page.agentId, page.messages)
    })
  }, [mainAgent, runId, selectedAgentId, streamStore])

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
        selectedAgentId
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
    setStreamClosed(false)
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
              invalidateRunAndAgentQueries(queryClient, runId)
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
        void invalidateRunAndAgentQueries(queryClient, runId)
      },
      () => setStreamClosed(true)
    )
    return stop
  }, [eventId, queryClient, runId, streamReady, streamStore])

  return {
    detail,
    agentDetail: agentMessages,
    selectedAgent,
    control,
    retryMessage,
    streamClosed,
    streamDisconnected,
    streamStore,
  }
}

export type { RunDetail }

/**
 * Invalidate the run detail and all per-agent message/inspector queries via a
 * shared prefix. Ensures terminal/close and reconnect paths re-fetch every
 * agent's transcript instead of just the currently visible one.
 */
function invalidateRunAndAgentQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  runId: string
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) }),
    queryClient.invalidateQueries({
      queryKey: ["runs", runId, "agents"],
    }),
  ])
}

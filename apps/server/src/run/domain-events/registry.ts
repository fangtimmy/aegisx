/** Domain event registry (control-plane §A): the single declaration point
 * for every stream event type — its payload shape and its append-time
 * validation. Payloads are plain JSON (the `domain_events.payload` column);
 * these TS types are the schema. Additive evolution only: new types, new
 * optional fields. */
import { isRecord } from "@aegisx/shared"

type QueueSource = "manual" | "scheduler"

/** Full spawn-spec snapshot — the payload rebuilds the spawn_queue row. */
type QueueEnqueuedPayload = {
  itemId: string
  ord: number
  challengeId: string
  params: Record<string, unknown>
  timeoutMs: number | null
  prompt: string
  source: QueueSource
}
type QueueLaunchedPayload = { itemId: string; agentId: string }
type QueueItemFailedPayload = { itemId: string; error: string }
type QueueItemCancelledPayload = { itemId: string }
type QueueItemDonePayload = { itemId: string; agentId: string }
type QueueReorderedPayload = { itemIds: string[] }
type QueuePausedPayload = { source: QueueSource | "boot" }
type QueueResumedPayload = { source: QueueSource }
/** Boot recovery: running items reset to pending (agent ids dropped). */
type QueueItemResetPayload = { count: number }
type QueueItemRemovedPayload = { itemId: string }
type QueueItemEditedPayload = {
  itemId: string
  prompt?: string
  timeoutMs?: number | null
  params?: Record<string, unknown>
}

type FlagSubmittedPayload = {
  flagId: string
  value: string
  /** The submitting agent (source is always 'agent' on this path). */
  submitter: string
  status: "pending" | "error"
  remoteId?: string | null
  message?: string | null
}
type FlagAcceptedPayload = {
  flagId: string
  value: string
  source: "agent" | "manual"
  submitter: string | null
  /** first = the challenge's initial solve, extra = a new flag value on an
   * already-solved challenge, partial = correct-but-incomplete multi-flag. */
  tier: "first" | "extra" | "partial"
  remoteId?: string | null
  message?: string | null
  /** Integrated acceptance flips the challenge_remote mirror. */
  remoteSolved?: boolean
}
type FlagRejectedPayload = {
  flagId: string
  value: string
  submitter: string
  remoteId?: string | null
  message?: string | null
}
type FlagDeletedPayload = { flagId: string; value: string }

/** Full import snapshot — rebuilds the challenges row + its remote mapping. */
type ChallengeImportedPayload = {
  challengeId: string
  remoteId: string
  sourceKey: string
  name: string
  description: string
  category: string | null
  points: number | null
  requiredFlags?: number
  solved: boolean
  targetSupported: boolean
  targetCount: number
  targetInfo: string
}
/** Sync / manual-refresh delta — only present fields are projected. */
type ChallengeSyncedPayload = {
  challengeId: string
  name?: string
  description?: string
  category?: string | null
  points?: number | null
  requiredFlags?: number
  available?: boolean
  solved?: boolean
  targetSupported?: boolean
  targetCount?: number
  targetInfo?: string
  targetIgnored?: boolean
}
type ChallengeOverriddenPayload = {
  manualSolveState: "unsolved" | "partial" | "solved"
}
/** First entry into solved (the solve cleanup's idempotency anchor). */
type ChallengeSolvedPayload = { solvedAt: string }
/** Progress reset; event scope carries the event's challenge ids. */
type ChallengeProgressResetPayload = { challengeIds?: string[] }

type FenceBlockedPayload = {
  code: "global_capacity" | "target_slots" | "challenge_solved"
  message: string
  via: "spawn" | "queue" | "manual" | "plan"
}
type ChannelPostedPayload = {
  channelKey: string
  messageId: number
  authorType: "system" | "user" | "agent"
  authorAgentId?: string
  urgent?: boolean
}

export type DomainEventPayloads = {
  "queue.enqueued": QueueEnqueuedPayload
  "queue.launched": QueueLaunchedPayload
  "queue.item_failed": QueueItemFailedPayload
  "queue.item_cancelled": QueueItemCancelledPayload
  "queue.item_done": QueueItemDonePayload
  "queue.reordered": QueueReorderedPayload
  "queue.paused": QueuePausedPayload
  "queue.resumed": QueueResumedPayload
  "queue.item_reset": QueueItemResetPayload
  "queue.item_removed": QueueItemRemovedPayload
  "queue.item_edited": QueueItemEditedPayload
  "queue.items_cleared": Record<never, never>
  "flag.submitted": FlagSubmittedPayload
  "flag.accepted": FlagAcceptedPayload
  "flag.rejected": FlagRejectedPayload
  "flag.deleted": FlagDeletedPayload
  "challenge.imported": ChallengeImportedPayload
  "challenge.synced": ChallengeSyncedPayload
  "challenge.overridden": ChallengeOverriddenPayload
  "challenge.solved": ChallengeSolvedPayload
  "challenge.progress_reset": ChallengeProgressResetPayload
  "fence.blocked": FenceBlockedPayload
  "channel.posted": ChannelPostedPayload
}

export type DomainEventType = keyof DomainEventPayloads
export type DomainEventPayloadOf<T extends DomainEventType> =
  DomainEventPayloads[T]

type FieldKind = "string" | "number" | "boolean" | "string[]" | "record"
type FieldRule = {
  kind: FieldKind
  optional?: boolean
  nullable?: boolean
}

function fieldMatches(kind: FieldKind, value: unknown): boolean {
  if (kind === "string") return typeof value === "string"
  if (kind === "number")
    return typeof value === "number" && Number.isFinite(value)
  if (kind === "boolean") return typeof value === "boolean"
  if (kind === "string[]") {
    return Array.isArray(value) && value.every((v) => typeof v === "string")
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateFields(
  payload: unknown,
  fields: Record<string, FieldRule>
): string | null {
  if (!isRecord(payload)) {
    return "payload must be an object"
  }
  for (const [key, rule] of Object.entries(fields)) {
    const value = payload[key]
    if (value === undefined) {
      if (!rule.optional) return `missing field "${key}"`
      continue
    }
    if (value === null) {
      if (!rule.nullable) return `field "${key}" must not be null`
      continue
    }
    if (!fieldMatches(rule.kind, value)) {
      return `field "${key}" must be ${rule.kind}`
    }
  }
  for (const key of Object.keys(payload)) {
    if (!(key in fields)) return `unknown field "${key}"`
  }
  return null
}

type EventDef = {
  fields: Record<string, FieldRule>
}

/** The registry: one entry per event type. Field rules double as the payload
 * documentation — required unless `optional`, JSON-null allowed only when
 * `nullable`, and unknown fields are rejected. */
const DOMAIN_EVENT_REGISTRY: {
  [T in DomainEventType]: EventDef
} = {
  "queue.enqueued": {
    fields: {
      itemId: { kind: "string" },
      ord: { kind: "number" },
      challengeId: { kind: "string" },
      params: { kind: "record" },
      timeoutMs: { kind: "number", nullable: true },
      prompt: { kind: "string" },
      source: { kind: "string" },
    },
  },
  "queue.launched": {
    fields: {
      itemId: { kind: "string" },
      agentId: { kind: "string" },
    },
  },
  "queue.item_failed": {
    fields: {
      itemId: { kind: "string" },
      error: { kind: "string" },
    },
  },
  "queue.item_cancelled": { fields: { itemId: { kind: "string" } } },
  "queue.item_done": {
    fields: {
      itemId: { kind: "string" },
      agentId: { kind: "string" },
    },
  },
  "queue.reordered": { fields: { itemIds: { kind: "string[]" } } },
  "queue.paused": { fields: { source: { kind: "string" } } },
  "queue.resumed": { fields: { source: { kind: "string" } } },
  "queue.item_reset": { fields: { count: { kind: "number" } } },
  "queue.item_removed": { fields: { itemId: { kind: "string" } } },
  "queue.item_edited": {
    fields: {
      itemId: { kind: "string" },
      prompt: { kind: "string", optional: true },
      timeoutMs: { kind: "number", nullable: true, optional: true },
      params: { kind: "record", optional: true },
    },
  },
  "queue.items_cleared": { fields: {} },
  "flag.submitted": {
    fields: {
      flagId: { kind: "string" },
      value: { kind: "string" },
      submitter: { kind: "string" },
      status: { kind: "string" },
      remoteId: { kind: "string", nullable: true, optional: true },
      message: { kind: "string", nullable: true, optional: true },
    },
  },
  "flag.accepted": {
    fields: {
      flagId: { kind: "string" },
      value: { kind: "string" },
      source: { kind: "string" },
      submitter: { kind: "string", nullable: true },
      tier: { kind: "string" },
      remoteId: { kind: "string", nullable: true, optional: true },
      message: { kind: "string", nullable: true, optional: true },
      remoteSolved: { kind: "boolean", optional: true },
    },
  },
  "flag.rejected": {
    fields: {
      flagId: { kind: "string" },
      value: { kind: "string" },
      submitter: { kind: "string" },
      remoteId: { kind: "string", nullable: true, optional: true },
      message: { kind: "string", nullable: true, optional: true },
    },
  },
  "flag.deleted": {
    fields: {
      flagId: { kind: "string" },
      value: { kind: "string" },
    },
  },
  "challenge.imported": {
    fields: {
      challengeId: { kind: "string" },
      remoteId: { kind: "string" },
      sourceKey: { kind: "string" },
      name: { kind: "string" },
      description: { kind: "string" },
      category: { kind: "string", nullable: true },
      points: { kind: "number", nullable: true },
      requiredFlags: { kind: "number", optional: true },
      solved: { kind: "boolean" },
      targetSupported: { kind: "boolean" },
      targetCount: { kind: "number" },
      targetInfo: { kind: "string" },
    },
  },
  "challenge.synced": {
    fields: {
      challengeId: { kind: "string" },
      name: { kind: "string", optional: true },
      description: { kind: "string", optional: true },
      category: { kind: "string", nullable: true, optional: true },
      points: { kind: "number", nullable: true, optional: true },
      requiredFlags: { kind: "number", optional: true },
      available: { kind: "boolean", optional: true },
      solved: { kind: "boolean", optional: true },
      targetSupported: { kind: "boolean", optional: true },
      targetCount: { kind: "number", optional: true },
      targetInfo: { kind: "string", optional: true },
      targetIgnored: { kind: "boolean", optional: true },
    },
  },
  "challenge.overridden": {
    fields: { manualSolveState: { kind: "string" } },
  },
  "challenge.solved": { fields: { solvedAt: { kind: "string" } } },
  "challenge.progress_reset": {
    fields: { challengeIds: { kind: "string[]", optional: true } },
  },
  "fence.blocked": {
    fields: {
      code: { kind: "string" },
      message: { kind: "string" },
      via: { kind: "string" },
    },
  },
  "channel.posted": {
    fields: {
      channelKey: { kind: "string" },
      messageId: { kind: "number" },
      authorType: { kind: "string" },
      authorAgentId: { kind: "string", optional: true },
      urgent: { kind: "boolean", optional: true },
    },
  },
}

/** Validate a payload against its type's registry entry. Returns the problem
 * description, or null when the payload is well-formed. */
export function validateDomainEventPayload<T extends DomainEventType>(
  type: T,
  payload: DomainEventPayloadOf<T>
): string | null {
  return validateFields(payload, DOMAIN_EVENT_REGISTRY[type].fields)
}

/** The decision-log type set the web view queries (§2.5). Later batches add
 * decision_point.* / plan.* / agent.terminated / watchdog.escalated /
 * boot.recovered. */
export const DECISION_LOG_EVENT_TYPES: DomainEventType[] = [
  "queue.enqueued",
  "queue.launched",
  "queue.item_failed",
  "queue.item_cancelled",
  "queue.item_done",
  "queue.reordered",
  "queue.paused",
  "queue.resumed",
  "queue.item_reset",
  "queue.item_removed",
  "queue.item_edited",
  "queue.items_cleared",
  "fence.blocked",
  "flag.submitted",
  "flag.accepted",
  "flag.rejected",
  "flag.deleted",
  "challenge.imported",
  "challenge.synced",
  "challenge.overridden",
  "challenge.solved",
  "challenge.progress_reset",
]

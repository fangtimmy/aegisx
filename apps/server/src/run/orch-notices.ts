import type { ChannelMessageMeta } from "@aegisx/shared/channels"

import type { Principal } from "../infrastructure/agent-auth"
import { NOTICE_TEMPLATE_DEFAULTS } from "../orchestration/prompt-defaults"
import { renderTemplateBody } from "../orchestration/prompt-templates"
import { orchKey, teamKey, type PostInput } from "./channels-context"

/** The system → scheduler/team notification protocol, as typed events.
 *
 * The system tells the scheduler (and, on a solve, the challenge's #team) what
 * happened; the scheduler is an LLM reading channel messages, so the protocol
 * is a channel post. This module owns the event vocabulary, the delivery
 * contract (channel / meta / urgency) and the rendering — nothing else. Call
 * sites construct facts, never prose: the wording lives in the notice
 * templates (`orchestration/prompt-defaults.ts`), seeded into the
 * `prompt_templates` store so a user edit takes effect on the next notice.
 *
 * The delivery contract is load-bearing and must not drift: orch deliveries are
 * dropped for a paused scheduler, `meta.agentId` carries the submitter so
 * `channels-delivery.ts` skips its own notice, and `meta.noticeType` /
 * `meta.urgent` decide the ⚠ prefix and the immediate wake. */

/** Template key of one notice. */
type NoticeTemplateKey = keyof typeof NOTICE_TEMPLATE_DEFAULTS

type FlagAcceptedCommon = {
  type: "flagAccepted"
  eventId: string
  challengeId: string
  challengeName: string
  /** The accepted flag value (absent when the platform reports none). */
  flag?: string
  /** The submitter, carried into meta so delivery skips its own notice. */
  submitterAgentId?: string
}

export type NoticeEvent =
  /** The challenge's initial solve. `stopSiblings` false means siblings were
   * spared, so the #team notice asks them to wrap up. */
  | (FlagAcceptedCommon & { tier: "first"; stopSiblings: boolean })
  /** A new flag value on an already-solved challenge (light notice, no
   * cleanup round). */
  | (FlagAcceptedCommon & { tier: "extra" })
  /** A correct-but-incomplete multi-flag submission — the challenge is NOT
   * fully solved. */
  | (FlagAcceptedCommon & {
      tier: "partial"
      /** The platform's partial-solve message. */
      message: string | null
      /** The challenge's accepted flag values so far. */
      confirmedFlags: string[]
    })
  /** The same partial solve, on the orch face (a non-urgent progress line). */
  | {
      type: "flagPartialProgress"
      eventId: string
      challengeName: string
      message: string | null
    }
  /** Automatic post-solve teardown summary. */
  | {
      type: "solveCleanup"
      eventId: string
      challengeName: string
      /** Sibling agents actually stopped. */
      stopped: number
      /** Queue items cancelled. */
      cancelled: number
    }
  /** The operator's manual challenge stop. */
  | {
      type: "challengeHalt"
      eventId: string
      challengeName: string
      /** Live agents actually closed. */
      closed: number
      cancelled: number
    }
  /** The queue's pending 2→1 edge (urgent). */
  | { type: "queueStarved"; eventId: string; pending: number }
  /** A permanent queue launch failure (urgent). The drainer supplies the
   * challenge name and the bounded error; the template owns the wording. */
  | {
      type: "launchFailed"
      eventId: string
      challengeName: string
      error: string
    }
  /** Queue pause/resume. */
  | {
      type: "queueStateChanged"
      eventId: string
      action: "paused" | "resumed"
      source: "manual" | "scheduler"
    }

/** One channel post derived from a notice event. */
export type NoticeDelivery = {
  /** Derived channel key the notice lands in. */
  channelKey: string
  /** Orch deliveries are gated by the event's scheduler-paused flag; team
   * deliveries are not (the policy gate lives at the call site). */
  channelKind: "team" | "orch"
  template: NoticeTemplateKey
  context: Record<string, unknown>
  meta: ChannelMessageMeta
  /** true only for emergencies (immediate wake). Team deliveries stay false:
   * their urgency follows the event's urgent-team policy inside channels.post. */
  urgent: boolean
}

/** Display label of a submitting agent ("" when unknown). */
function agentLabel(agentId: string | undefined): string {
  return agentId ? `agent-${agentId.slice(0, 8)}` : ""
}

function flagAcceptedDelivery(
  event: Extract<NoticeEvent, { type: "flagAccepted" }>
): NoticeDelivery {
  const delivery = {
    channelKey: teamKey(event.challengeId),
    channelKind: "team" as const,
    meta: {
      eventType: event.tier === "partial" ? "flagPartial" : "flagAccepted",
      ...(event.submitterAgentId ? { agentId: event.submitterAgentId } : {}),
    },
    urgent: false,
  }
  const common = {
    tier: event.tier,
    challengeId: event.challengeId,
    challengeName: event.challengeName,
    flag: event.flag ?? "",
    submitterAgentId: event.submitterAgentId ?? "",
    submitter: agentLabel(event.submitterAgentId),
  }
  if (event.tier === "first") {
    return {
      ...delivery,
      template: "noticeFlagAccepted",
      context: { ...common, stopSiblings: event.stopSiblings },
    }
  }
  if (event.tier === "extra") {
    return {
      ...delivery,
      template: "noticeFlagExtra",
      context: { ...common, stopSiblings: false },
    }
  }
  return {
    ...delivery,
    template: "noticeFlagPartial",
    context: {
      ...common,
      stopSiblings: false,
      message: event.message ?? "",
      confirmed: event.confirmedFlags.join("、") || "（无）",
    },
  }
}

/** The channel deliveries a notice event produces. The orch face carries
 * `noticeType: "notice"`, emergencies `noticeType: "emergency"` + urgent.
 * Pure: rendering and posting are the caller's business. */
export function noticeDeliveries(event: NoticeEvent): NoticeDelivery[] {
  const notice = {
    channelKey: orchKey(event.eventId),
    channelKind: "orch" as const,
    urgent: false,
  }
  switch (event.type) {
    case "flagAccepted":
      return [flagAcceptedDelivery(event)]
    case "flagPartialProgress":
      return [
        {
          ...notice,
          template: "noticeFlagPartialProgress",
          context: {
            challengeName: event.challengeName,
            message: event.message ?? "",
            progress: event.message ?? "多 flag 未集齐",
          },
          meta: { noticeType: "notice" },
        },
      ]
    case "solveCleanup":
      return [
        {
          ...notice,
          template: "noticeSolveCleanup",
          context: {
            challengeName: event.challengeName,
            stopped: event.stopped,
            cancelled: event.cancelled,
          },
          meta: { noticeType: "notice" },
        },
      ]
    case "challengeHalt":
      return [
        {
          ...notice,
          template: "noticeChallengeHalt",
          context: {
            challengeName: event.challengeName,
            closed: event.closed,
            cancelled: event.cancelled,
          },
          meta: { noticeType: "notice" },
        },
      ]
    case "queueStarved":
      return [
        {
          ...notice,
          template: "noticeQueueStarved",
          context: { pending: event.pending },
          meta: { noticeType: "emergency" },
          urgent: true,
        },
      ]
    case "launchFailed":
      return [
        {
          ...notice,
          template: "noticeLaunchFailed",
          context: {
            challengeName: event.challengeName,
            error: event.error,
          },
          meta: { noticeType: "emergency" },
          urgent: true,
        },
      ]
    case "queueStateChanged":
      return [
        {
          ...notice,
          template: "noticeQueueState",
          context: {
            action: event.action === "paused" ? "暂停" : "恢复",
            source: event.source,
            manual: event.source === "manual",
          },
          meta: { noticeType: "notice" },
        },
      ]
  }
  // Unreachable while the union is exhaustive; a new event type must add a case.
  const unhandled: never = event
  return unhandled
}

/** Render one delivery through its (possibly user-edited) template body. */
export function renderNotice(
  delivery: NoticeDelivery,
  templateBody: string
): string {
  return renderTemplateBody(templateBody, delivery.context)
}

export type NoticePublisherDeps = {
  /** Builtin template body for a notice key: the stored (user-editable) row
   * when present, else the shipped default. */
  templateBody(key: NoticeTemplateKey): string
  post(input: PostInput, principal: Principal): void
  /** W3 gate: a paused scheduler receives nothing on its orch channel. */
  isSchedulerPaused(eventId: string): boolean
}

/** Render + post a notice event (system author, truncated nowhere but by the
 * channel body cap). */
export function createNoticePublisher(deps: NoticePublisherDeps) {
  return {
    publish(event: NoticeEvent): void {
      for (const delivery of noticeDeliveries(event)) {
        if (
          delivery.channelKind === "orch" &&
          deps.isSchedulerPaused(event.eventId)
        ) {
          continue
        }
        deps.post(
          {
            channelKey: delivery.channelKey,
            author: { type: "system" },
            body: renderNotice(delivery, deps.templateBody(delivery.template)),
            meta: delivery.meta,
            urgent: delivery.urgent,
          },
          { kind: "system" }
        )
      }
    },
  }
}

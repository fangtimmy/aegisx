import { describe, expect, test } from "bun:test"

import { and, eq } from "drizzle-orm"

import { promptTemplates } from "../../src/db/schema"
import type { Principal } from "../../src/infrastructure/agent-auth"
import { NOTICE_TEMPLATE_DEFAULTS } from "../../src/orchestration/prompt-defaults"
import {
  BUILTIN_DEFAULTS,
  loadTemplateMap,
  seedBuiltinTemplates,
} from "../../src/orchestration/prompt-templates"
import type { PostInput } from "../../src/run/channels-context"
import {
  createNoticePublisher,
  noticeDeliveries,
  renderNotice,
  type NoticeEvent,
} from "../../src/run/orch-notices"
import { setupDb } from "../helpers"

/** Default-template render of an event's deliveries — the shipped wording. */
function text(event: NoticeEvent): string[] {
  return noticeDeliveries(event).map((delivery) =>
    renderNotice(delivery, NOTICE_TEMPLATE_DEFAULTS[delivery.template])
  )
}

const SUBMITTER = "abcdef12-3456-7890-abcd-ef1234567890"

const first = (
  overrides: Partial<Extract<NoticeEvent, { tier: "first" }>> = {}
): NoticeEvent => ({
  type: "flagAccepted",
  tier: "first",
  eventId: "evt-1",
  challengeId: "ch-1",
  challengeName: "web1",
  stopSiblings: true,
  ...overrides,
})

const cleanup = (stopped: number, cancelled: number): NoticeEvent => ({
  type: "solveCleanup",
  eventId: "evt-1",
  challengeName: "web1",
  stopped,
  cancelled,
})

const halt = (closed: number, cancelled: number): NoticeEvent => ({
  type: "challengeHalt",
  eventId: "evt-1",
  challengeName: "web1",
  closed,
  cancelled,
})

const queueState = (
  action: "paused" | "resumed",
  source: "manual" | "scheduler"
): NoticeEvent => ({
  type: "queueStateChanged",
  eventId: "evt-1",
  action,
  source,
})

/** A publisher whose posts land in a recording array. */
function makePublisher(opts: { paused?: boolean; template?: string } = {}) {
  const posts: Array<{ input: PostInput; principal: Principal }> = []
  const publisher = createNoticePublisher({
    templateBody: (key) => opts.template ?? NOTICE_TEMPLATE_DEFAULTS[key],
    post: (input, principal) => posts.push({ input, principal }),
    isSchedulerPaused: () => opts.paused ?? false,
  })
  return { publisher, posts }
}

describe("notice events render the shipped wording (byte-level)", () => {
  test("flagAccepted / first: flag + submitter, siblings stopped", () => {
    expect(
      text(first({ flag: "flag{x}", submitterAgentId: SUBMITTER }))
    ).toEqual([
      "「web1」已完全解出：flag{x}（agent-abcdef12 提交），平台已接受。",
    ])
  })

  test("flagAccepted / first: siblings survive → the wrap-up tail", () => {
    expect(text(first({ stopSiblings: false }))).toEqual([
      "「web1」已完全解出，平台已接受。 本题无需继续攻击，请整理 writeup 并尽快 finish_run 收尾。",
    ])
  })

  test("flagAccepted / extra", () => {
    expect(
      text({
        type: "flagAccepted",
        tier: "extra",
        eventId: "evt-1",
        challengeId: "ch-1",
        challengeName: "web1",
        flag: "flag{y}",
      })
    ).toEqual(["「web1」再解出一个 flag：flag{y}。"])
    expect(
      text({
        type: "flagAccepted",
        tier: "extra",
        eventId: "evt-1",
        challengeId: "ch-1",
        challengeName: "web1",
        submitterAgentId: SUBMITTER,
      })
    ).toEqual(["「web1」再解出一个 flag（agent-abcdef12 提交）。"])
  })

  test("flagAccepted / partial: message + confirmed flags", () => {
    expect(
      text({
        type: "flagAccepted",
        tier: "partial",
        eventId: "evt-1",
        challengeId: "ch-1",
        challengeName: "web1",
        message: "flag 2/3 已确认（+10 分）",
        confirmedFlags: ["flag{a}", "flag{b}"],
        submitterAgentId: SUBMITTER,
      })
    ).toEqual([
      "多 flag 进度：「web1」部分解出（flag 2/3 已确认（+10 分））。已确认：flag{a}、flag{b}。请专注剩余 flag；已确认的无需重复提交。",
    ])
  })

  test("flagAccepted / partial: no message, no confirmed flags", () => {
    expect(
      text({
        type: "flagAccepted",
        tier: "partial",
        eventId: "evt-1",
        challengeId: "ch-1",
        challengeName: "web1",
        message: null,
        confirmedFlags: [],
      })
    ).toEqual([
      "多 flag 进度：「web1」部分解出。已确认：（无）。请专注剩余 flag；已确认的无需重复提交。",
    ])
  })

  test("flagPartialProgress: the orch face", () => {
    expect(
      text({
        type: "flagPartialProgress",
        eventId: "evt-1",
        challengeName: "web1",
        message: "flag 1/3",
      })
    ).toEqual(["部分解出：「web1」flag 1/3"])
    expect(
      text({
        type: "flagPartialProgress",
        eventId: "evt-1",
        challengeName: "web1",
        message: null,
      })
    ).toEqual(["部分解出：「web1」多 flag 未集齐"])
  })

  test("solveCleanup: only the parts that actually happened", () => {
    expect(text(cleanup(2, 1))).toEqual([
      "「web1」已完全解出：已停止 2 个同题 agent；已取消 1 个排队项",
    ])
    expect(text(cleanup(3, 0))).toEqual([
      "「web1」已完全解出：已停止 3 个同题 agent",
    ])
    expect(text(cleanup(0, 1))).toEqual([
      "「web1」已完全解出：已取消 1 个排队项",
    ])
  })

  test("challengeHalt: only the parts that actually happened", () => {
    expect(text(halt(3, 0))).toEqual([
      "「web1」已被操作员手动停止：已关闭 3 个 agent",
    ])
    expect(text(halt(0, 2))).toEqual([
      "「web1」已被操作员手动停止：已取消 2 个排队项",
    ])
    expect(text(halt(1, 1))).toEqual([
      "「web1」已被操作员手动停止：已关闭 1 个 agent；已取消 1 个排队项",
    ])
  })

  test("queueStarved and launchFailed", () => {
    expect(
      text({ type: "queueStarved", eventId: "evt-1", pending: 1 })
    ).toEqual(["队列不足：仅剩 1 项排队"])
    expect(
      text({
        type: "launchFailed",
        eventId: "evt-1",
        challengeName: "web1",
        error: "boom",
      })
    ).toEqual(["启动失败：「web1」— boom"])
  })

  test("queueStateChanged: pause/resume, manual flips marked", () => {
    expect(text(queueState("paused", "manual"))).toEqual([
      "队列已暂停（用户手动）",
    ])
    expect(text(queueState("paused", "scheduler"))).toEqual(["队列已暂停"])
    expect(text(queueState("resumed", "manual"))).toEqual([
      "队列已恢复（用户手动）",
    ])
    expect(text(queueState("resumed", "scheduler"))).toEqual(["队列已恢复"])
  })
})

describe("notice delivery contract (channel / meta / urgent)", () => {
  test("flag notices land in the challenge's #team; the submitter rides in meta", () => {
    const withSubmitter = noticeDeliveries(
      first({ submitterAgentId: SUBMITTER })
    )[0]
    expect(withSubmitter.channelKey).toBe("team:ch-1")
    expect(withSubmitter.channelKind).toBe("team")
    expect(withSubmitter.meta).toEqual({
      eventType: "flagAccepted",
      agentId: SUBMITTER,
    })
    expect(withSubmitter.urgent).toBe(false)

    expect(noticeDeliveries(first())[0].meta).toEqual({
      eventType: "flagAccepted",
    })
  })

  test("partial carries eventType flagPartial (delivery self-skip by agentId)", () => {
    const delivery = noticeDeliveries({
      type: "flagAccepted",
      tier: "partial",
      eventId: "evt-1",
      challengeId: "ch-1",
      challengeName: "web1",
      message: null,
      confirmedFlags: [],
      submitterAgentId: SUBMITTER,
    })[0]
    expect(delivery.meta).toEqual({
      eventType: "flagPartial",
      agentId: SUBMITTER,
    })
    expect(delivery.urgent).toBe(false)
  })

  test("orch notices are non-urgent noticeType:notice", () => {
    const orchEvents: NoticeEvent[] = [
      {
        type: "flagPartialProgress",
        eventId: "evt-1",
        challengeName: "web1",
        message: null,
      },
      {
        type: "solveCleanup",
        eventId: "evt-1",
        challengeName: "web1",
        stopped: 1,
        cancelled: 0,
      },
      {
        type: "challengeHalt",
        eventId: "evt-1",
        challengeName: "web1",
        closed: 1,
        cancelled: 0,
      },
      {
        type: "queueStateChanged",
        eventId: "evt-1",
        action: "paused",
        source: "manual",
      },
    ]
    for (const event of orchEvents) {
      const delivery = noticeDeliveries(event)[0]
      expect(delivery.channelKey).toBe("orch:evt-1")
      expect(delivery.channelKind).toBe("orch")
      expect(delivery.meta).toEqual({ noticeType: "notice" })
      expect(delivery.urgent).toBe(false)
    }
  })

  test("emergencies are urgent noticeType:emergency", () => {
    const emergencies: NoticeEvent[] = [
      { type: "queueStarved", eventId: "evt-1", pending: 1 },
      {
        type: "launchFailed",
        eventId: "evt-1",
        challengeName: "web1",
        error: "x",
      },
    ]
    for (const event of emergencies) {
      const delivery = noticeDeliveries(event)[0]
      expect(delivery.channelKey).toBe("orch:evt-1")
      expect(delivery.meta).toEqual({ noticeType: "emergency" })
      expect(delivery.urgent).toBe(true)
    }
  })
})

describe("notice publisher", () => {
  test("posts as the system author with the rendered body", () => {
    const { publisher, posts } = makePublisher()
    publisher.publish(first({ flag: "flag{x}", submitterAgentId: SUBMITTER }))
    expect(posts).toHaveLength(1)
    expect(posts[0].input.channelKey).toBe("team:ch-1")
    expect(posts[0].input.author).toEqual({ type: "system" })
    expect(posts[0].input.body).toBe(
      "「web1」已完全解出：flag{x}（agent-abcdef12 提交），平台已接受。"
    )
    expect(posts[0].input.urgent).toBe(false)
    expect(posts[0].principal).toEqual({ kind: "system" })
  })

  test("renders through the injected template body (user edits win)", () => {
    const { publisher, posts } = makePublisher({
      template: "自定义：{{challengeName}}",
    })
    publisher.publish(first())
    expect(posts[0].input.body).toBe("自定义：web1")
  })

  test("a paused scheduler drops orch notices but not #team ones", () => {
    const { publisher, posts } = makePublisher({ paused: true })
    publisher.publish(cleanup(1, 0))
    publisher.publish({ type: "queueStarved", eventId: "evt-1", pending: 1 })
    expect(posts).toHaveLength(0)
    // Team notices are not gated by the scheduler pause.
    publisher.publish(first({ stopSiblings: false }))
    expect(posts).toHaveLength(1)
    expect(posts[0].input.channelKey).toBe("team:ch-1")
  })
})

describe("notice templates are user-editable builtin rows", () => {
  test("every notice default is seeded; a stored edit changes the notice text", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      const map = loadTemplateMap(db)
      for (const [key, body] of Object.entries(NOTICE_TEMPLATE_DEFAULTS)) {
        expect(BUILTIN_DEFAULTS[key]).toBe(body)
        expect(map.get(key)).toBe(body)
      }
      db.update(promptTemplates)
        .set({ body: "队列已{{action}}（自定义）", updatedAt: "x" })
        .where(
          and(
            eq(promptTemplates.plugin, "builtin"),
            eq(promptTemplates.key, "noticeQueueState")
          )
        )
        .run()
      const posts: PostInput[] = []
      const publisher = createNoticePublisher({
        templateBody: (key) =>
          loadTemplateMap(db).get(key) ?? NOTICE_TEMPLATE_DEFAULTS[key],
        post: (input) => posts.push(input),
        isSchedulerPaused: () => false,
      })
      publisher.publish({
        type: "queueStateChanged",
        eventId: "evt-1",
        action: "paused",
        source: "scheduler",
      })
      expect(posts[0].body).toBe("队列已暂停（自定义）")
    } finally {
      close()
    }
  })
})

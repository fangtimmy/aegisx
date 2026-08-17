import { get, type FlatSettings } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  channelMessages,
  challenges,
  runs,
  runQueue,
} from "../db/schema"
import type { EventScopePayload } from "../orchestration/types"
import type { ChannelMessagePublic, ChannelService } from "./channels"

/** 时间格式化（digest 与 SDK `fmt_ms` 共用格式约定）：
 *  3500 → "4s"；210000 → "3m30s"；-45000 → "-45s(超时)"。 */
export function fmtMs(ms: number): string {
  if (ms < 0) return `-${fmtMs(-ms)}(超时)`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const rem = m % 60
    return rem === 0 ? `${h}h` : `${h}h${rem}m`
  }
  return s === 0 ? `${m}m` : `${m}m${s}s`
}

/** 静默 flush 间隔：距最后一条入队消息无新消息多久后结算一轮。 */
const SILENCE_MS = 5 * 60_000
/** digest run 行上限（超出折叠为「…另有 N 个 run 事件」）。 */
const MAX_RUN_LINES = 20
/** active run 停滞判定（最近活动超过该值标 ⚠）。 */
const STALL_MS = 25 * 60_000
/** deadline 临近判定（剩余少于该值标 ⚠）。 */
const DEADLINE_NEAR_MS = 10 * 60_000
/** agent 停滞判定：turn settle 后超过该时长仍 idle/failed → 紧急 flush。 */
const AGENT_STALL_MS = 2 * 60_000

export type SchedulerDigestDeps = {
  eventId: string
  /** flush 时 digest 的投递目标（事件作用域的 orchestrator agent）。 */
  orchestratorAgentId: string
  db: Database
  getSettings(): FlatSettings
  /** Channel core — the digest posts to / reads the scheduler DM channel. */
  channels: ChannelService
  /** 投递 digest（steer；fire-and-forget，错误吞掉）。 */
  send(text: string): void
  now(): string
  /** 调度器暂停时队列紧急/通知静默（run 事件已在 emitRunEvent 丢弃）。 */
  isPaused(): boolean
  /** 测试 seam：静默 flush 间隔。 */
  silenceMs?: number
  /** 测试 seam：agent 停滞判定间隔。 */
  stallMs?: number
}

export type SchedulerDigest = ReturnType<typeof createSchedulerDigest>

/**
 * 调度者 DM 的 digest 投递策略（docs/im-channels.md §三 — 吸收并取代
 * scheduler-inbox 的存储层；策略语义全部保留）。
 *
 * - 一切消息（6 生命周期事件 / 队列紧急 / 通知 / solver ask / 用户发帖）
 *   即时落 `DM: scheduler`（先持久化再聚合——crash 不丢积压）。
 * - 紧急（timedOut / 队列不足 / 启动失败 / agent 停滞 / ask(urgent) / 用户
 *   发帖）立即 flush（捎带已积压）；否则静默 5min 计时（新消息刷新）。
 * - flush = 渲染未读 + 现查状态快照 → steer → **渲染结果作为 kind=recap
 *   消息存回频道** → 游标推进（recap 即投递历史，事件流与摘要并排）。
 * - 生命周期与 EventScopeEmitter 同步（scheduler run teardown / service
 *   close 时 `close()` 只清计时器——消息在 DB，重启后未读自动 catch-up）。
 */
export function createSchedulerDigest(deps: SchedulerDigestDeps) {
  const { db, getSettings, channels } = deps
  const silenceMs = deps.silenceMs ?? SILENCE_MS
  const stallMs = deps.stallMs ?? AGENT_STALL_MS
  /** runId → 停滞检查计时器：agent settle 后 arm，到点现查该 run 是否
   * 仍有 idle/failed agent（距今 ≥ stallMs）→ 紧急 flush。每个 idle 周期
   * 只触发一次（再次 settle 重新 arm）。 */
  const stallTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dueAt: number }
  >()
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 静默计时器预定 flush 时刻（epoch ms；null = 未 arm）。 */
  let timerDueAt: number | null = null
  /** 投递暂停（用户手动）：只静默收集，不投递——调度者保持 idle。 */
  let deliveryPaused = false

  function dmChannelId(): string {
    const channel = channels.schedulerDm(deps.eventId)
    if (!channel) {
      throw new Error(`scheduler DM channel missing for event ${deps.eventId}`)
    }
    return channel.id
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    timerDueAt = null
  }

  /** 静默计时器：从最后一条入队消息起算，新消息刷新。 */
  function armTimer(): void {
    clearTimer()
    timerDueAt = Date.now() + silenceMs
    timer = setTimeout(() => {
      timer = null
      timerDueAt = null
      flush()
    }, silenceMs)
  }

  /** 事件显示名（digest 行的事件序列元素）。 */
  function eventName(p: EventScopePayload): string {
    switch (p.type) {
      case "run.started":
        return p.source === "manual" ? "started(手动)" : "started"
      case "run.idle":
        return p.failed ? "idle(failed)" : "idle"
      case "run.flagAccepted":
        return "flagAccepted"
      case "run.finished":
        return "finished"
      case "run.timedOut":
        return `timedOut(${p.outcome})`
      case "run.resumed":
        return "resumed"
    }
  }

  // --- posting (persist-first) ---------------------------------------------

  /** 生命周期事件 → system 消息（meta 带 runId/eventType）。 */
  function push(payload: EventScopePayload): void {
    channels.post({
      channelId: dmChannelId(),
      author: { type: "system" },
      body: eventName(payload),
      meta: { runId: payload.runId, eventType: payload.type },
    })
  }

  /** 队列紧急事件（不足 / 启动失败）：入紧急行（urgent）——立即 flush。
   *  W3 paused 时静默丢弃（同旧收件箱语义）。 */
  function pushEmergency(line: string): void {
    if (deps.isPaused()) return
    channels.post({
      channelId: dmChannelId(),
      author: { type: "system" },
      body: line,
      meta: { noticeType: "emergency", urgent: true },
    })
  }

  /** 普通通知行（队列 pause/resume 等）：随下一次 flush 投递，不单独触发。 */
  function pushNotice(line: string): void {
    if (deps.isPaused()) return
    channels.post({
      channelId: dmChannelId(),
      author: { type: "system" },
      body: line,
      meta: { noticeType: "notice" },
    })
  }

  /** 新消息落库后的策略入口（由 channel service 回调；覆盖一切写入方）。 */
  function onMessage(message: ChannelMessagePublic): void {
    if (message.kind === "recap") return
    if (deliveryPaused) return
    const urgent =
      message.authorType === "user" ||
      message.meta.urgent === true ||
      message.meta.eventType === "run.timedOut"
    if (urgent) flush()
    else armTimer()
  }

  // --- unread ----------------------------------------------------------------

  function unread(): ChannelMessagePublic[] {
    const channel = channels.schedulerDm(deps.eventId)
    if (!channel) return []
    const { items } = channels.listMessages(channel.id, {
      // stable scheduler cursor key — survives scheduler restarts/crashes
      after: channels.readCursor(channel.id, "scheduler"),
      limit: 200,
    })
    return items.filter((item) => item.kind !== "recap")
  }

  // --- digest rendering --------------------------------------------------------

  /** 现查 challenge 名。 */
  function challengeName(challengeId: string | null): string {
    if (!challengeId) return ""
    return (
      db
        .select({ name: challenges.name })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()?.name ?? ""
    )
  }

  /** 单 run digest 行的时间列（flush 时现查，静态快照）。 */
  function renderRunLine(row: typeof runs.$inferSelect, nowMs: number): string {
    const status = row.status
    const parts: string[] = []
    const warnings: string[] = []
    const lastActivity = nowMs - Date.parse(row.updatedAt)
    if (status === "closed") {
      parts.push("closed")
      if (row.startedAt) {
        const endMs = row.completedAt ? Date.parse(row.completedAt) : nowMs
        parts.push(`耗时 ${fmtMs(endMs - Date.parse(row.startedAt))}`)
      }
      return parts.join(" | ")
    }
    if (status === "running") {
      parts.push(
        row.startedAt
          ? `running ${fmtMs(nowMs - Date.parse(row.startedAt))}`
          : "running"
      )
      parts.push(`最近活动 ${fmtMs(lastActivity)}`)
    } else {
      parts.push(`idle ${fmtMs(lastActivity)}`)
    }
    if (row.deadlineAt) {
      const remain = Date.parse(row.deadlineAt) - nowMs
      if (remain >= 0) {
        parts.push(`deadline剩 ${fmtMs(remain)}`)
        if (remain < DEADLINE_NEAR_MS) warnings.push("⚠ 临近deadline")
      } else {
        parts.push(`deadline超 ${fmtMs(-remain)}`)
      }
    }
    if (lastActivity > STALL_MS) warnings.push("⚠ 停滞")
    return [...parts, ...warnings].join(" | ")
  }

  /** 组装 digest 文本：未读消息 + 现查状态快照（总有 header + 统计行）。 */
  function buildDigest(items: ChannelMessagePublic[]): string {
    const nowMs = Date.now()
    const clock = new Date(nowMs)
    const hh = String(clock.getHours()).padStart(2, "0")
    const mm = String(clock.getMinutes()).padStart(2, "0")
    const ss = String(clock.getSeconds()).padStart(2, "0")
    const out: string[] = [`[调度事件摘要 now=${hh}:${mm}:${ss}]`]

    // Run 行：同 run 生命周期事件合并为一行（事件序列 + 现查时间列）。
    const runEvents = new Map<string, string[]>()
    const lines: string[] = []
    for (const item of items) {
      const runId = typeof item.meta.runId === "string" ? item.meta.runId : null
      const eventType =
        typeof item.meta.eventType === "string" ? item.meta.eventType : ""
      if (runId && eventType.startsWith("run.")) {
        const list = runEvents.get(runId) ?? []
        list.push(item.body)
        runEvents.set(runId, list)
        continue
      }
      if (item.meta.noticeType === "emergency") {
        lines.push(`⚠ ${item.body}`)
        continue
      }
      if (item.authorType === "agent") {
        // v17 §11.4: authorName snapshots carry the run trace
        // (`Solver 2 · run-a3f1`) on every agent post path — the digest
        // renders it as-is (single attribution source).
        lines.push(`问询 ${item.authorName}：${item.body}`)
        continue
      }
      if (item.authorType === "user") {
        lines.push(`用户：${item.body}`)
        continue
      }
      lines.push(item.body) // plain notice
    }

    const rendered: Array<[string, string, string]> = []
    for (const [runId, events] of runEvents) {
      const row = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (!row) continue
      rendered.push([
        `run-${runId.slice(0, 8)}`,
        challengeName(row.challengeId),
        `${events.join("→")} | ${renderRunLine(row, nowMs)}`,
      ])
    }
    const idWidth = Math.max(0, ...rendered.map((r) => r[0].length))
    const nameWidth = Math.max(0, ...rendered.map((r) => r[1].length))
    const overflow = rendered.length - MAX_RUN_LINES
    const shown = overflow > 0 ? rendered.slice(0, MAX_RUN_LINES) : rendered
    for (const [shortId, name, rest] of shown) {
      out.push(
        `${shortId.padEnd(idWidth)} | ${name.padEnd(nameWidth)} | ${rest}`
      )
    }
    if (overflow > 0) out.push(`…另有 ${overflow} 个 run 事件`)

    for (const line of lines) out.push(line)

    // 统计行：active X/cap · pending Y。
    const active = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.eventId, deps.eventId),
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .all().length
    const cap = get(getSettings(), "scheduler.maxConcurrentRuns")
    const pending = db
      .select({ id: runQueue.id })
      .from(runQueue)
      .where(
        and(eq(runQueue.eventId, deps.eventId), eq(runQueue.status, "pending"))
      )
      .all().length
    out.push(`active ${active}/${cap} · pending ${pending}`)
    return out.join("\n")
  }

  /** 一次性结算：渲染未读 + 状态快照 → steer → recap 存回频道 → 游标推进。 */
  function flush(): void {
    clearTimer()
    const items = unread()
    if (items.length === 0) return
    const digest = buildDigest(items)
    deps.send(digest)
    const channel = channels.schedulerDm(deps.eventId)
    if (!channel) return
    // Store the rendered digest back as a recap message (delivery history,
    // self-contained channel ledger), then advance the stable scheduler
    // cursor past it — the recap itself never re-flushes.
    const inserted = db
      .insert(channelMessages)
      .values({
        channelId: channel.id,
        kind: "recap",
        authorType: "system",
        authorAgentId: null,
        authorName: "system",
        body: digest,
        meta: "{}",
        createdAt: deps.now(),
      })
      .returning()
      .get()
    channels.advanceSchedulerCursor(channel, inserted.id)
  }

  // --- stall watchdog -----------------------------------------------------------

  /** agent turn settle：arm 该 run 的停滞检查计时器（fire 时现查，竞态
   *  安全——中途 resumed/finished 由 DB 现状裁决）。paused 时不 arm。 */
  function noteAgentIdle(runId: string): void {
    if (deps.isPaused() || deliveryPaused) return
    clearStallTimer(runId)
    const dueAt = Date.now() + stallMs
    const timer = setTimeout(() => {
      stallTimers.delete(runId)
      checkStall(runId)
    }, stallMs)
    stallTimers.set(runId, { timer, dueAt })
  }

  function clearStallTimer(runId: string): void {
    const entry = stallTimers.get(runId)
    if (entry) {
      clearTimeout(entry.timer)
      stallTimers.delete(runId)
    }
  }

  /** 停滞计时器到点：现查该 run，仍有 idle/failed agent 且距今 ≥
   *  stallMs → 紧急行 + flush；否则静默。finishing 的 run 不发假紧急。 */
  function checkStall(runId: string): void {
    if (deps.isPaused() || deliveryPaused) return
    const row = db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!row || row.status === "closed" || row.finishing) return
    const nowMs = Date.now()
    const stalled = db
      .select()
      .from(agents)
      .where(
        and(eq(agents.runId, runId), inArray(agents.status, ["idle", "failed"]))
      )
      .all()
      .filter((agent) => nowMs - Date.parse(agent.updatedAt) >= stallMs)
    if (!stalled.length) return
    const detail = stalled
      .map(
        (agent) =>
          `${agent.name ?? agent.slot} idle ${fmtMs(nowMs - Date.parse(agent.updatedAt))}`
      )
      .join("、")
    pushEmergency(`agent 停滞：run-${runId.slice(0, 8)} ${detail}`)
  }

  // --- hold (delivery pause) ------------------------------------------------------

  /** 投递暂停/恢复（用户手动，仅 HTTP/UI）。暂停：停止 arm 一切计时器，
   *  只静默收集；恢复：对 live run 重新 arm 停滞检查（catch-up），再一次性
   *  补投积压。 */
  function setDeliveryPaused(paused: boolean): void {
    if (deliveryPaused === paused) return
    deliveryPaused = paused
    if (paused) {
      clearTimer()
      for (const { timer } of stallTimers.values()) clearTimeout(timer)
      stallTimers.clear()
      return
    }
    armStallCatchUp()
    if (unread().length > 0) flush()
  }

  /** 恢复补投的停滞 catch-up：live challenge run 中有已 settle agent 的
   *  重新 arm 停滞检查（从恢复时刻起算）。 */
  function armStallCatchUp(): void {
    const live = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.eventId, deps.eventId),
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .all()
    for (const run of live) {
      const settled = db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.runId, run.id),
            inArray(agents.status, ["idle", "failed"])
          )
        )
        .get()
      if (settled) noteAgentIdle(run.id)
    }
  }

  /** 清空计时器（scheduler run teardown / service close）。消息已持久化，
   *  重启后未读由新 digest 实例 catch-up（创建时 arm）。 */
  function close(): void {
    clearTimer()
    for (const { timer } of stallTimers.values()) clearTimeout(timer)
    stallTimers.clear()
    deliveryPaused = false
  }

  /** 只读实时快照（调度者 DM 视图状态头）：未读积压（按来源分组）+
   *  计时器状态。 */
  function snapshot() {
    const items = unread()
    const pending = new Map<string, string[]>()
    const notices: string[] = []
    const emergency: string[] = []
    for (const item of items) {
      const runId = typeof item.meta.runId === "string" ? item.meta.runId : null
      const eventType =
        typeof item.meta.eventType === "string" ? item.meta.eventType : ""
      if (runId && eventType.startsWith("run.")) {
        const list = pending.get(runId) ?? []
        list.push(item.body)
        pending.set(runId, list)
      } else if (item.meta.noticeType === "emergency") {
        emergency.push(item.body)
      } else if (item.meta.noticeType === "notice") {
        notices.push(item.body)
      } else {
        notices.push(
          `${item.authorName}${runId ? `（run-${runId.slice(0, 8)}）` : ""}：${item.body}`
        )
      }
    }
    return {
      deliveryPaused,
      unreadCount: items.length,
      pending: [...pending.entries()].map(([runId, events]) => ({
        runId,
        events: [...events],
      })),
      notices: [...notices],
      emergency: [...emergency],
      silence: { armed: timer !== null, flushAt: timerDueAt },
      stallWatch: [...stallTimers.entries()].map(([runId, { dueAt }]) => ({
        runId,
        dueAt,
      })),
    }
  }

  // Catch-up on creation: unflushed unread (e.g. crash between persist and
  // flush, or messages that landed while the scheduler was down) arms the
  // silence timer so the backlog eventually settles.
  if (unread().length > 0) armTimer()

  return {
    push,
    pushEmergency,
    pushNotice,
    onMessage,
    noteAgentIdle,
    setDeliveryPaused,
    close,
    snapshot,
  }
}

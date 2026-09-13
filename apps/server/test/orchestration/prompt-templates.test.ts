import { describe, expect, test } from "bun:test"

import {
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
  NOTICE_TEMPLATE_DEFAULTS,
} from "../../src/orchestration/prompt-defaults"
import {
  NOTICE_TEMPLATE_VARIABLES,
  PROMPT_TEMPLATES,
  previewOrchestratorSystemPrompt,
  previewPromptTemplate,
  renderTemplateBody,
  sampleNoticeContext,
  sampleOrchestratorPromptContext,
  samplePromptContext,
} from "../../src/orchestration/prompt-templates"
import { DEFAULT_TIMEOUT_SEC, MAX_BYTES } from "../../src/run/bash-tool"
import { FLUSH_INTERVAL_MS } from "../../src/run/channels-context"
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
} from "../../src/run/channels-post"
import {
  noticeDeliveries,
  renderNotice,
  type NoticeEvent,
} from "../../src/run/orch-notices"

const highlightedText = (segments: { highlighted: boolean; text: string }[]) =>
  segments.filter((s) => s.highlighted).map((s) => s.text)

describe("W1 prompt fixes", () => {
  test("initial renders Challenge/Environment + a Strategy section when strategy is injected (W1.1)", () => {
    const rendered = renderTemplateBody(DEFAULT_INITIAL_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      strategy: "Focus on the attachment's crypto; try z3 first.",
    })
    // The standard blocks are always present — the strategy is appended, not
    // a whole-prompt replacement.
    expect(rendered).toContain("## Challenge")
    expect(rendered).toContain("## Environment")
    expect(rendered).toContain("## Strategy")
    expect(rendered).toContain(
      "Focus on the attachment's crypto; try z3 first."
    )
  })

  test("initial renders WITHOUT a Strategy section when no strategy is injected", () => {
    const rendered = renderTemplateBody(
      DEFAULT_INITIAL_PROMPT_TEMPLATE,
      samplePromptContext
    )
    expect(rendered).toContain("## Challenge")
    expect(rendered).toContain("## Environment")
    expect(rendered).not.toContain("## Strategy")
  })

  test("mainSystem carries the ENVIRONMENT.md quick-reference (W1.2)", () => {
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain(
      "/opt/solver/ENVIRONMENT.md"
    )
    const main = renderTemplateBody(
      DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
      samplePromptContext
    )
    expect(main).toContain("/opt/solver/ENVIRONMENT.md")
    expect(main).toContain("/opt/solver/knowledges")
  })

  test("mainSystem renders the Channels section for every solver agent (v19)", () => {
    const main = renderTemplateBody(
      DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
      samplePromptContext
    )
    // The channel layer is rendered for every solver agent. The prompt keeps
    // the behavioral rules plus a copy-verbatim quick start whose inline
    // signatures are drift-guarded against GUIDE.md below.
    expect(main).toContain("## Channels（团队频道）")
    expect(main).not.toContain("## Co-solvers")
    expect(main).toContain("/opt/aegisx-sdk/GUIDE.md")
    expect(main).toContain("aegisx.ask")
    expect(main).toContain("urgent=True")
    expect(main).toContain("ends YOUR task")
  })

  test("initial renders the v19 workspace layout (agent dir + shared + attachments + siblings)", () => {
    const rendered = renderTemplateBody(
      DEFAULT_INITIAL_PROMPT_TEMPLATE,
      samplePromptContext
    )
    expect(rendered).toContain("/workspace/agents/a3f1c2d9")
    expect(rendered).toContain("/workspace/attachments/")
    expect(rendered).toContain("/workspace/shared/")
    expect(rendered).toContain(
      "Sibling agents' directories: /workspace/agents/"
    )
    expect(rendered).toContain("End your own task with the `finish_run` tool")
  })
})

describe("prompt drift control (env facts live in ENVIRONMENT.md, not inline)", () => {
  test("initial points to ENVIRONMENT.md instead of inlining the toolchain", () => {
    const rendered = renderTemplateBody(
      DEFAULT_INITIAL_PROMPT_TEMPLATE,
      samplePromptContext
    )
    expect(rendered).toContain("/opt/solver/ENVIRONMENT.md")
    expect(rendered).not.toContain("libc-database")
  })

  test("mainSystem install guidance routes through ENVIRONMENT.md for both networked and offline environments", () => {
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).not.toContain(
      "install it into the workspace"
    )
    // Networked deployments get the install SOP via ENVIRONMENT.md; offline
    // appliances get the no-installs notice there and in the event hint. The
    // prompt itself must stay environment-agnostic and cover both branches.
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain(
      "/opt/solver/ENVIRONMENT.md"
    )
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain("install SOP")
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain("offline")
  })

  test("initial gates submit/finish on capabilities and carries no brief duplicate", () => {
    const capped = renderTemplateBody(DEFAULT_INITIAL_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      capabilities: {
        canFinish: false,
        canSubmitFlag: false,
        canManageTarget: false,
      },
      event: { ...samplePromptContext.event, brief: "flag{...}" },
    })
    expect(capped).not.toContain("submit_flag")
    expect(capped).not.toContain("finish_run")
    expect(capped).not.toContain("## Event instructions")

    const normal = renderTemplateBody(DEFAULT_INITIAL_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      event: { ...samplePromptContext.event, brief: "flag{...}" },
    })
    expect(normal).toContain("finish_run")
    // Event instructions stay a system-prompt-only block (survives compaction).
    expect(normal).not.toContain("## Event instructions")
  })

  test("mainSystem renders the role-merged brief and structured flag formats", () => {
    const main = renderTemplateBody(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      event: {
        ...samplePromptContext.event,
        brief: "通用约束",
        flagFormats: ["flag{...}", "FLAG{...}"],
      },
    })
    expect(main).toContain("## Event instructions")
    expect(main).toContain("通用约束")
    expect(main).toContain("flag{...} / FLAG{...}")

    const bare = renderTemplateBody(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      event: { ...samplePromptContext.event, brief: "", flagFormats: [] },
    })
    expect(bare).not.toContain("## Event instructions")
    expect(bare).toContain(
      "Extract the flag format from the challenge description"
    )
  })

  test("initial frames the attempt's wall-clock budget without inviting clock polling", () => {
    const withBudget = renderTemplateBody(
      DEFAULT_INITIAL_PROMPT_TEMPLATE,
      samplePromptContext
    )
    expect(withBudget).toContain("45 minutes")
    expect(withBudget).toContain("do NOT poll the clock")

    const bare = renderTemplateBody(DEFAULT_INITIAL_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      timeoutMinutes: undefined,
    })
    expect(bare).not.toContain("Budget:")
  })
})

describe("prompt preview", () => {
  test("highlights interpolated variable values", () => {
    const segments = previewPromptTemplate(
      "Solve {{challenge.name}} ({{challenge.category}})",
      samplePromptContext
    )
    expect(highlightedText(segments)).toContain("Encrypted Notes")
    expect(highlightedText(segments)).toContain("web")
  })

  test("marks bare true/false tokens as highlighted even outside variables", () => {
    const segments = previewPromptTemplate(
      "Submit: {{capabilities.canSubmitFlag}} finish: {{capabilities.canFinish}}",
      samplePromptContext
    )
    // booleans are not marker-wrapped by markPreviewValues, but previewSegments
    // splits bare true/false tokens out and highlights them.
    expect(highlightedText(segments)).toContain("true")
  })

  test("returns a single non-highlighted segment for static text", () => {
    const segments = previewPromptTemplate("Static text", samplePromptContext)
    expect(segments).toHaveLength(1)
    expect(segments[0].highlighted).toBe(false)
  })

  test("initial prompt preview mirrors system prompt segmentation", () => {
    const segments = previewPromptTemplate(
      "Begin {{challenge.name}}",
      samplePromptContext
    )
    expect(
      segments.some((s) => s.highlighted && s.text === "Encrypted Notes")
    ).toBe(true)
  })

  test("preview and plain render agree on the non-marker text", () => {
    const template =
      "Task: {{challenge.name}} @ {{workspace.root}}/{{workspace.agentDir}}"
    const plain = renderTemplateBody(template, samplePromptContext)
    const joined = previewPromptTemplate(template, samplePromptContext)
      .map((s) => s.text)
      .join("")
    expect(joined).toBe(plain)
  })

  test("orchestrator preview renders the default template (strict-mode missing-field guard)", () => {
    const segments = previewOrchestratorSystemPrompt(
      DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
      sampleOrchestratorPromptContext
    )
    expect(segments.length).toBeGreaterThan(0)
  })
})

describe("numeric contracts (prompt wording ↔ runtime constants)", () => {
  // The prompts quote runtime numbers as behavior contracts; the solver and
  // scheduler reason from the quoted number, not the constant. Either side
  // moving must drag the other.
  test("merged delivery cadence ↔ periodic re-examination cadence (~5 min)", () => {
    expect(FLUSH_INTERVAL_MS).toBe(5 * 60_000)
    // The solver delivery tick and the engine's periodic decision point
    // share the cadence constant; both prompts quote it.
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(
      "每 ~5 分钟一次的例行复核"
    )
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain("每 5 分钟合并投递")
  })

  test("solver idle-stall quoting", () => {
    // The stall alarm is engine-owned since §3.7 row 1 — the scheduler
    // prompt no longer quotes a per-agent stall line.
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).not.toContain(
      "idle >2 minutes"
    )
  })

  test("bash foreground default timeout (~600s) and truncation (~64KB)", () => {
    expect(DEFAULT_TIMEOUT_SEC).toBe(600)
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain("~600s")
    expect(MAX_BYTES).toBe(64_000)
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain("~64KB")
  })

  test("channel attachment caps (64MB/file, 8 per message)", () => {
    expect(MAX_FILE_BYTES).toBe(64 * 1024 * 1024)
    expect(MAX_FILES_PER_MESSAGE).toBe(8)
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain("64MB")
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain("最多 8 个")
  })
})

/** Default-template render of a notice event (the shipped wording). */
function renderNoticeText(event: NoticeEvent): string {
  return noticeDeliveries(event)
    .map((delivery) =>
      renderNotice(delivery, NOTICE_TEMPLATE_DEFAULTS[delivery.template])
    )
    .join("\n")
}

describe("notice wording sync (typed notice templates ↔ orchestrator template quotes)", () => {
  // The orchestrator template explains scheduler wake-ups by quoting the
  // literal wording the typed notice events render. Either side rewording
  // must sync the other, or the scheduler misreads its events.
  test("solved-challenge cleanup fragments", () => {
    const cleanup = renderNoticeText({
      type: "solveCleanup",
      eventId: "evt-1",
      challengeName: "web1",
      stopped: 2,
      cancelled: 1,
    })
    for (const frag of ["已完全解出", "已停止", "已取消"]) {
      expect(cleanup).toContain(frag)
      expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(frag)
    }
  })

  test("partial multi-flag confirm fragment", () => {
    const partial = renderNoticeText({
      type: "flagAccepted",
      tier: "partial",
      eventId: "evt-1",
      challengeId: "ch-1",
      challengeName: "web1",
      message: null,
      confirmedFlags: ["flag{a}"],
    })
    expect(partial).toContain("已确认：")
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain("已确认：")
  })

  test("queue pause/resume and the manual-flip marker", () => {
    const flip = (action: "paused" | "resumed") =>
      renderNoticeText({
        type: "queueStateChanged",
        eventId: "evt-1",
        action,
        source: "manual",
      })
    const paused = flip("paused")
    const resumed = flip("resumed")
    // The notice templates spell 队列已{暂停|恢复}（用户手动）; the ledger
    // lines keep the manual-flip marker.
    for (const frag of ["队列已", "暂停", "恢复", "（用户手动）"]) {
      expect(`${paused}\n${resumed}`).toContain(frag)
    }
    // The scheduler template teaches the plan verb — pause/resume reach it
    // as queue.changed triggers, not quoted ledger lines.
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(
      "set_queue_paused"
    )
  })
})

describe("SDK signature sync (GUIDE.md exact-signature block ↔ mainSystem inline copy)", () => {
  // mainSystem inlines a copy-verbatim channels quick start so solvers skip
  // one GUIDE read; the inline signatures must track GUIDE's exact-signature
  // block (kept aligned with channels.py by the sdk contract tests).
  test("channels read/post/ask signatures match", async () => {
    const guide = await Bun.file(
      new URL("../../../sdk/python/GUIDE.md", import.meta.url)
    ).text()
    const main = DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE
    for (const fn of ["read", "post"] as const) {
      const params = guide.match(
        new RegExp(`aegisx\\.channels\\.${fn}\\(([^)]*)\\) ->`)
      )?.[1]
      expect(params).toBeTruthy()
      expect(main).toContain(`channels.${fn}(${params})`)
    }
    // read returns the full page (MessageList), not a bare list — both
    // surfaces must name the paging fields so agents page forward instead
    // of losing backlog.
    expect(guide.match(/aegisx\.channels\.read\([^)]*\) -> (\w+)/)?.[1]).toBe(
      "MessageList"
    )
    for (const surface of [guide, main]) {
      expect(surface).toContain(".messages")
      expect(surface).toContain(".has_more")
    }
    // Anchor on the trailing comment: the GUIDE quick-start examples also
    // contain aegisx.ask(...) calls with sample arguments.
    const ask = guide.match(/aegisx\.ask\(([^)]*)\)\s+#/)?.[1]
    expect(ask).toBeTruthy()
    expect(main).toContain(`ask(${ask})`)
    expect(guide).toContain("~64KB")
  })
})

describe("notice variable list sync (NOTICE_TEMPLATE_VARIABLES ↔ defaults ↔ preview context)", () => {
  const HANDLEBARS_KEYWORDS = new Set(["if", "unless", "each", "with"])

  function referencedVariables(template: string): Set<string> {
    const names = new Set<string>()
    for (const match of template.matchAll(/\{\{([^}]*)\}\}/g)) {
      const token = match[1]
        .trim()
        .replace(/^[#/~]*(if|unless|each|with|else)\s*/, "")
      const root = token.split(/[\s.()]+/)[0]
      if (root && !HANDLEBARS_KEYWORDS.has(root)) names.add(root)
    }
    return names
  }

  test("the list is exactly the union of variables the defaults reference", () => {
    const referenced = new Set<string>()
    for (const body of Object.values(NOTICE_TEMPLATE_DEFAULTS)) {
      for (const name of referencedVariables(body)) referenced.add(name)
    }
    expect([...referenced].toSorted()).toEqual(
      [...NOTICE_TEMPLATE_VARIABLES].toSorted()
    )
  })

  test("every listed variable exists in the preview sample context", () => {
    for (const variable of NOTICE_TEMPLATE_VARIABLES) {
      expect(Object.hasOwn(sampleNoticeContext, variable)).toBe(true)
    }
  })
})

describe("template registry (every builtin renders + declares its variables)", () => {
  // Generalized drift guard: the registry is the single declaration of the
  // 23 builtin templates. Each entry must (a) render against its own sample
  // context — strict handlebars throws on any variable the sample lacks, so
  // a template edit referencing an undeclared field fails here instead of at
  // spawn or in the settings preview — and (b) only extend variables its
  // palette declares.

  test("all 23 builtin keys are declared exactly once", () => {
    const keys = PROMPT_TEMPLATES.map((entry) => entry.key)
    expect(keys).toHaveLength(23)
    expect(new Set(keys).size).toBe(23)
    expect(new Set(Object.keys(NOTICE_TEMPLATE_DEFAULTS)).size).toBe(17)
  })

  test("each default renders against its sample and references declared variables only", () => {
    for (const entry of PROMPT_TEMPLATES) {
      const segments = entry.preview(entry.default)
      expect(segments.length).toBeGreaterThan(0)
      for (const match of entry.default.matchAll(/\{\{([^}]*)\}\}/g)) {
        const raw = match[1].trim()
        // Helper calls (`{{join list " / "}}`): the referenced path is the
        // first argument, not the helper name.
        const token = raw.startsWith("join ")
          ? raw.slice("join ".length).trim().split(/\s+/)[0]
          : raw.replace(/^[#/~]*(if|unless|each|with|else)\s*/, "").trim()
        if (!token) continue
        // Undotted tokens are `#each` item fields (`{{name}}` inside
        // attachments) — the strict render above already validates them
        // against the sample. Dotted references must extend a declared
        // palette path (e.g. `event.flagFormats.length` extends
        // `event.flagFormats`), so a brand-new context root cannot slip in
        // undeclared.
        if (!token.includes(".")) continue
        expect(
          entry.variables.some(
            (variable) => token === variable || token.startsWith(`${variable}.`)
          )
        ).toBe(true)
      }
    }
  })

  test("the registry is the seed source (BUILTIN_DEFAULTS mirrors the defaults)", () => {
    // Covered indirectly by the store test, but the notice defaults must not
    // drift from the registry copies.
    for (const [key, body] of Object.entries(NOTICE_TEMPLATE_DEFAULTS)) {
      const entry = PROMPT_TEMPLATES.find((candidate) => candidate.key === key)
      expect(entry?.default).toBe(body)
    }
  })
})

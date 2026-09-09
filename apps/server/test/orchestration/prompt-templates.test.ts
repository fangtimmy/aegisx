import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import {
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
} from "../../src/orchestration/prompt-defaults"
import {
  previewInitialPrompt,
  previewOrchestratorSystemPrompt,
  previewSystemPrompt,
  renderSystemPrompt,
  renderTemplateBody,
  sampleOrchestratorPromptContext,
  samplePromptContext,
} from "../../src/orchestration/prompt-templates"
import { DEFAULT_TIMEOUT_SEC, MAX_BYTES } from "../../src/run/bash-tool"
import { FLUSH_INTERVAL_MS } from "../../src/run/channels-context"
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
} from "../../src/run/channels-post"
import { AGENT_STALL_MS } from "../../src/run/stall-watchdog"

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
    const main = renderSystemPrompt(
      DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
      samplePromptContext
    )
    expect(main).toContain("/opt/solver/ENVIRONMENT.md")
    expect(main).toContain("/opt/solver/knowledges")
  })

  test("mainSystem renders the Channels section for every solver agent (v19)", () => {
    const main = renderSystemPrompt(
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

  test("initial gates submit/finish on capabilities and carries no promptHint duplicate", () => {
    const capped = renderTemplateBody(DEFAULT_INITIAL_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      capabilities: {
        canFinish: false,
        canSubmitFlag: false,
        canManageTarget: false,
      },
      event: { ...samplePromptContext.event, promptHint: "flag{...}" },
    })
    expect(capped).not.toContain("submit_flag")
    expect(capped).not.toContain("finish_run")
    expect(capped).not.toContain("## Event instructions")

    const normal = renderTemplateBody(DEFAULT_INITIAL_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      event: { ...samplePromptContext.event, promptHint: "flag{...}" },
    })
    expect(normal).toContain("finish_run")
    // Event instructions stay a system-prompt-only block (survives compaction).
    expect(normal).not.toContain("## Event instructions")
  })
})

describe("prompt preview", () => {
  test("highlights interpolated variable values", () => {
    const segments = previewSystemPrompt(
      "Solve {{challenge.name}} ({{challenge.category}})",
      samplePromptContext
    )
    expect(highlightedText(segments)).toContain("Encrypted Notes")
    expect(highlightedText(segments)).toContain("web")
  })

  test("marks bare true/false tokens as highlighted even outside variables", () => {
    const segments = previewSystemPrompt(
      "Submit: {{capabilities.canSubmitFlag}} finish: {{capabilities.canFinish}}",
      samplePromptContext
    )
    // booleans are not marker-wrapped by markPreviewValues, but previewSegments
    // splits bare true/false tokens out and highlights them.
    expect(highlightedText(segments)).toContain("true")
  })

  test("returns a single non-highlighted segment for static text", () => {
    const segments = previewSystemPrompt("Static text", samplePromptContext)
    expect(segments).toHaveLength(1)
    expect(segments[0].highlighted).toBe(false)
  })

  test("initial prompt preview mirrors system prompt segmentation", () => {
    const segments = previewInitialPrompt(
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
    const plain = renderSystemPrompt(template, samplePromptContext)
    const joined = previewSystemPrompt(template, samplePromptContext)
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
  test("merged delivery cadence (~5 min)", () => {
    expect(FLUSH_INTERVAL_MS).toBe(5 * 60_000)
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(
      "every ~5 minutes"
    )
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain("每 5 分钟合并投递")
  })

  test("solver idle-stall threshold (>2 min)", () => {
    expect(AGENT_STALL_MS).toBe(2 * 60_000)
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(
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

describe("notice wording sync (service/queue emission ↔ orchestrator template quotes)", () => {
  // The orchestrator template explains scheduler wake-ups by quoting the
  // literal notice wording emitted in service.ts / queue.ts. Either side
  // rewording must sync the other, or the scheduler misreads its events.
  const serviceSrc = readFileSync(
    new URL("../../src/run/service.ts", import.meta.url),
    "utf8"
  )
  const queueSrc = readFileSync(
    new URL("../../src/run/queue.ts", import.meta.url),
    "utf8"
  )

  test("solved-challenge cleanup fragments", () => {
    for (const frag of ["已完全解出", "已停止", "已取消"]) {
      expect(serviceSrc).toContain(frag)
      expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(frag)
    }
  })

  test("partial multi-flag confirm fragment", () => {
    expect(serviceSrc).toContain("已确认：")
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain("已确认：")
  })

  test("queue pause/resume and the manual-flip marker", () => {
    // queue.ts composes 队列已{暂停|恢复}（用户手动）; the template spells
    // both forms out for the scheduler.
    for (const frag of ["队列已", "暂停", "恢复", "（用户手动）"]) {
      expect(queueSrc).toContain(frag)
    }
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(
      "队列已暂停/已恢复"
    )
    expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain("用户手动")
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
    // Anchor on the trailing comment: the GUIDE quick-start examples also
    // contain aegisx.ask(...) calls with sample arguments.
    const ask = guide.match(/aegisx\.ask\(([^)]*)\)\s+#/)?.[1]
    expect(ask).toBeTruthy()
    expect(main).toContain(`ask(${ask})`)
    expect(guide).toContain("~64KB")
  })
})

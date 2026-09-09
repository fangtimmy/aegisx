import { describe, expect, test } from "bun:test"

import {
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
} from "../../src/orchestration/prompt-defaults"
import {
  previewInitialPrompt,
  previewSystemPrompt,
  renderSystemPrompt,
  renderTemplateBody,
  samplePromptContext,
} from "../../src/orchestration/prompt-templates"

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
    // The channel layer is rendered for every solver agent; API specifics
    // live in the in-image GUIDE.md (the prompt keeps the behavioral rules).
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

  test("mainSystem points tool availability at ENVIRONMENT.md, promising no install SOP", () => {
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).not.toContain(
      "install it into the workspace"
    )
    // The offline appliance has no install path — the prompt must point at
    // ENVIRONMENT.md for what exists and never promise an install procedure.
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).toContain(
      "/opt/solver/ENVIRONMENT.md"
    )
    expect(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE).not.toContain("install SOP")
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
})

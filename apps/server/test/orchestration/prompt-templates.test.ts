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

  test("mainSystem renders the co-solver section only for multi-solver runs (v9)", () => {
    const single = renderSystemPrompt(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      run: { ...samplePromptContext.run, multiSolver: false },
    })
    const multi = renderSystemPrompt(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE, {
      ...samplePromptContext,
      run: { ...samplePromptContext.run, multiSolver: true },
    })
    expect(single).not.toContain("Co-solvers")
    expect(multi).toContain("Co-solvers")
    expect(multi).toContain("SOLVER-")
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
      "Container: {{run.isContainer}} submit: {{capabilities.canSubmitFlag}}",
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
    const template = "Task: {{challenge.name}} @ {{run.workspace}}"
    const plain = renderSystemPrompt(template, samplePromptContext)
    const joined = previewSystemPrompt(template, samplePromptContext)
      .map((s) => s.text)
      .join("")
    expect(joined).toBe(plain)
  })
})

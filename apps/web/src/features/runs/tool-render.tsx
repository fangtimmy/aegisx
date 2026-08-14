import { type ReactNode, useEffect, useRef, useState } from "react"

import { CodePreview } from "@/components/code-preview"
import {
  isRecord,
  type ToolBlock,
  text,
  toolFilePath,
} from "@/domain/conversation"
import { highlightCode } from "@/lib/shiki"
import { useResolvedTheme } from "@/lib/use-resolved-theme"
import { cn } from "@/lib/utils"

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g")
const CHARSET = new RegExp(`${ESC}[()][0-9A-Za-z]`, "g")

/** Strip CSI / OSC ANSI sequences for terminal-like tool output. */
function stripAnsi(value: string): string {
  return value.replace(CSI, "").replace(OSC, "").replace(CHARSET, "")
}

function patchPath(filePath: string) {
  return filePath.replace(/^\/+/, "") || filePath
}

/** Prefer details.diff → content (already a patch) → rebuild from old/new. */
function toolDiff(tool: ToolBlock): string | null {
  if (
    isRecord(tool.details) &&
    typeof tool.details.diff === "string" &&
    tool.details.diff.trim()
  ) {
    return tool.details.diff
  }
  const out = tool.output.trim()
  if (out.startsWith("--- ") || out.startsWith("diff ")) return tool.output

  const src = isRecord(tool.details)
    ? tool.details
    : isRecord(tool.args)
      ? tool.args
      : null
  if (!src) return null
  const oldString = text(src.oldString)
  const newString = text(src.newString)
  if (!oldString && !newString) return null
  const path =
    toolFilePath(tool.args) ||
    (isRecord(tool.details) ? text(tool.details.filePath) : "") ||
    "file"
  const p = patchPath(path)
  const oldCount = oldString ? oldString.split("\n").length : 0
  const newCount = newString ? newString.split("\n").length : 0
  const lines = [
    `--- a/${p}`,
    `+++ b/${p}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...oldString.split("\n").map((line) => `-${line}`),
    ...newString.split("\n").map((line) => `+${line}`),
  ]
  return lines.join("\n")
}

export function usesCustomToolBody(name: string) {
  return (
    name === "edit" || name === "write" || name === "read" || name === "bash"
  )
}

/** Native overflow scroll — more reliable than ScrollArea with h-auto. */
function ToolScroll({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("max-h-80 min-h-0 overflow-auto", className)}>
      {children}
    </div>
  )
}

function EmptyHint({ children }: { children: string }) {
  return (
    <p className="px-2.5 py-2 font-mono text-xs text-muted-foreground">
      {children}
    </p>
  )
}

type DiffRow = {
  kind: "add" | "del" | "ctx"
  text: string
  line: number | null
}

function parseDiff(diff: string): {
  path?: string
  note?: string
  rows: DiffRow[]
} {
  const rows: DiffRow[] = []
  let path: string | undefined
  let note: string | undefined
  let oldLine = 1
  let newLine = 1
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("--- ")) {
      path = patchPath(raw.replace(/^---\s+[ab]\//, "").replace(/^---\s+/, ""))
      continue
    }
    if (raw.startsWith("+++ ")) {
      path = patchPath(
        raw.replace(/^\+\+\+\s+[ab]\//, "").replace(/^\+\+\+\s+/, "")
      )
      continue
    }
    if (raw.startsWith("@@")) {
      // @@ -12,3 +12,5 @@ optional note
      const match =
        /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@\s*(.*)?$/.exec(raw)
      if (match) {
        oldLine = Number(match[1]) || 1
        newLine = Number(match[2]) || 1
        note = match[3]?.trim() || undefined
      } else {
        note =
          raw
            .replace(/^@@\s*/, "")
            .replace(/\s*@@$/, "")
            .trim() || undefined
      }
      continue
    }
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), line: newLine })
      newLine += 1
      continue
    }
    if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1), line: oldLine })
      oldLine += 1
      continue
    }
    if (raw.startsWith(" ")) {
      rows.push({ kind: "ctx", text: raw.slice(1), line: oldLine })
      oldLine += 1
      newLine += 1
      continue
    }
    if (raw.length > 0) rows.push({ kind: "ctx", text: raw, line: null })
  }
  return { path, note, rows }
}

function DiffPreview({ diff }: { diff: string }) {
  const { path, note, rows } = parseDiff(diff)
  const additions = rows.filter((row) => row.kind === "add").length
  const deletions = rows.filter((row) => row.kind === "del").length
  const lineWidth = Math.max(
    2,
    ...rows.map((row) => (row.line == null ? 0 : String(row.line).length))
  )
  return (
    <ToolScroll>
      {(path || note || additions > 0 || deletions > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
          {path ? (
            <span
              className="min-w-0 truncate text-foreground"
              dir="rtl"
              title={path}
            >
              <bdi dir="ltr">{path}</bdi>
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums">
            <span className="text-emerald-700 dark:text-emerald-400">
              +{additions}
            </span>
            <span className="mx-1 text-border">/</span>
            <span className="text-red-700 dark:text-red-400">-{deletions}</span>
          </span>
          {note ? <span className="shrink-0 opacity-70">{note}</span> : null}
        </div>
      )}
      <div className="font-mono text-xs leading-5">
        {rows.map((row, index) => (
          <div
            className={cn(
              "grid grid-cols-[2.5rem_1.25rem_minmax(0,1fr)]",
              row.kind === "add" &&
                "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
              row.kind === "del" &&
                "bg-red-500/10 text-red-900 dark:text-red-200"
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: static diff dump
            key={index}
          >
            <span
              aria-hidden
              className="pr-1 text-right text-muted-foreground/70 tabular-nums select-none"
              style={{ minWidth: `${lineWidth}ch` }}
            >
              {row.line ?? ""}
            </span>
            <span
              aria-hidden
              className={cn(
                "text-center opacity-70 select-none",
                row.kind === "add" && "text-emerald-700 dark:text-emerald-400",
                row.kind === "del" && "text-red-700 dark:text-red-400"
              )}
            >
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
            </span>
            <span className="min-w-0 pr-2.5 wrap-anywhere whitespace-pre-wrap">
              {row.text || " "}
            </span>
          </div>
        ))}
        {rows.length === 0 ? (
          <p className="px-2.5 py-2 text-muted-foreground">空差异</p>
        ) : null}
      </div>
    </ToolScroll>
  )
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/** Plain (un-highlighted) command HTML mirroring Shiki's line structure. */
function plainCommandHtml(command: string) {
  const lines = command.length > 0 ? command.split("\n") : [""]
  const body = lines
    .map((line) => `<span class="line">${escapeHtml(line)}</span>`)
    .join("")
  return `<pre class="shiki"><code>${body}</code></pre>`
}

/** Shell-highlighted bash command with a leading `$` prompt, no line gutter. */
function BashCommand({ command }: { command: string }) {
  const theme = useResolvedTheme()
  const [html, setHtml] = useState(() => plainCommandHtml(command))
  useEffect(() => {
    let cancelled = false
    setHtml(plainCommandHtml(command))
    void highlightCode(command, "bash", theme, { lineNumbers: false })
      .then((next) => {
        if (!cancelled) setHtml(next)
      })
      .catch(() => {
        if (!cancelled) setHtml(plainCommandHtml(command))
      })
    return () => {
      cancelled = true
    }
  }, [command, theme])
  return (
    <div className="flex items-start gap-2 border-b px-2.5 py-1.5 font-mono text-xs leading-5">
      <span aria-hidden className="text-muted-foreground select-none">
        $
      </span>
      <div
        className={cn(
          "min-w-0 flex-1",
          "[&_pre]:m-0 [&_pre]:border-0 [&_pre]:bg-transparent! [&_pre]:p-0 [&_pre]:font-mono",
          "[&_code]:block [&_code]:font-mono",
          "[&_.line]:wrap-anywhere [&_.line]:whitespace-pre-wrap"
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki HTML / escaped fallback
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

function BashBody({
  command,
  value,
  streaming,
  isError,
}: {
  command: string
  value: string
  streaming?: boolean
  isError?: boolean
}) {
  const clean = stripAnsi(value)
  const endRef = useRef<HTMLDivElement>(null)
  const streamBytes = value.length
  useEffect(() => {
    if (!streaming) return
    void streamBytes
    endRef.current?.scrollIntoView({ block: "nearest" })
  }, [streaming, streamBytes])
  return (
    <ToolScroll>
      {command ? <BashCommand command={command} /> : null}
      {!value.trim() ? (
        <EmptyHint>
          {streaming ? "运行中…" : isError ? "命令失败，无输出" : "无输出"}
        </EmptyHint>
      ) : (
        <pre
          className={cn(
            "p-2.5 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-foreground",
            isError && "text-destructive"
          )}
        >
          {clean}
        </pre>
      )}
      <div ref={endRef} />
    </ToolScroll>
  )
}

/** Full custom panel body for read / write / edit / bash (no I/O chrome). */
export function ToolCustomBody({ tool }: { tool: ToolBlock }) {
  const isError = tool.status === "error"

  if (tool.name === "edit") {
    const diff = toolDiff(tool)
    if (diff) return <DiffPreview diff={diff} />
    return (
      <EmptyHint>
        {tool.status === "running" || tool.status === "pending"
          ? "编辑中…"
          : tool.output || "无差异"}
      </EmptyHint>
    )
  }

  if (tool.name === "write") {
    const path = toolFilePath(tool.args) || "file"
    const content = isRecord(tool.args) ? text(tool.args.content) : ""
    if (content) {
      return (
        <ToolScroll>
          <div className="p-1">
            <CodePreview code={content} path={path} />
          </div>
        </ToolScroll>
      )
    }
    return (
      <EmptyHint>
        {tool.status === "running" ? "写入中…" : tool.output || "空写入"}
      </EmptyHint>
    )
  }

  if (tool.name === "read") {
    if (!tool.output) {
      return (
        <EmptyHint>
          {tool.status === "running" ? "读取中…" : "空文件"}
        </EmptyHint>
      )
    }
    if (
      tool.output.startsWith("Image file:") ||
      tool.output.startsWith("File appears to be binary") ||
      tool.output.startsWith("File not found:")
    ) {
      return (
        <ToolScroll>
          <pre
            className={cn(
              "p-2.5 font-mono text-xs leading-5 wrap-break-word whitespace-pre-wrap",
              isError && "text-destructive"
            )}
          >
            {tool.output}
          </pre>
        </ToolScroll>
      )
    }
    const path = toolFilePath(tool.args) || "read.txt"
    return (
      <ToolScroll>
        <div className="p-1">
          <CodePreview code={tool.output} path={path} />
        </div>
      </ToolScroll>
    )
  }

  if (tool.name === "bash") {
    const command = isRecord(tool.args) ? text(tool.args.command) : ""
    return (
      <BashBody
        command={command}
        isError={isError}
        streaming={tool.status === "running"}
        value={tool.output}
      />
    )
  }

  return null
}

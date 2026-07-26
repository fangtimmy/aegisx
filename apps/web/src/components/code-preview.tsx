import { useEffect, useMemo, useState } from "react"
import { langFromPath } from "@/lib/lang-from-path"
import { highlightCode } from "@/lib/shiki"
import { cn } from "@/lib/utils"

type CodePreviewProps = {
  code: string
  path: string
  className?: string
  /** 1-based starting line number (default 1). */
  startLine?: number
}

function useResolvedTheme(): "dark" | "light" {
  const [resolved, setResolved] = useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  )
  useEffect(() => {
    const el = document.documentElement
    const sync = () =>
      setResolved(el.classList.contains("dark") ? "dark" : "light")
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return resolved
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/**
 * Strip read-tool style prefixes (`12: code`) so Shiki line numbers are the
 * only gutter. Footer notices (e.g. "Showing lines…") are kept as-is.
 */
export function normalizePreviewCode(code: string): {
  code: string
  startLine: number
  footer: string
} {
  const lines = code.split("\n")
  const numbered: Array<{ n: number; text: string }> = []
  let footerStart = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (line.trim() === "" && i + 1 < lines.length) {
      const rest = lines.slice(i + 1).join("\n")
      if (
        /^Showing lines\b/i.test(rest.trim()) ||
        /^Output truncated\b/i.test(rest.trim())
      ) {
        footerStart = i
        break
      }
    }
    const match = /^(\d+):\s?(.*)$/.exec(line)
    if (!match) {
      return { code, startLine: 1, footer: "" }
    }
    numbered.push({ n: Number(match[1]), text: match[2] ?? "" })
  }
  if (numbered.length === 0) return { code, startLine: 1, footer: "" }
  const body = numbered.map((row) => row.text).join("\n")
  const footer =
    footerStart < lines.length
      ? lines.slice(footerStart).join("\n").replace(/^\n+/, "")
      : ""
  return {
    code: body,
    startLine: numbered[0]?.n ?? 1,
    footer,
  }
}

function plainHtml(code: string, startLine: number) {
  const lines = code.length > 0 ? code.split("\n") : [""]
  const body = lines
    .map((line, index) => {
      const n = startLine + index
      return `<span class="line" data-line="${n}"><span class="line-content">${escapeHtml(line)}</span></span>`
    })
    .join("")
  return `<pre class="shiki plain"><code>${body}</code></pre>`
}

/** Syntax-highlighted code via Shiki with line numbers and soft wrap. */
export function CodePreview({
  code,
  path,
  className,
  startLine: startLineProp,
}: CodePreviewProps) {
  const theme = useResolvedTheme()
  const lang = langFromPath(path)
  const normalized = useMemo(() => normalizePreviewCode(code), [code])
  const startLine = startLineProp ?? normalized.startLine
  const source = normalized.code
  const [html, setHtml] = useState(() => plainHtml(source, startLine))

  useEffect(() => {
    let cancelled = false
    setHtml(plainHtml(source, startLine))
    void highlightCode(source, lang, theme, { startLine })
      .then((next) => {
        if (!cancelled) setHtml(next)
      })
      .catch(() => {
        if (!cancelled) setHtml(plainHtml(source, startLine))
      })
    return () => {
      cancelled = true
    }
  }, [source, lang, theme, startLine])

  return (
    <div className={cn("code-preview min-w-0", className)}>
      <div
        className={cn(
          "min-w-0 text-xs leading-5",
          // Soft wrap
          "[&_pre]:m-0 [&_pre]:overflow-x-hidden [&_pre]:whitespace-normal [&_pre]:bg-transparent! [&_pre]:p-0 [&_pre]:font-mono",
          "[&_code]:block [&_code]:font-mono",
          // Line + gutter
          "[&_.line]:flex [&_.line]:min-w-0 [&_.line]:gap-3 [&_.line]:px-2.5 [&_.line]:py-0",
          "[&_.line]:before:w-7 [&_.line]:before:shrink-0 [&_.line]:before:select-none [&_.line]:before:text-right [&_.line]:before:text-muted-foreground/70 [&_.line]:before:content-[attr(data-line)]",
          "[&_.line-content]:min-w-0 [&_.line-content]:flex-1 [&_.line-content]:whitespace-pre-wrap [&_.line-content]:break-words [&_.line-content]:[overflow-wrap:anywhere]"
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki HTML / escaped plain fallback
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {normalized.footer ? (
        <p className="border-t px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
          {normalized.footer.trim()}
        </p>
      ) : null}
    </div>
  )
}

import { useEffect, useState } from "react"
import { codeToHtml } from "shiki"
import { langFromPath } from "@/lib/lang-from-path"
import { cn } from "@/lib/utils"

type CodePreviewProps = {
  code: string
  path: string
  className?: string
}

function codeLines(code: string) {
  let offset = 0
  return code.split("\n").map((line) => {
    const value = {
      key: `${offset}:${line}`,
      line,
      newline: offset + line.length < code.length,
    }
    offset += line.length + 1
    return value
  })
}

export function CodePreview({ code, path, className }: CodePreviewProps) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    const lang = langFromPath(path)

    const options = {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      defaultColor: false as const,
    }

    void codeToHtml(code, { ...options, lang })
      .then((result) => {
        if (!cancelled) setHtml(result)
      })
      .catch(async () => {
        try {
          const fallback = await codeToHtml(code, {
            ...options,
            lang: "text",
          })
          if (!cancelled) setHtml(fallback)
        } catch {
          if (!cancelled) setHtml(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [code, path])

  if (!html) {
    return (
      <pre
        className={cn(
          "file-preview p-3 font-mono text-xs leading-5",
          className
        )}
      >
        <code>
          {codeLines(code).map(({ key, line, newline }) => (
            <span className="line" key={key}>
              {line}
              {newline ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    )
  }

  return (
    <div
      className={cn("file-preview min-w-0 text-xs leading-5", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki-generated HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

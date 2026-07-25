import { File } from "@pierre/diffs/react"
import { type CSSProperties, useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"

const THEME = { dark: "github-dark-default", light: "github-light" } as const

type CodePreviewProps = {
  code: string
  path: string
  className?: string
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

export function CodePreview({ code, path, className }: CodePreviewProps) {
  const themeType = useResolvedTheme()
  const file = useMemo(() => ({ name: path, contents: code }), [code, path])
  const options = useMemo(
    () => ({
      theme: THEME,
      themeType,
      disableFileHeader: true,
      overflow: "wrap" as const,
    }),
    [themeType]
  )
  return (
    <File
      key={path}
      className={cn("text-xs", className)}
      file={file}
      options={options}
      style={
        {
          "--diffs-font-family": "var(--font-mono)",
          "--diffs-font-size": "12px",
          "--diffs-line-height": "20px",
          "--diffs-bg": "transparent",
        } as CSSProperties
      }
    />
  )
}

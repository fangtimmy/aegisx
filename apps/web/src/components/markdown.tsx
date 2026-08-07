import { cjk } from "@streamdown/cjk"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import { memo } from "react"
import { Streamdown } from "streamdown"
import { cn } from "@/lib/utils"

const plugins = { mermaid, math, cjk } as const

const MAX_MARKDOWN_CHARS = 100_000

export const Markdown = memo(function Markdown({
  children,
  className,
  isAnimating = false,
}: {
  children: string
  className?: string
  isAnimating?: boolean
}) {
  const content =
    children.length > MAX_MARKDOWN_CHARS
      ? `${children.slice(0, MAX_MARKDOWN_CHARS)}\n\n[消息预览已截断]`
      : children

  return (
    <Streamdown
      className={cn("streamdown-md min-w-0", className)}
      isAnimating={isAnimating}
      plugins={plugins}
    >
      {content}
    </Streamdown>
  )
})

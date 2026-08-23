import { memo, type ComponentProps } from "react"
import ReactMarkdown from "react-markdown"
import type { ExtraProps } from "react-markdown"
import remarkCjkFriendly from "remark-cjk-friendly"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"

const MAX_MARKDOWN_CHARS = 100_000

const remarkPlugins = [remarkGfm, remarkCjkFriendly]

function MarkdownLink({
  children,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  return (
    <a {...props} rel="noreferrer" target="_blank">
      {children}
    </a>
  )
}

function truncate(text: string) {
  return text.length > MAX_MARKDOWN_CHARS
    ? `${text.slice(0, MAX_MARKDOWN_CHARS)}\n\n[消息预览已截断]`
    : text
}

export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={cn("md min-w-0", className)}>
      <ReactMarkdown
        components={{ a: MarkdownLink }}
        remarkPlugins={remarkPlugins}
      >
        {truncate(children)}
      </ReactMarkdown>
    </div>
  )
})

/** Message body honoring the per-area markdown preference: rendered
 * markdown, or plain pre-wrapped text when disabled. */
export const MessageBody = memo(function MessageBody({
  children,
  className,
  markdown,
}: {
  children: string
  className?: string
  markdown: boolean
}) {
  if (!markdown) {
    return (
      <div
        className={cn("min-w-0 wrap-break-word whitespace-pre-wrap", className)}
      >
        {truncate(children)}
      </div>
    )
  }
  return <Markdown className={className}>{children}</Markdown>
})

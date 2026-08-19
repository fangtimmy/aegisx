"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva } from "class-variance-authority"
import type * as React from "react"

import { cn } from "@/lib/utils"

const listRowVariants = cva(
  "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors outline-none select-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-selected:bg-accent [&_svg]:pointer-events-none [&_svg]:shrink-0"
)

export interface ListRowProps extends useRender.ComponentProps<"button"> {
  selected?: boolean
}

export function ListRow({
  className,
  render,
  selected = false,
  ...props
}: ListRowProps): React.ReactElement {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button"

  const defaultProps = {
    className: cn(listRowVariants({ className })),
    "data-selected": selected || undefined,
    "data-slot": "list-row",
    type: typeValue,
  }

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  })
}

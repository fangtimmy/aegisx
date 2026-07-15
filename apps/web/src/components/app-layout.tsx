import type { ReactNode } from "react"
import { ProductHeader } from "./product-header"

export function AppLayout({
  children,
  eventName,
  workspace = false,
}: {
  children: ReactNode
  eventName?: string
  workspace?: boolean
}) {
  return (
    <div
      className={
        workspace
          ? "flex h-svh min-w-[1024px] flex-col bg-muted/30"
          : "min-h-svh min-w-[1024px] bg-muted/30"
      }
    >
      <ProductHeader eventName={eventName} />
      <main
        className={
          workspace
            ? "mx-auto flex min-h-0 w-full max-w-6xl flex-1 px-6 py-4"
            : "mx-auto w-full max-w-6xl px-6 py-4"
        }
      >
        {children}
      </main>
    </div>
  )
}

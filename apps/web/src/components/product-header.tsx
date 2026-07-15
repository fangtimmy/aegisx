import { Settings, ShieldCheck } from "lucide-react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip"

export function IconTooltip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  )
}

export function ProductHeader({ eventName }: { eventName?: string }) {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            aria-label="AegisX events"
            render={<Link to="/" />}
            size="xl"
            variant="ghost"
          >
            <ShieldCheck />
            AegisX
          </Button>
          {eventName && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                /
              </span>
              <span className="truncate font-medium text-sm sm:text-base">
                {eventName}
              </span>
            </>
          )}
        </div>
        <IconTooltip label="Settings">
          <Button
            aria-label="Settings"
            render={<Link to="/settings" />}
            size="icon"
            variant="ghost"
          >
            <Settings />
          </Button>
        </IconTooltip>
      </div>
    </header>
  )
}

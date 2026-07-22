import { Settings, ShieldCheck } from "lucide-react"
import { Link, useParams } from "react-router"
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
  const { eventId } = useParams()

  return (
    <header className="sticky top-0 z-50 border-b bg-card">
      <div className="mx-auto flex h-14 w-full items-center justify-between px-6">
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
              <Button
                className="min-w-0"
                render={<Link to={`/events/${eventId}`} />}
                size="xl"
                variant="ghost"
              >
                <span className="truncate">{eventName}</span>
              </Button>
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

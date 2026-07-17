import { Settings, ShieldCheck } from "lucide-react"
import { Link, useParams } from "react-router"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
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
  const { theme, setTheme } = useTheme()

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
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
          <Menu>
            <MenuTrigger
              render={
                <Button aria-label="Settings" size="icon" variant="ghost" />
              }
            >
              <Settings />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuGroup>
                <MenuGroupLabel>Theme</MenuGroupLabel>
                <MenuRadioGroup
                  onValueChange={(value) =>
                    setTheme(value as "dark" | "light" | "system")
                  }
                  value={theme}
                >
                  <MenuRadioItem value="light">Light</MenuRadioItem>
                  <MenuRadioItem value="dark">Dark</MenuRadioItem>
                  <MenuRadioItem value="system">System</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
              <MenuItem render={<Link to="/settings" />}>
                <Settings />
                Settings
              </MenuItem>
            </MenuPopup>
          </Menu>
        </IconTooltip>
      </div>
    </header>
  )
}

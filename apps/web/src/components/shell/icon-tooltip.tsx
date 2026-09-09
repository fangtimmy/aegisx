import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip"

/** Styled tooltip for icon-only controls: wraps children in an inline-flex
 * trigger span so the surrounding layout is untouched. Prefer this over a
 * native `title` on icon buttons — native tooltips are unstyled, delayed,
 * and unreachable on touch devices. */
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

import { Plus, Send, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/group"
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

/** Composer command panel entry (slash-command style): clicking inserts the
 * command text into the composer; Conversation dispatches it on submit. */
type ComposerCommand = {
  command: string
  label: string
}

const COMPOSER_COMMANDS: ComposerCommand[] = [
  { command: "/compact", label: "压缩上下文" },
  { command: "/new", label: "新会话" },
  { command: "/close", label: "关闭容器" },
]

/** The slash-completion query: the draft's first token when it starts with
 * "/" and does not already match a command exactly (a full match executes on
 * send instead). */
function slashQuery(draft: string, closed: boolean): string | null {
  const first = draft.trim().toLowerCase().split(/\s+/)[0]
  if (!first?.startsWith("/")) return null
  const commands = COMPOSER_COMMANDS.filter(
    (command) => command.command !== "/close" || !closed
  )
  if (commands.some((command) => command.command === first)) return null
  return first
}

export function MessageInput({
  draft,
  deliverAs,
  busy,
  closed,
  closedReopenable,
  running,
  stopping,
  onDraftChange,
  onDeliverAsChange,
  onStop,
  onSubmit,
}: {
  draft: string
  deliverAs: "steer" | "followUp"
  busy: boolean
  closed: boolean
  closedReopenable: boolean
  running: boolean
  stopping: boolean
  onDraftChange: (value: string) => void
  onDeliverAsChange: (value: "steer" | "followUp") => void
  onStop?: () => void
  onSubmit: () => void
}) {
  const locked = closed && !closedReopenable
  // While the agent is running and the composer is empty, the send button
  // becomes a stop button (Esc-equivalent: the turn is aborted, the container
  // stays warm). Typing any text reverts it to send.
  const showStop = running && !draft.trim() && !busy && Boolean(onStop)
  const placeholder = locked
    ? "已关闭，请重新启动以开始"
    : closed
      ? "发送消息以重新打开并继续（容器将重建）"
      : running
        ? "引导或追问 agent…"
        : "向 agent 发送消息…"
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)

  const query = slashQuery(draft, closed)
  const matches =
    query === null
      ? []
      : COMPOSER_COMMANDS.filter(
          (command) =>
            command.command.startsWith(query) &&
            (command.command !== "/close" || !closed)
        )
  const slashOpen = query !== null && !slashDismissed && matches.length > 0

  useEffect(() => {
    setSlashIndex(0)
  }, [query])

  const pickCommand = (command: string) => {
    onDraftChange(command)
    // Overlays restore focus to their trigger on close; move it back to the
    // composer so the user can edit or send the command immediately.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: Enter commits the composition, never sends/completes.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSlashIndex((index) => (index + 1) % matches.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setSlashIndex((index) => (index - 1 + matches.length) % matches.length)
        return
      }
      // Complete only (no execution) — sending the completed command is the
      // next plain Enter.
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        pickCommand(matches[slashIndex]!.command)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }

  // Single-select toggle group: ignore un-pressing the active segment.
  const onDeliverAsGroup = (group: readonly string[]) => {
    const next = group.at(-1)
    if (next === "steer" || next === "followUp") onDeliverAsChange(next)
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {slashOpen && (
        <div
          aria-label="命令补全"
          className="flex flex-col overflow-hidden rounded-md border bg-popover shadow-md"
          role="listbox"
        >
          {matches.map((command, index) => (
            <button
              aria-selected={index === slashIndex}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                index === slashIndex && "bg-accent"
              )}
              key={command.command}
              onClick={() => pickCommand(command.command)}
              role="option"
              type="button"
            >
              <span className="font-mono">{command.command}</span>
              <span className="text-muted-foreground">{command.label}</span>
            </button>
          ))}
        </div>
      )}
      <form
        className="flex w-full items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="打开命令面板"
                disabled={busy || locked}
                size="icon"
                type="button"
                variant="ghost"
              />
            }
          >
            <Plus />
          </MenuTrigger>
          <MenuPopup align="start">
            {COMPOSER_COMMANDS.filter(
              (command) => command.command !== "/close" || !closed
            ).map((command) => (
              <MenuItem
                key={command.command}
                onClick={() => pickCommand(command.command)}
              >
                <span className="font-mono">{command.command}</span>
                <span className="text-muted-foreground">{command.label}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <Textarea
          aria-label="向 agent 发送消息"
          className="max-h-40 min-w-0 flex-1 text-sm [&_textarea]:max-h-40 [&_textarea]:min-h-9 [&_textarea]:resize-none [&_textarea]:px-0 [&_textarea]:py-1.5 [&_textarea]:text-sm [&_textarea]:leading-6"
          disabled={busy || locked}
          onChange={(e) => {
            onDraftChange(e.target.value)
            setSlashDismissed(false)
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          ref={inputRef}
          rows={1}
          unstyled
          value={draft}
        />
        {running && (
          <ToggleGroup
            onValueChange={onDeliverAsGroup}
            value={[deliverAs]}
            variant="outline"
          >
            <ToggleGroupItem value="steer">引导</ToggleGroupItem>
            <ToggleGroupItem value="followUp">追问</ToggleGroupItem>
          </ToggleGroup>
        )}
        <ButtonGroup>
          {showStop ? (
            <Button
              aria-label="停止当前轮"
              disabled={stopping || locked}
              loading={stopping}
              onClick={onStop}
              size="icon"
              title="停止当前轮（容器保留）"
              type="button"
              variant="destructive-outline"
            >
              <Square />
            </Button>
          ) : (
            <Button
              aria-label="发送消息"
              disabled={!draft.trim() || busy || locked}
              loading={busy}
              size="icon"
              type="submit"
            >
              <Send />
            </Button>
          )}
        </ButtonGroup>
      </form>
    </div>
  )
}

import { ChevronDown, Send, Square, SquareSlash } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { ListRow } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/group"
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { Textarea } from "@/components/ui/textarea"

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

export function Composer({
  draft,
  deliverAs,
  busy,
  closed,
  closedReopenable,
  running,
  stopping,
  modelSlot,
  contextSlot,
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
  modelSlot: ReactNode
  contextSlot: ReactNode
  onDraftChange: (value: string) => void
  onDeliverAsChange: (value: "steer" | "followUp") => void
  onStop?: () => void
  onSubmit: () => void
}) {
  const locked = closed && !closedReopenable
  const placeholder = locked
    ? "已关闭，请重新启动以开始"
    : closed
      ? "发送消息以重新打开并继续（容器将重建）"
      : running
        ? "引导或追问 agent…"
        : "向 agent 发送消息…"
  const rootRef = useRef<HTMLFormElement>(null)
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

  // Focus on entry and at turn end (running → idle) so the next prompt can
  // be typed immediately; skipped while locked (textarea is disabled).
  useEffect(() => {
    if (!running && !locked) inputRef.current?.focus()
  }, [running, locked])

  // Outside-click closes the slash popup.
  useEffect(() => {
    if (!slashOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node))
        setSlashDismissed(true)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [slashOpen])

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

  return (
    <form
      className="relative rounded-lg border bg-muted/50 shadow-xs"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      ref={rootRef}
    >
      {slashOpen && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-1.5 flex flex-col overflow-hidden rounded-md border bg-popover shadow-md">
          {matches.map((command, index) => (
            <ListRow
              className="items-center rounded-none px-3 py-1.5 text-xs"
              key={command.command}
              onClick={() => pickCommand(command.command)}
              selected={index === slashIndex}
            >
              <span className="font-mono">{command.command}</span>
              <span className="text-muted-foreground">{command.label}</span>
            </ListRow>
          ))}
        </div>
      )}
      {/* Label-associated textarea: clicking the composer's blank space
         natively focuses the input (no container-level mouse handler). */}
      <label className="block cursor-text" htmlFor="composer-input">
        <Textarea
          aria-label="向 agent 发送消息"
          className="min-w-0 flex-1 [&_textarea]:max-h-64 [&_textarea]:min-h-9 [&_textarea]:overflow-y-auto [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea]:text-sm [&_textarea]:leading-6"
          disabled={busy || locked}
          id="composer-input"
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
      </label>
      <div className="flex items-center gap-1.5 p-1.5">
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="打开命令面板"
                disabled={busy || locked}
                size="icon-sm"
                type="button"
                variant="ghost"
              />
            }
          >
            <SquareSlash />
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
        {modelSlot}
        {contextSlot}
        <div className="ml-auto flex items-center gap-2">
          {running && onStop && (
            <Button
              disabled={stopping || locked}
              loading={stopping}
              onClick={onStop}
              title="停止当前轮（容器保留）"
              type="button"
              variant="destructive-outline"
            >
              <Square /> 停止
            </Button>
          )}
          <ButtonGroup>
            <Button
              disabled={!draft.trim() || busy || locked}
              loading={busy}
              type="submit"
            >
              <Send />
              {running ? (deliverAs === "steer" ? "引导" : "追问") : "发送"}
            </Button>
            {running && (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label="选择投递方式"
                      size="icon"
                      type="button"
                    />
                  }
                >
                  <ChevronDown />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuRadioGroup
                    onValueChange={(value) => {
                      if (value === "steer" || value === "followUp")
                        onDeliverAsChange(value)
                    }}
                    value={deliverAs}
                  >
                    <MenuRadioItem value="steer">
                      引导（打断当前轮）
                    </MenuRadioItem>
                    <MenuRadioItem value="followUp">
                      追问（下一轮投递）
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
            )}
          </ButtonGroup>
        </div>
      </div>
    </form>
  )
}

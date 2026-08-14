import { ChevronDown, Plus, Send, Square } from "lucide-react"
import { useRef } from "react"

import { Button } from "@/components/ui/button"
import { ButtonGroup, GroupSeparator } from "@/components/ui/group"
import { Input } from "@/components/ui/input"
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu"

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
  const inputRef = useRef<HTMLInputElement>(null)
  const pickCommand = (command: string) => {
    onDraftChange(command)
    // Menu restores focus to its trigger on close; move it back to the
    // composer so the user can edit or send the command immediately.
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  return (
    <form
      className="flex w-full items-center gap-2"
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
      <Input
        aria-label="向 agent 发送消息"
        className="flex-1"
        disabled={busy || locked}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={placeholder}
        ref={inputRef}
        unstyled
        value={draft}
      />
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
        {running && (
          <>
            <GroupSeparator />
            <Menu>
              <MenuTrigger
                render={
                  <Button aria-label="投递方式" size="icon" variant="outline" />
                }
              >
                <ChevronDown />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuRadioGroup
                  onValueChange={(value) =>
                    onDeliverAsChange(value as "steer" | "followUp")
                  }
                  value={deliverAs}
                >
                  <MenuRadioItem value="steer">引导</MenuRadioItem>
                  <MenuRadioItem value="followUp">追问</MenuRadioItem>
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          </>
        )}
      </ButtonGroup>
    </form>
  )
}

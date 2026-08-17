import { Puzzle } from "lucide-react"

import type { Challenge } from "@/api"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { ChannelsView } from "@/features/runs/channels-view"

/** Challenge-level IM (v17 knowledge base): the challenge's #team/#announce,
 * shared across every run of the challenge. Opened from the challenge node in
 * AgentsGraph. */
export function ChallengeImDialog({
  challenge,
  onClose,
}: {
  challenge: Challenge
  onClose: () => void
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup className="flex h-[min(85svh,52rem)] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle>
            <span className="flex min-w-0 items-center gap-2">
              <Puzzle className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{challenge.name}</span>
            </span>
          </DialogTitle>
          <DialogDescription>
            {challenge.category ?? "未分类"}
            {challenge.points != null ? ` · ${challenge.points} 分` : ""}
            {" · "}
            题目频道（#team / #announce，同题跨 run 共享）
          </DialogDescription>
        </DialogHeader>
        {/* Plain flex, NOT DialogPanel (which would scroll the composer along
            with the timeline) — same layout as AgentDialog. */}
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          <ChannelsView challengeId={challenge.id} />
        </div>
      </DialogPopup>
    </Dialog>
  )
}

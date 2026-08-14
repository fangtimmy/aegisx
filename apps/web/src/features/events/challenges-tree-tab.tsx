import { ChevronRight, Flag } from "lucide-react"
import { useMemo } from "react"

import type { Challenge } from "@/api"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CreateRunDialog } from "@/features/runs"
import { cn } from "@/lib/utils"

import { UNCATEGORIZED } from "./event-agents-shared"
import { isChallengeSolved } from "./event-shared"

export function ChallengesTreeTab({ challenges }: { challenges: Challenge[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, Challenge[]>()
    for (const challenge of challenges) {
      const category = challenge.category || UNCATEGORIZED
      const list = map.get(category) ?? []
      list.push(challenge)
      map.set(category, list)
    }
    return [...map.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "zh-Hans-CN", { sensitivity: "base" })
    )
  }, [challenges])

  if (challenges.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>暂无题目</EmptyTitle>
          <EmptyDescription>在「题目」标签页添加题目。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-3 p-1">
        {groups.map(([category, items]) => (
          <Collapsible key={category}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform data-panel-open:rotate-90" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {category}
              </span>
              <Badge size="sm" variant="secondary">
                {items.length}
              </Badge>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="flex flex-col">
                {items.map((challenge) => (
                  <ChallengeRow challenge={challenge} key={challenge.id} />
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ))}
      </div>
    </ScrollArea>
  )
}

function ChallengeRow({ challenge }: { challenge: Challenge }) {
  const solved = isChallengeSolved(challenge)
  return (
    <CreateRunDialog
      challenge={challenge}
      trigger={
        <>
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              solved ? "bg-success" : "bg-muted-foreground/40"
            )}
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {challenge.name}
          </span>
          {challenge.points !== null && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {challenge.points}
            </span>
          )}
          {solved && (
            <Badge size="sm" variant="success">
              <Flag /> 已解决
            </Badge>
          )}
        </>
      }
      triggerClassName="h-auto w-full min-w-0 justify-start rounded-md px-7 py-2 font-normal"
      triggerVariant="ghost"
    />
  )
}

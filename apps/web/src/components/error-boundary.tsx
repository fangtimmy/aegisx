import { Component, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

type Props = {
  children: ReactNode
}
type State = { error: Error | null }

/** Contains a render crash to one region (timeline, graph) instead of the
 * route-level fallback, so the rest of the page keeps its context. Retry
 * clears the error and remounts the subtree. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error(error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-medium">渲染出错</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {this.state.error.message}
          </p>
          <Button
            onClick={() => this.setState({ error: null })}
            size="sm"
            type="button"
            variant="outline"
          >
            重试
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}

import { useEffect } from "react"
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Link,
  Navigate,
  RouterProvider,
  useRouteError,
} from "react-router"

import { Button } from "@/components/ui/button"
import { AnchoredToastProvider, ToastProvider } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { HomePage } from "@/features/events/home-page"
import { startConversationStream } from "@/stream/conversation-store"

const settingsSections = ["general", "models", "prompts", "settings"] as const
const eventTabs = [
  "agents",
  "challenges",
  "tasks",
  "stats",
  "settings",
] as const

const loadEventPage = () =>
  import("@/features/events/event-page").then((m) => ({
    Component: m.EventPage,
  }))
const loadSettingsPage = () =>
  import("@/features/settings/settings-page").then((m) => ({
    Component: m.SettingsPage,
  }))

/** Root error boundary: render errors in any route, or an unmatched URL (404). */
function RouteError() {
  const error = useRouteError()
  const notFound = isRouteErrorResponse(error) && error.status === 404
  const message =
    error instanceof Error
      ? error.message
      : isRouteErrorResponse(error)
        ? `${error.status} ${error.statusText}`
        : "未知错误"
  console.error(error)
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <h1 className="text-lg font-semibold">
          {notFound ? "页面不存在" : "页面出错了"}
        </h1>
        {!notFound && (
          <p className="text-sm text-muted-foreground">{message}</p>
        )}
        <Button render={<Link to="/" />} variant="outline">
          回到首页
        </Button>
      </div>
    </div>
  )
}

const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    children: [
      { path: "/", Component: HomePage },
      {
        path: "/settings",
        element: <Navigate replace to="/settings/settings" />,
      },
      ...settingsSections.map((section) => ({
        path: `/settings/${section}`,
        lazy: loadSettingsPage,
      })),
      { path: "/events/:eventId", lazy: loadEventPage },
      ...eventTabs.map((tab) => ({
        path: `/events/:eventId/${tab}`,
        lazy: loadEventPage,
      })),
      {
        path: "/settings/templates",
        element: <Navigate replace to="/settings/prompts" />,
      },
    ],
  },
])

/** The app's single live connection (see conversation-store): mounted at the
 * root so every view shares one EventSource, whichever page is up. */
function LiveStream() {
  useEffect(() => startConversationStream(), [])
  return null
}

function App() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <LiveStream />
          <RouterProvider router={router} />
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  )
}

export default App

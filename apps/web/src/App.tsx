import { createBrowserRouter, RouterProvider } from "react-router"
import { TooltipProvider } from "@/components/ui/tooltip"
import { EventPage } from "@/features/events/event-page"
import { HomePage } from "@/features/events/home-page"
import { SettingsPage } from "@/features/settings/settings-page"

const router = createBrowserRouter([
  { path: "/", Component: HomePage },
  { path: "/settings", Component: SettingsPage },
  { path: "/events/:eventId", Component: EventPage },
  { path: "/events/:eventId/run", Component: EventPage },
  { path: "/events/:eventId/runs/:runId", Component: EventPage },
  { path: "/events/:eventId/statistics", Component: EventPage },
  { path: "/events/:eventId/settings", Component: EventPage },
])

export function App() {
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  )
}

export default App

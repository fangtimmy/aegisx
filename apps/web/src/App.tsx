import { createBrowserRouter, Navigate, RouterProvider } from "react-router"
import { AnchoredToastProvider, ToastProvider } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { EventPage } from "@/features/events/event-page"
import { HomePage } from "@/features/events/home-page"
import { SettingsPage } from "@/features/settings/settings-page"

const router = createBrowserRouter([
  { path: "/", Component: HomePage },
  { path: "/settings", element: <Navigate replace to="/settings/general" /> },
  { path: "/settings/general", Component: SettingsPage },
  { path: "/settings/models", Component: SettingsPage },
  { path: "/settings/prompts", Component: SettingsPage },
  { path: "/settings/runtime", Component: SettingsPage },
  { path: "/events/:eventId", Component: EventPage },
  { path: "/events/:eventId/run", Component: EventPage },
  { path: "/events/:eventId/runs/:runId", Component: EventPage },
  { path: "/events/:eventId/statistics", Component: EventPage },
  { path: "/events/:eventId/settings", Component: EventPage },
])

export function App() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  )
}

export default App

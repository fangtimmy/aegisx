import { createBrowserRouter, Navigate, RouterProvider } from "react-router"

import { AnchoredToastProvider, ToastProvider } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { EventPage } from "@/features/events/event-page"
import { HomePage } from "@/features/events/home-page"
import { SettingsPage } from "@/features/settings/settings-page"

const settingsSections = [
  "general",
  "models",
  "settings",
  "orchestration",
] as const
const eventTabs = ["agents", "challenges", "settings"] as const

const router = createBrowserRouter([
  { path: "/", Component: HomePage },
  { path: "/settings", element: <Navigate replace to="/settings/settings" /> },
  ...settingsSections.map((section) => ({
    path: `/settings/${section}`,
    Component: SettingsPage,
  })),
  {
    path: "/settings/prompts",
    element: <Navigate replace to="/settings/orchestration" />,
  },
  {
    path: "/settings/templates",
    element: <Navigate replace to="/settings/orchestration" />,
  },
  { path: "/events/:eventId", Component: EventPage },
  ...eventTabs.map((tab) => ({
    path: `/events/:eventId/${tab}`,
    Component: EventPage,
  })),
])

function App() {
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

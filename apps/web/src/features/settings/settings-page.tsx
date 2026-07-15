import { AppLayout } from "@/components/app-layout"
import { SettingsScreen } from "./settings-screen"

export function SettingsPage() {
  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="font-semibold text-2xl">Settings</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Configure model and runtime defaults for new runs.
        </p>
      </div>
      <SettingsScreen />
    </AppLayout>
  )
}

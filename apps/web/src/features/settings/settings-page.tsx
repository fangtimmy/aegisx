import { ProductHeader } from "@/components/product-header"
import { SettingsScreen } from "./settings-screen"

export function SettingsPage() {
  return (
    <div className="min-h-svh bg-muted/30">
      <ProductHeader />
      <main className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 sm:py-9">
        <h1 className="font-semibold text-2xl">Settings</h1>
        <p className="mt-1 mb-7 text-muted-foreground text-sm">
          Configure model and runtime defaults for new runs.
        </p>
        <SettingsScreen />
      </main>
    </div>
  )
}

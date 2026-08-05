import { AppLayout } from "@/components/shell/app-layout"
import { SettingsScreen } from "./settings-screen"

export function SettingsPage() {
  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="font-semibold text-2xl">设置</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          为新任务配置模型与运行时默认值。
        </p>
      </div>
      <SettingsScreen />
    </AppLayout>
  )
}

import { Download, Monitor, Moon, Sun, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { settingsApi } from "@/api"
import { useTheme } from "@/components/shell/theme-provider"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Radio, RadioGroup } from "@/components/ui/radio-group"

const themes = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const

type Theme = (typeof themes)[number]["value"]

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system"
}

function themePreview(theme: Theme) {
  if (theme === "system") {
    return (
      <div className="grid h-full grid-cols-2">
        <div className="bg-neutral-200 p-2">
          <div className="h-full rounded-md bg-white p-2">
            <div className="size-3 rounded-full bg-neutral-300" />
            <div className="mt-3 h-1 rounded-full bg-neutral-200" />
            <div className="mt-1 h-1 rounded-full bg-neutral-200" />
          </div>
        </div>
        <div className="bg-neutral-900 p-2">
          <div className="h-full rounded-md bg-neutral-800 p-2">
            <div className="size-3 rounded-full bg-neutral-600" />
            <div className="mt-3 h-1 rounded-full bg-neutral-700" />
            <div className="mt-1 h-1 rounded-full bg-neutral-700" />
          </div>
        </div>
      </div>
    )
  }
  const dark = theme === "dark"
  return (
    <div
      className={
        dark ? "h-full bg-neutral-900 p-2" : "h-full bg-neutral-200 p-2"
      }
    >
      <div
        className={
          dark
            ? "h-full rounded-md bg-neutral-800 p-2"
            : "h-full rounded-md bg-white p-2"
        }
      >
        <div
          className={
            dark
              ? "size-3 rounded-full bg-neutral-600"
              : "size-3 rounded-full bg-neutral-300"
          }
        />
        <div
          className={
            dark
              ? "mt-3 h-1 rounded-full bg-neutral-700"
              : "mt-3 h-1 rounded-full bg-neutral-200"
          }
        />
        <div
          className={
            dark
              ? "mt-1 h-1 rounded-full bg-neutral-700"
              : "mt-1 h-1 rounded-full bg-neutral-200"
          }
        />
      </div>
    </div>
  )
}

function ThemeSelector({
  theme,
  setTheme,
}: {
  theme: Theme
  setTheme: (theme: Theme) => void
}) {
  return (
    <RadioGroup
      aria-label="Theme"
      className="flex-row flex-wrap gap-4"
      onValueChange={(value) => {
        if (value === "light" || value === "dark" || value === "system") {
          setTheme(value)
        }
      }}
      value={theme}
    >
      {themes.map((item) => (
        <Label className="cursor-pointer flex-col gap-1.5" key={item.value}>
          <Radio className="peer sr-only" value={item.value} />
          <span className="relative block h-[70px] w-[112px] overflow-hidden rounded-lg shadow-xs transition-shadow not-peer-data-checked:opacity-80 peer-data-checked:ring-2 peer-data-checked:ring-primary/48 peer-data-checked:ring-offset-1 peer-data-checked:ring-offset-background">
            {themePreview(item.value)}
          </span>
          <span className="flex items-center gap-1.5 text-sm">
            {item.value === "system" ? (
              <Monitor className="size-3.5" />
            ) : item.value === "light" ? (
              <Sun className="size-3.5" />
            ) : (
              <Moon className="size-3.5" />
            )}
            {item.label}
          </span>
        </Label>
      ))}
    </RadioGroup>
  )
}

function SettingsTransfer({
  theme,
  setTheme,
}: {
  theme: Theme
  setTheme: (theme: Theme) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function exportSettings() {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch("/api/settings/export")
      if (!response.ok) throw new Error("Unable to export settings")
      const data = await response.json()
      const content = JSON.stringify(
        {
          ...data,
          appearance: { theme },
        },
        null,
        2
      )
      const url = URL.createObjectURL(
        new Blob([content], { type: "application/json" })
      )
      const link = window.document.createElement("a")
      link.href = url
      link.download = "aegisx-settings.json"
      link.click()
      URL.revokeObjectURL(url)
      setMessage("Settings exported.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed")
    } finally {
      setPending(false)
    }
  }

  async function importSettings(file: File) {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const document = JSON.parse(await file.text()) as {
        version?: number
        settings?: unknown
        providers?: unknown
        appearance?: { theme?: unknown }
      }
      if (
        document.version !== 1 ||
        !document.settings ||
        !Array.isArray(document.providers)
      ) {
        throw new Error("Unsupported settings file (expected version 1)")
      }
      await settingsApi.importSettingsPayload({
        version: 1,
        settings: document.settings,
        providers: document.providers,
      })
      if (document.appearance?.theme && isTheme(document.appearance.theme)) {
        setTheme(document.appearance.theme)
      }
      setMessage("Settings imported.")
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed")
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending}
          onClick={() => void exportSettings()}
          type="button"
          variant="outline"
        >
          <Download /> Export
        </Button>
        <Button
          disabled={pending}
          onClick={() => inputRef.current?.click()}
          type="button"
          variant="outline"
        >
          <Upload /> Import
        </Button>
        <input
          accept="application/json,.json"
          className="sr-only"
          onChange={(event) => {
            const nextFile = event.target.files?.[0]
            if (nextFile) void importSettings(nextFile)
            event.target.value = ""
          }}
          ref={inputRef}
          type="file"
        />
      </div>
      {message && (
        <Alert className="mt-3">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert className="mt-3" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  )
}

export function GeneralSettings() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="grid min-w-0 gap-4">
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>Appearance</CardFrameTitle>
          <CardFrameDescription>
            Choose how AegisX looks on this device.
          </CardFrameDescription>
        </CardFrameHeader>
        <Card>
          <CardPanel>
            <ThemeSelector setTheme={setTheme} theme={theme} />
          </CardPanel>
        </Card>
      </CardFrame>
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>Configuration transfer</CardFrameTitle>
          <CardFrameDescription>
            Export or import settings and providers (version 1 JSON).
          </CardFrameDescription>
        </CardFrameHeader>
        <Card>
          <CardPanel>
            <SettingsTransfer setTheme={setTheme} theme={theme} />
          </CardPanel>
        </Card>
      </CardFrame>
    </div>
  )
}

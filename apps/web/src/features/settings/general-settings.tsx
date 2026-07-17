import { Download, Monitor, Moon, Sun, Upload } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTheme } from "@/components/theme-provider"
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
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Radio, RadioGroup } from "@/components/ui/radio-group"
import { apiRequest } from "@/lib/api"

const themes = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const

const transferSections = [
  { label: "Appearance", value: "appearance" },
  { label: "Runtime defaults", value: "runtime" },
  { label: "Agent prompts", value: "prompts" },
  { label: "Model providers", value: "providers" },
] as const

type TransferSection = (typeof transferSections)[number]["value"]
type TransferMode = "export" | "import"
type Theme = (typeof themes)[number]["value"]

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system"
}

const allSections = transferSections.map((item) => item.value)
const runtimeKeys = [
  "defaultModelId",
  "environment",
  "containerImage",
  "cpus",
  "memoryMb",
  "pidsLimit",
  "maxConcurrency",
] as const
const promptKeys = [
  "mainSystemPromptTemplate",
  "childSystemPromptTemplate",
  "initialPromptTemplate",
] as const

type TransferDocument = {
  version: 1
  included?: TransferSection[]
  appearance?: { theme?: Theme }
  settings: Record<string, unknown>
  providers: unknown[]
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

function transferSettings(
  document: TransferDocument,
  sections: TransferSection[],
  theme: Theme
) {
  const settings: Record<string, unknown> = {}
  if (sections.includes("runtime")) {
    for (const key of runtimeKeys) settings[key] = document.settings[key]
  }
  if (sections.includes("prompts")) {
    for (const key of promptKeys) settings[key] = document.settings[key]
  }
  return {
    version: 1 as const,
    included: sections,
    appearance: sections.includes("appearance") ? { theme } : undefined,
    settings,
    providers: sections.includes("providers") ? document.providers : [],
  }
}

function ImportExportDialog({
  file,
  mode,
  open,
  onOpenChange,
  onComplete,
  setTheme,
  theme,
}: {
  file: TransferDocument | null
  mode: TransferMode
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: (message: string) => void
  setTheme: (theme: Theme) => void
  theme: Theme
}) {
  const [selected, setSelected] = useState<TransferSection[]>(allSections)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const included =
      mode === "import"
        ? file?.included?.filter((value) => allSections.includes(value))
        : undefined
    setSelected(included?.length ? included : allSections)
    setError(null)
  }, [file, mode, open])

  function toggle(section: TransferSection, checked: boolean) {
    setSelected((current) =>
      checked
        ? [...new Set([...current, section])]
        : current.filter((item) => item !== section)
    )
  }

  async function submit() {
    if (selected.length === 0) {
      setError("Select at least one item")
      return
    }
    setPending(true)
    setError(null)
    try {
      if (mode === "export") {
        const response = await fetch("/api/settings/export")
        if (!response.ok) throw new Error("Unable to export settings")
        const data = (await response.json()) as TransferDocument
        const content = JSON.stringify(
          transferSettings(data, selected, theme),
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
        onComplete("Settings exported.")
      } else {
        if (!file) throw new Error("Choose a settings file first")
        const current = (await (
          await fetch("/api/settings/export")
        ).json()) as TransferDocument
        const merged = {
          ...current,
          settings: { ...current.settings, ...file.settings },
          providers: selected.includes("providers")
            ? file.providers
            : current.providers,
        }
        if (!selected.includes("runtime")) {
          for (const key of runtimeKeys) delete merged.settings[key]
          for (const key of runtimeKeys)
            merged.settings[key] = current.settings[key]
        }
        if (!selected.includes("prompts")) {
          for (const key of promptKeys) delete merged.settings[key]
          for (const key of promptKeys)
            merged.settings[key] = current.settings[key]
        }
        await apiRequest("/settings/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: 1,
            settings: merged.settings,
            providers: merged.providers,
          }),
        })
        if (selected.includes("appearance") && file.appearance?.theme) {
          if (!isTheme(file.appearance.theme)) {
            throw new Error("Invalid appearance setting")
          }
          setTheme(file.appearance.theme)
        }
        onComplete("Settings imported.")
        window.location.reload()
      }
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transfer failed")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {mode === "export" ? "Export settings" : "Import settings"}
          </DialogTitle>
          <DialogDescription>
            Choose which settings to{" "}
            {mode === "export" ? "include in the JSON file" : "replace"}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3">
          {transferSections.map((item) => (
            <Label
              className="items-start gap-3 rounded-md border p-3"
              key={item.value}
            >
              <Checkbox
                checked={selected.includes(item.value)}
                onCheckedChange={(checked) =>
                  toggle(item.value, checked === true)
                }
              />
              <span>
                <span className="block font-medium text-sm">{item.label}</span>
                <span className="block text-muted-foreground text-xs">
                  {item.value === "appearance"
                    ? "Theme preference"
                    : item.value === "providers"
                      ? "Provider API keys and models"
                      : item.label}
                </span>
              </span>
            </Label>
          ))}
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            Cancel
          </DialogClose>
          <Button disabled={pending} onClick={submit} type="button">
            {mode === "export" ? <Download /> : <Upload />}
            {mode === "export" ? "Export" : "Import"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function SettingsTransfer({
  setTheme,
  theme,
}: {
  setTheme: (theme: Theme) => void
  theme: Theme
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<TransferMode>("export")
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<TransferDocument | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function chooseImport(nextFile: File) {
    try {
      const document = JSON.parse(await nextFile.text()) as TransferDocument
      if (
        document.version !== 1 ||
        !document.settings ||
        !Array.isArray(document.providers)
      ) {
        throw new Error("Unsupported settings file")
      }
      setFile(document)
      setMode("import")
      setOpen(true)
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Invalid settings file"
      )
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            setMode("export")
            setFile(null)
            setOpen(true)
          }}
          type="button"
          variant="outline"
        >
          <Download /> Export
        </Button>
        <Button
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
            if (nextFile) void chooseImport(nextFile)
            event.target.value = ""
          }}
          ref={inputRef}
          type="file"
        />
      </div>
      {message && (
        <Alert className="mt-3" variant="error">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <ImportExportDialog
        file={file}
        mode={mode}
        open={open}
        onComplete={setMessage}
        onOpenChange={setOpen}
        setTheme={setTheme}
        theme={theme}
      />
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
            Export or import selected settings.
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

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
import { Switch } from "@/components/ui/switch"
import {
  useMarkdownPrefs,
  type MarkdownArea,
  type MarkdownPrefs,
} from "@/lib/markdown-prefs"

const themes = [
  { label: "跟随系统", value: "system" },
  { label: "浅色", value: "light" },
  { label: "深色", value: "dark" },
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
      aria-label="主题"
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

const markdownAreas: {
  key: MarkdownArea
  label: string
  description: string
}[] = [
  {
    key: "assistant",
    label: "Assistant 输出",
    description: "agent 的正文回复",
  },
  { key: "user", label: "用户消息", description: "你发送的消息" },
  { key: "thinking", label: "推理内容", description: "reasoning 块" },
  {
    key: "system",
    label: "系统消息",
    description: "系统提示词、压缩摘要等",
  },
]

function MarkdownSettings() {
  const [prefs, setPrefs] = useMarkdownPrefs()
  return (
    <div className="grid gap-4">
      {markdownAreas.map((area) => (
        <div className="flex items-center justify-between gap-4" key={area.key}>
          <Label className="grid items-start gap-0.5">
            <span>{area.label}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {area.description}
            </span>
          </Label>
          <Switch
            aria-label={area.label}
            checked={prefs[area.key]}
            onCheckedChange={(checked) =>
              setPrefs({ [area.key]: checked } as Partial<MarkdownPrefs>)
            }
          />
        </div>
      ))}
    </div>
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
      if (!response.ok) throw new Error("无法导出设置")
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
      setMessage("设置已导出。")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败")
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
        throw new Error("不支持设置文件（预期版本 1）")
      }
      await settingsApi.importSettingsPayload({
        version: 1,
        settings: document.settings,
        providers: document.providers,
      })
      if (document.appearance?.theme && isTheme(document.appearance.theme)) {
        setTheme(document.appearance.theme)
      }
      setMessage("设置已导入。")
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败")
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
          <Download /> 导出
        </Button>
        <Button
          disabled={pending}
          onClick={() => inputRef.current?.click()}
          type="button"
          variant="outline"
        >
          <Upload /> 导入
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
          <CardFrameTitle>外观</CardFrameTitle>
          <CardFrameDescription>
            选择 AegisX 在本设备上的显示方式。
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
          <CardFrameTitle>消息渲染</CardFrameTitle>
          <CardFrameDescription>
            控制时间线中各类内容是否渲染 Markdown，关闭后按纯文本显示。
          </CardFrameDescription>
        </CardFrameHeader>
        <Card>
          <CardPanel>
            <MarkdownSettings />
          </CardPanel>
        </Card>
      </CardFrame>
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>配置迁移</CardFrameTitle>
          <CardFrameDescription>
            导出或导入设置与供应商（版本 1 JSON）。
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

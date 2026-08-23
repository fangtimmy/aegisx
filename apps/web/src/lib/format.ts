const formatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  return formatter.format(new Date(value))
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

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

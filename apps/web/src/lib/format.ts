const formatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  return formatter.format(new Date(value))
}

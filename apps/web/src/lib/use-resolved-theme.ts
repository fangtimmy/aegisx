import { useEffect, useState } from "react"

/**
 * Resolve the actually-applied theme by watching `<html>`'s class list.
 * More reliable than `useTheme()` for rendering (which can report "system"),
 * since it reflects whatever ThemeProvider applied to the document.
 */
export function useResolvedTheme(): "dark" | "light" {
  const [resolved, setResolved] = useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  )
  useEffect(() => {
    const el = document.documentElement
    const sync = () =>
      setResolved(el.classList.contains("dark") ? "dark" : "light")
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return resolved
}

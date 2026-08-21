import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Fit a textarea to its content: reset then pin to scrollHeight so the
 * CSS min/max heights still bound it (overflow scrolls past max). Call on
 * every value change. */
export function autoSizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight}px`
}

function normalizeToLf(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n")
  const lf = content.indexOf("\n")
  if (lf === -1) return "\n"
  if (crlf === -1) return "\n"
  return crlf < lf ? "\r\n" : "\n"
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n") {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content }
}

/** Normalize quotes/dashes/spaces and strip trailing whitespace per line (pi/claude style). */
function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // dashes/hyphens → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // special spaces → regular space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  )
}

function countOccurrences(content: string, needle: string) {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (true) {
    const index = content.indexOf(needle, from)
    if (index === -1) break
    count += 1
    from = index + needle.length
  }
  return count
}

function normalizeChar(char: string): string {
  if (/[\u2018\u2019\u201A\u201B]/.test(char)) return "'"
  if (/[\u201C\u201D\u201E\u201F]/.test(char)) return '"'
  if (/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/.test(char)) return "-"
  if (/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/.test(char)) return " "
  return char.normalize("NFKC")
}

/**
 * Build fuzzy-normalized string with a map from each fuzzy index → original index.
 * Trailing whitespace on each line is dropped from the fuzzy view.
 */
function buildFuzzyMap(content: string): { fuzzy: string; map: number[] } {
  let fuzzy = ""
  const map: number[] = []
  const lines = content.split("\n")
  let origin = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ""
    let end = line.length
    while (end > 0 && /\s/.test(line[end - 1] ?? "")) end -= 1
    for (let i = 0; i < end; i += 1) {
      const ch = line[i] ?? ""
      const normalized = normalizeChar(ch)
      for (const unit of normalized) {
        fuzzy += unit
        map.push(origin + i)
      }
    }
    if (lineIndex < lines.length - 1) {
      fuzzy += "\n"
      map.push(origin + line.length)
      origin += line.length + 1
    }
  }
  return { fuzzy, map }
}

function fuzzyRanges(
  content: string,
  oldText: string
): Array<{ start: number; end: number }> {
  const { fuzzy, map } = buildFuzzyMap(content)
  const needle = normalizeForFuzzyMatch(oldText)
  if (!needle) return []
  const ranges: Array<{ start: number; end: number }> = []
  let from = 0
  while (true) {
    const index = fuzzy.indexOf(needle, from)
    if (index === -1) break
    const lastFuzzy = index + needle.length - 1
    const start = map[index]
    const endExclusive = (map[lastFuzzy] ?? start) + 1
    if (start !== undefined) {
      ranges.push({ start, end: endExclusive })
    }
    from = index + needle.length
  }
  return ranges
}

export type ApplyEditResult = {
  content: string
  replacements: number
  diff: string
  usedFuzzyMatch: boolean
}

export function applyExactEdit(
  original: string,
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): ApplyEditResult {
  if (oldString === newString) {
    throw new Error(
      "No changes to apply: oldString and newString are identical."
    )
  }
  if (!oldString) {
    throw new Error(`oldString must not be empty in ${filePath}.`)
  }

  const { bom, text: withoutBom } = stripBom(original)
  const ending = detectLineEnding(withoutBom)
  const content = normalizeToLf(withoutBom)
  const oldText = normalizeToLf(oldString)
  const newText = normalizeToLf(newString)

  let usedFuzzyMatch = false
  let next = content
  let replacements = 0
  let matchedOld = oldText
  let matchIndex = content.indexOf(oldText)

  const exactCount = countOccurrences(content, oldText)
  if (exactCount > 0) {
    if (!replaceAll && exactCount > 1) {
      throw new Error(
        `Found ${exactCount} matches for oldString in ${filePath}. Provide more surrounding lines to identify the correct match, or set replaceAll: true.`
      )
    }
    next = replaceAll
      ? content.split(oldText).join(newText)
      : content.replace(oldText, newText)
    replacements = replaceAll ? exactCount : 1
    matchIndex = content.indexOf(oldText)
  } else {
    const ranges = fuzzyRanges(content, oldText)
    if (ranges.length === 0) {
      throw new Error(
        `oldString not found in content of ${filePath}. Tried exact match and fuzzy match (smart quotes, dashes, trailing whitespace). Provide more surrounding context.`
      )
    }
    if (!replaceAll && ranges.length > 1) {
      throw new Error(
        `Found ${ranges.length} fuzzy matches for oldString in ${filePath}. Provide more surrounding lines to identify the correct match, or set replaceAll: true.`
      )
    }
    usedFuzzyMatch = true
    const first = ranges[0]
    if (!first) {
      throw new Error(
        `oldString not found in content of ${filePath}. Tried exact match and fuzzy match (smart quotes, dashes, trailing whitespace). Provide more surrounding context.`
      )
    }
    const applyRanges = replaceAll ? ranges : [first]
    // Apply from end so earlier offsets stay valid.
    const ordered = applyRanges.toSorted((a, b) => b.start - a.start)
    const firstInFile = ordered[ordered.length - 1] ?? first
    matchIndex = firstInFile.start
    matchedOld = content.slice(firstInFile.start, firstInFile.end)
    for (const range of ordered) {
      matchedOld = content.slice(range.start, range.end)
      next = next.slice(0, range.start) + newText + next.slice(range.end)
    }
    // Prefer the first occurrence in file for line numbers.
    matchedOld = content.slice(firstInFile.start, firstInFile.end)
    replacements = applyRanges.length
  }

  if (next === content) {
    throw new Error(
      `No changes made to ${filePath}. The replacement produced identical content.`
    )
  }

  const startLine = lineNumberAt(content, Math.max(0, matchIndex))
  const restored = bom + restoreLineEndings(next, ending)
  return {
    content: restored,
    replacements,
    usedFuzzyMatch,
    diff: formatReplacementDiff(
      filePath,
      matchedOld,
      newText,
      startLine,
      replacements
    ),
  }
}

function lineNumberAt(content: string, index: number) {
  if (index <= 0) return 1
  return content.slice(0, index).split("\n").length
}

function patchPath(filePath: string) {
  return filePath.replace(/^\/+/, "") || filePath
}

function countLines(text: string) {
  if (text.length === 0) return 0
  return text.split("\n").length
}

function formatReplacementDiff(
  filePath: string,
  oldText: string,
  newText: string,
  startLine: number,
  replacements: number
) {
  const path = patchPath(filePath)
  const oldCount = countLines(oldText)
  const newCount = countLines(newText)
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${startLine},${oldCount} +${startLine},${newCount} @@ ${replacements} replacement${replacements === 1 ? "" : "s"}`,
  ]
  for (const line of oldText.split("\n")) lines.push(`-${line}`)
  for (const line of newText.split("\n")) lines.push(`+${line}`)
  return lines.join("\n")
}

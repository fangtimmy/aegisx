import {
  type BundledLanguage,
  bundledLanguages,
  createHighlighter,
  type Highlighter,
  type ShikiTransformer,
} from "shiki"

function isBundledLanguage(lang: string): lang is BundledLanguage {
  return lang in bundledLanguages
}

const THEMES = ["github-light", "github-dark-default"] as const

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    // Start empty; languages load on demand via loadLanguage.
    highlighterPromise = createHighlighter({
      themes: [...THEMES],
      langs: [],
    })
  }
  return highlighterPromise
}

async function ensureLang(highlighter: Highlighter, lang: string) {
  if (lang === "text" || lang === "plaintext" || lang === "txt") return "text"
  if (highlighter.getLoadedLanguages().includes(lang)) return lang
  if (!isBundledLanguage(lang)) return "text"
  try {
    await highlighter.loadLanguage(lang)
    return lang
  } catch {
    return "text"
  }
}

function lineNumberTransformer(startLine: number): ShikiTransformer {
  return {
    name: "aegisx-line-numbers",
    line(node, line) {
      const n = startLine + line - 1
      node.properties = {
        ...node.properties,
        "data-line": String(n),
      }
      node.children = [
        {
          type: "element",
          tagName: "span",
          properties: { class: "line-content" },
          children: node.children,
        },
      ]
    },
  }
}

export async function highlightCode(
  code: string,
  lang: string,
  theme: "light" | "dark",
  options?: { startLine?: number; lineNumbers?: boolean }
): Promise<string> {
  const highlighter = await getHighlighter()
  const resolvedLang = await ensureLang(highlighter, lang)
  const themeName = theme === "dark" ? "github-dark-default" : "github-light"
  const startLine = options?.startLine ?? 1
  const transformers =
    options?.lineNumbers === false ? [] : [lineNumberTransformer(startLine)]
  return highlighter.codeToHtml(code, {
    lang: resolvedLang,
    theme: themeName,
    transformers,
  })
}

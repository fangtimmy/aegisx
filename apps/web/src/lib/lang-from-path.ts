const EXT_LANG: Record<string, string> = {
  py: "python",
  pyi: "python",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  r: "r",
  lua: "lua",
  swift: "swift",
  vue: "vue",
  svelte: "svelte",
  diff: "diff",
  patch: "diff",
  txt: "text",
  log: "text",
}

const BASENAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  "readme.md": "markdown",
}

/** Map a file path to a Shiki language id (or "text"). */
export function langFromPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/")
  if (!normalized) return "text"
  const base = normalized.split("/").pop() ?? normalized
  const lower = base.toLowerCase()
  if (BASENAME_LANG[lower]) return BASENAME_LANG[lower]
  const dot = lower.lastIndexOf(".")
  if (dot <= 0) return "text"
  const ext = lower.slice(dot + 1)
  return EXT_LANG[ext] ?? "text"
}

import type { BundledLanguage } from "shiki"

const EXT_TO_LANG: Record<string, BundledLanguage | "text"> = {
  py: "python",
  pyw: "python",
  pyi: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  md: "markdown",
  mdx: "mdx",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "make",
  mk: "make",
  cmake: "cmake",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  swift: "swift",
  scala: "scala",
  zig: "zig",
  nim: "nim",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  wasm: "wasm",
  asm: "asm",
  s: "asm",
  ps1: "powershell",
  psm1: "powershell",
  cs: "csharp",
  fs: "fsharp",
  vb: "vb",
  tex: "latex",
  bib: "bibtex",
  env: "dotenv",
  log: "log",
  txt: "text",
}

const BASENAME_TO_LANG: Record<string, BundledLanguage | "text"> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
  cmakelists: "cmake",
  rakefile: "ruby",
  gemfile: "ruby",
  procfile: "text",
  license: "text",
  readme: "markdown",
}

export function langFromPath(path: string): BundledLanguage | "text" {
  const base = path.split("/").pop()?.toLowerCase() ?? ""
  if (!base) return "text"

  if (base in BASENAME_TO_LANG) {
    return BASENAME_TO_LANG[base]
  }

  const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base
  if (stem in BASENAME_TO_LANG) {
    return BASENAME_TO_LANG[stem]
  }

  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return "text"
  const ext = base.slice(dot + 1)
  return EXT_TO_LANG[ext] ?? "text"
}

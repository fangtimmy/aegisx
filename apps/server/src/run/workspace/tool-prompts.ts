export const READ_DESCRIPTION = `Read a file from the run workspace (or /opt/solver/** in containers).

Usage:
- Prefer this over bash cat/head for text files — output is bounded and line-numbered.
- filePath may be relative to the workspace.
- By default returns up to 2000 lines from offset 1.
- Each line is prefixed as \`<line>: <content>\` (e.g. \`1: hello\`). When using edit, match the file text WITHOUT the line-number prefix.
- Long lines are truncated to 2000 characters.
- For later sections, call again with a larger offset.
- Image files (jpeg/png/gif/webp) return path/mime/size only — bytes are not attached.
- Binary non-image files error; use bash (file/xxd/strings) instead.
- Missing files include "Did you mean" suggestions when similar names exist in the parent directory.
- Directories are not supported; use ls.`

export const WRITE_DESCRIPTION = `Create or overwrite a text file in the agent workspace.

Usage:
- Prefer edit for small changes to existing files. Use write for new files or full rewrites.
- Overwrites the target if it already exists.
- Keep generated artifacts under the run workspace.`

export const EDIT_DESCRIPTION = `Performs string replacement in a file (exact match first, then fuzzy).

Usage:
- Prefer exact oldString matches. Fuzzy match also accepts smart quotes, unicode dashes, and trailing whitespace differences.
- Do not include read-tool line-number prefixes in oldString.
- The edit FAILS if oldString is not found (exact or fuzzy).
- The edit FAILS if oldString matches multiple times unless replaceAll is true. Add surrounding context to make it unique, or set replaceAll for renames.
- oldString and newString must differ.
- Prefer edit over write for minimal patches.
- Returns a small diff of the replacement.`

export const GREP_DESCRIPTION = `Fast content search powered by ripgrep (rg). Requires rg on PATH.

Usage:
- ALWAYS prefer this over bash grep/rg for workspace search.
- Default outputMode is files_with_matches (paths only). Use content for matching lines, count for per-file counts.
- Supports full regex; set literal=true for fixed strings.
- Filter files with glob (e.g. "*.py") or type (e.g. "py", "js").
- context (-C), before (-B), after (-A) only apply when outputMode is content.
- multiline enables cross-line patterns (rg -U --multiline-dotall).
- offset skips the first N output lines; limit caps how many are returned (default 100).`

export const FIND_DESCRIPTION = `Find files by glob pattern using fd. Requires fd or fdfind on PATH.

Usage:
- Prefer this over bash find for workspace file discovery.
- pattern examples: "*.ts", "**/*.json", "src/**/*.spec.ts".
- path defaults to the workspace root (also works under /opt/solver in containers for read-only trees when resolved there).
- Results are limited (default 1000).`

export const LS_DESCRIPTION = `List entries in a workspace directory.

Usage:
- Returns names sorted as returned by the filesystem; directories have a trailing /.
- Includes dotfiles when present.
- Use limit to cap very large directories (default 500).
- Prefer find for recursive glob matching.`

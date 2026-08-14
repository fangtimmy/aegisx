export const READ_DESCRIPTION = `Read a file from the run workspace (or /opt/solver/** in containers).

Usage:
- Prefer this over bash cat/head for text files — output is bounded and line-numbered.
- filePath may be relative to the workspace.
- By default returns up to 2000 lines from offset 1.
- Each line is prefixed as \`<line>: <content>\` (e.g. \`1: hello\`). When using edit, match the file text WITHOUT the line-number prefix.
- Long lines are truncated to 2000 characters.
- For later sections, call again with a larger offset.
- Image files (jpeg/png/gif/webp) are attached when the active model accepts image input and the file is under 5MB; otherwise only path/mime/size are returned — analyze with bash (file/xxd/strings/zbarimg/steghide).
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

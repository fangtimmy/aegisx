import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"

const previewLimit = 1024 * 1024

export class WorkspaceFileError extends Error {
  constructor(readonly code: "invalid_path" | "not_found" | "not_file") {
    super(
      code === "invalid_path"
        ? "File path is outside the run workspace"
        : code === "not_found"
          ? "Workspace file not found"
          : "Path is not a file"
    )
  }
}

function isOutside(root: string, path: string) {
  const child = relative(root, path)
  return child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)
}

function openPath(workspacePath: string, requestedPath: string) {
  if (isAbsolute(requestedPath) || requestedPath.includes("\0")) {
    throw new WorkspaceFileError("invalid_path")
  }
  try {
    const root = realpathSync(workspacePath)
    const candidate = resolve(root, requestedPath || ".")
    if (isOutside(root, candidate)) {
      throw new WorkspaceFileError("invalid_path")
    }
    if (isOutside(root, realpathSync(candidate))) {
      throw new WorkspaceFileError("invalid_path")
    }
    const descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
    try {
      const path = realpathSync(`/dev/fd/${descriptor}`)
      if (isOutside(root, path)) throw new WorkspaceFileError("invalid_path")
      return {
        descriptor,
        path,
        relativePath: relative(root, path).split(sep).join("/"),
      }
    } catch (error) {
      closeSync(descriptor)
      throw error
    }
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error
    throw new WorkspaceFileError("not_found")
  }
}

function metadata(descriptor: number) {
  const stat = fstatSync(descriptor)
  return { size: stat.size, modifiedAt: stat.mtime.toISOString() }
}

export function readWorkspacePath(
  workspacePath: string,
  requestedPath: string
) {
  const resolved = openPath(workspacePath, requestedPath)
  const stat = fstatSync(resolved.descriptor)
  try {
    if (stat.isDirectory()) {
      const entries = readdirSync(resolved.path, {
        withFileTypes: true,
      })
        .flatMap((entry) => {
          const childPath = resolved.relativePath
            ? `${resolved.relativePath}/${entry.name}`
            : entry.name
          let child: ReturnType<typeof openPath> | undefined
          try {
            child = openPath(workspacePath, childPath)
            const childStat = fstatSync(child.descriptor)
            if (!childStat.isDirectory() && !childStat.isFile()) return []
            return [
              {
                name: entry.name,
                path: child.relativePath,
                type: childStat.isDirectory()
                  ? ("directory" as const)
                  : ("file" as const),
                size: childStat.size,
                modifiedAt: childStat.mtime.toISOString(),
              },
            ]
          } catch {
            return []
          } finally {
            if (child) closeSync(child.descriptor)
          }
        })
        .toSorted((left, right) =>
          left.type === right.type
            ? left.name.localeCompare(right.name)
            : left.type === "directory"
              ? -1
              : 1
        )
      return {
        path: resolved.relativePath,
        type: "directory" as const,
        entries,
      }
    }
    if (!stat.isFile()) throw new WorkspaceFileError("not_file")

    const length = Math.min(stat.size, previewLimit + 1)
    const bytes = Buffer.alloc(length)
    const bytesRead = readSync(resolved.descriptor, bytes, 0, length, 0)
    const contentBytes = bytes.subarray(0, bytesRead)
    const sample = contentBytes.subarray(0, Math.min(contentBytes.length, 8192))
    try {
      if (sample.includes(0)) throw new Error("binary")
      new TextDecoder("utf-8", { fatal: true }).decode(sample)
    } catch {
      return {
        path: resolved.relativePath,
        type: "binary" as const,
        ...metadata(resolved.descriptor),
      }
    }
    return {
      path: resolved.relativePath,
      type: "text" as const,
      ...metadata(resolved.descriptor),
      content: new TextDecoder().decode(contentBytes.subarray(0, previewLimit)),
      truncated: stat.size > previewLimit,
    }
  } finally {
    closeSync(resolved.descriptor)
  }
}

export function workspaceDownload(
  workspacePath: string,
  requestedPath: string
) {
  const resolved = openPath(workspacePath, requestedPath)
  if (!fstatSync(resolved.descriptor).isFile()) {
    closeSync(resolved.descriptor)
    throw new WorkspaceFileError("not_file")
  }
  return {
    stream: Readable.toWeb(
      createReadStream("", { fd: resolved.descriptor, autoClose: true })
    ),
    filename: basename(resolved.relativePath),
  }
}

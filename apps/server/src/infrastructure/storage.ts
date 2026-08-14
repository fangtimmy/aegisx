import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const defaultMaxAttachmentBytes = 512 * 1024 * 1024

export class StorageLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(
      `Attachment exceeds the ${Math.floor(limitBytes / 1024 / 1024)} MiB limit`
    )
  }
}

export function createStorage(dataDir: string) {
  const attachmentsDir = join(dataDir, "attachments")
  const incomingDir = join(dataDir, ".incoming")
  const trashDir = join(dataDir, ".trash")
  mkdirSync(attachmentsDir, { recursive: true })
  mkdirSync(incomingDir, { recursive: true })
  mkdirSync(trashDir, { recursive: true })
  rmSync(trashDir, { recursive: true, force: true })
  mkdirSync(trashDir, { recursive: true })

  function attachmentPath(storageKey: string) {
    return join(attachmentsDir, ...storageKey.split("/"))
  }

  async function write(
    storageKey: string,
    body: ReadableStream<Uint8Array> | null,
    maxBytes = defaultMaxAttachmentBytes
  ) {
    if (!body) throw new Error("Attachment body is empty")
    const temporaryPath = join(incomingDir, crypto.randomUUID())
    const finalPath = attachmentPath(storageKey)
    mkdirSync(dirname(finalPath), { recursive: true })
    const writer = Bun.file(temporaryPath).writer()
    const reader = body.getReader()
    const hash = createHash("sha256")
    let size = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel()
          throw new StorageLimitError(maxBytes)
        }
        hash.update(value)
        writer.write(value)
      }
      await writer.end()
      renameSync(temporaryPath, finalPath)
      return { size, sha256: hash.digest("hex") }
    } catch (error) {
      await writer.end()
      rmSync(temporaryPath, { force: true })
      throw error
    }
  }

  function moveToTrash(path: string) {
    if (!existsSync(path)) return undefined
    const trashedPath = join(trashDir, crypto.randomUUID())
    renameSync(path, trashedPath)
    return trashedPath
  }

  return {
    eventPath: (eventId: string) => join(attachmentsDir, eventId),
    challengePath: (eventId: string, challengeId: string) =>
      join(attachmentsDir, eventId, challengeId),
    attachmentPath,
    write,
    moveToTrash,
    restore: (trashedPath: string, path: string) => {
      mkdirSync(dirname(path), { recursive: true })
      renameSync(trashedPath, path)
    },
    purge: (path: string | undefined) => {
      if (path) rmSync(path, { recursive: true, force: true })
    },
    remove: (storageKey: string) =>
      rmSync(attachmentPath(storageKey), { force: true }),
  }
}

export function isSafeFilename(filename: string) {
  const hasForbiddenCharacter = [...filename].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 || character === "/" || character === "\\"
  })
  return (
    filename.length > 0 &&
    filename.length <= 255 &&
    filename !== "." &&
    filename !== ".." &&
    !hasForbiddenCharacter
  )
}

declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream"

  interface TarHeader {
    name: string
    mode?: number
    mtime?: Date | number
    type?: string
    size?: number
    uid?: number
    gid?: number
    uname?: string
    gname?: string
  }

  interface TarPack extends Readable {
    entry(header: TarHeader, content?: string | Uint8Array | null): this
    finalize(): this
  }

  interface TarExtract extends Writable {
    on(
      event: "entry",
      listener: (
        header: TarHeader & { blocks: number },
        stream: Readable,
        next: () => void
      ) => void
    ): this
    on(event: "finish", listener: () => void): this
    on(event: "error", listener: (err: Error) => void): this
  }

  const tarStream: {
    pack(): TarPack
    extract(): TarExtract
  }

  export default tarStream
}

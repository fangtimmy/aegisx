import { A1CtfAdapter } from "./platform-a1ctf"
import type { CtfPlatformAdapter, PlatformConfig } from "./platform-core"
import { CtfdAdapter } from "./platform-ctfd"
import { Ret2ShellAdapter } from "./platform-ret2shell"

export * from "./platform-core"

export function createPlatformAdapter(
  config: PlatformConfig,
  onCredential?: (credential: string) => void
): CtfPlatformAdapter {
  if (config.type === "ctfd") return new CtfdAdapter(config)
  if (config.type === "ret2shell") {
    return new Ret2ShellAdapter(config, onCredential)
  }
  return new A1CtfAdapter(config)
}

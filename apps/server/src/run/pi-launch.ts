import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ProviderConnection } from "../../../shared/provider"
import type { ThinkingLevel } from "../../../shared/thinking"
import {
  enabledModelRefs,
  generateModelsJson,
  resolvePiModelRef,
} from "../providers/models-json"

/** All built-in tools pi should enable for a solver run. */
const PI_TOOLS = "read,bash,edit,write,grep,find,ls"

export type PiCmdOptions = {
  /** "<providerKey>/<modelId>" */
  modelRef: string
  thinkingLevel: ThinkingLevel
  challengeName: string
  initialPrompt?: string
  /** When set, resume this pi session instead of bootstrapping a new one. */
  session?: string
}

/**
 * Build the pi argv (exec style, no shell). The rendered initial prompt is the
 * positional argument (Interactive-with-initial-prompt). dockerode passes argv
 * directly so multi-line prompts need no escaping. Resume omits the positional
 * prompt and passes --session instead.
 */
export function buildPiCmd(options: PiCmdOptions): string[] {
  const cmd = [
    "pi",
    "--approve",
    "--no-context-files",
    "--tools",
    PI_TOOLS,
    "--model",
    `${options.modelRef}:${options.thinkingLevel}`,
    "--name",
    options.challengeName,
  ]
  if (options.session) {
    cmd.push("--session", options.session)
  } else if (options.initialPrompt !== undefined) {
    cmd.push(options.initialPrompt)
  }
  return cmd
}

/** Container env injected into every run (skill scripts read these). */
export function buildContainerEnv(input: {
  runId: string
  challengeId: string
  challengeName: string
  apiUrl: string
}): string[] {
  return [
    `AEGISX_API_URL=${input.apiUrl}`,
    `AEGISX_RUN_ID=${input.runId}`,
    `AEGISX_CHALLENGE_ID=${input.challengeId}`,
    `AEGISX_CHALLENGE_NAME=${input.challengeName}`,
    "PI_OFFLINE=1",
    "PI_SKIP_VERSION_CHECK=1",
  ]
}

/**
 * Generate the per-run pi-agent volume: models.json (apiKey literal), the
 * rendered main system prompt as APPEND_SYSTEM.md (System Prompt File, not
 * affected by --no-context-files), settings.json, and the aegisx skill.
 */
export function generatePiAgentVolume(input: {
  piAgentDir: string
  providers: ProviderConnection[]
  appendSystem: string
}): void {
  mkdirSync(input.piAgentDir, { recursive: true })
  writeFileSync(
    join(input.piAgentDir, "models.json"),
    `${JSON.stringify(generateModelsJson(input.providers), null, 2)}\n`
  )
  writeFileSync(join(input.piAgentDir, "APPEND_SYSTEM.md"), input.appendSystem)
  writeFileSync(
    join(input.piAgentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProjectTrust: "always",
        quietStartup: true,
        enableInstallTelemetry: false,
        enabledModels: enabledModelRefs(input.providers),
        compaction: { enabled: true },
      },
      null,
      2
    )}\n`
  )
  writeSkillFiles(join(input.piAgentDir, "skills", "aegisx"))
}

/** Resolve the pi model ref for the selected provider/model. */
export function piModelRefFor(
  provider: ProviderConnection,
  modelId: string
): { providerKey: string; modelId: string; ref: string } {
  const model = provider.models.find((m) => m.id === modelId)
  if (!model) throw new Error(`Model ${modelId} not found in provider`)
  const ref = resolvePiModelRef(provider, model)
  return { ...ref, ref: `${ref.providerKey}/${ref.modelId}` }
}

const SKILL_BIN_DIR = "bin"

function writeSkillFiles(skillDir: string) {
  mkdirSync(join(skillDir, SKILL_BIN_DIR), { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD)
  for (const [name, content] of Object.entries(SKILL_SCRIPTS)) {
    const path = join(skillDir, SKILL_BIN_DIR, name)
    writeFileSync(path, content)
    chmodSync(path, 0o755)
  }
}

const SKILL_MD = `# AegisX integration

You are running inside an AegisX CTF run. Use these helper commands to talk back
to AegisX. They use the \`AEGISX_API_URL\` and \`AEGISX_RUN_ID\` environment
variables already set in the container.

## Submit a flag
\`\`\`sh
aegisx-submit-flag "<flag>"
\`\`\`
Returns the platform verdict (accepted / rejected / ...). Submit only
high-confidence candidates derived from evidence.

## Control the challenge target
\`\`\`sh
aegisx-target get       # inspect current state
aegisx-target start     # bring the target up
aegisx-target extend    # extend its lifetime before it expires
aegisx-target stop      # stop it when done
\`\`\`
Only available when the challenge has a remote target.

## Finish the run
\`\`\`sh
aegisx-finish "<one-paragraph summary>"
\`\`\`
Records your summary and gracefully stops the run. Call this once the solution
is supported by reproducible evidence (and, where the platform is integrated, an
accepted flag). Do not continue after it succeeds — AegisX will stop pi.
`

const SKILL_SCRIPTS: Record<string, string> = {
  "aegisx-submit-flag": `#!/usr/bin/env bash
# Submit a flag to AegisX. Usage: aegisx-submit-flag "<flag>"
set -euo pipefail
flag="\${1-}"
if [ -z "$flag" ]; then
  echo "usage: aegisx-submit-flag <flag>" >&2
  exit 2
fi
exec curl -fsS -X POST \\
  -H 'content-type: application/json' \\
  -d "$(printf '%s' "$flag" | jq -Rs '{flag: .}')" \\
  "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/flag"
`,
  "aegisx-target": `#!/usr/bin/env bash
# Manage the challenge target. Usage: aegisx-target get|start|extend|stop
set -euo pipefail
action="\${1-}"
case "$action" in
  get)    method="GET"  ; path="target" ;;
  start)  method="POST" ; path="target/start" ;;
  extend) method="POST" ; path="target/extend" ;;
  stop)   method="POST" ; path="target/stop" ;;
  *) echo "usage: aegisx-target get|start|extend|stop" >&2; exit 2 ;;
esac
exec curl -fsS -X "$method" "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/$path"
`,
  "aegisx-finish": `#!/usr/bin/env bash
# Finish the run. Usage: aegisx-finish "<summary>"
set -euo pipefail
summary="\${1-}"
exec curl -fsS -X POST \\
  -H 'content-type: application/json' \\
  -d "$(printf '%s' "$summary" | jq -Rs '{summary: .}')" \\
  "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/finish"
`,
}

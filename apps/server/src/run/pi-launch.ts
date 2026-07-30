import { mkdirSync, writeFileSync } from "node:fs"
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

/** Container env injected into every run (the aegisx skill curl commands read these). */
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
 * affected by --no-context-files), settings.json, and the aegisx skills.
 *
 * Skills are pure documentation: they teach the agent the curl commands to call
 * AegisX's run-level HTTP API. No helper scripts are generated, so nothing has
 * to be placed on PATH — `curl`/`jq` already live in the solver image PATH.
 * `aegisx` (flag submit + finish) is always generated; `aegisx-target` only
 * when the challenge actually has a remote target.
 */
export function generatePiAgentVolume(input: {
  piAgentDir: string
  providers: ProviderConnection[]
  appendSystem: string
  targetSupported: boolean
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
  writeSkillMd(join(input.piAgentDir, "skills", "aegisx"), AEGISX_SKILL_MD)
  if (input.targetSupported) {
    writeSkillMd(
      join(input.piAgentDir, "skills", "aegisx-target"),
      AEGISX_TARGET_SKILL_MD
    )
  }
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

function writeSkillMd(skillDir: string, content: string) {
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), content)
}

const AEGISX_SKILL_MD = `---
name: aegisx
description: Submits CTF flags and finishes the run by calling AegisX's HTTP API with curl. Use when you have a high-confidence flag to submit, or have completed the solution and want to end the run.
---

# AegisX run integration

You are inside an AegisX CTF run. \`AEGISX_API_URL\` and \`AEGISX_RUN_ID\` are set
in the environment; \`curl\` and \`jq\` are on PATH.

## Submit a flag
\`\`\`sh
curl -fsS -X POST -H 'content-type: application/json' \\
  -d "$(jq -n --arg f 'FLAG{...}' '{flag:$f}')" \\
  "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/flag"
\`\`\`
Returns the platform verdict (accepted / rejected / ...). Use \`jq -n --arg\` so
special characters in the flag are escaped safely. Submit only high-confidence
candidates derived from evidence.

## Finish the run
\`\`\`sh
curl -fsS -X POST -H 'content-type: application/json' \\
  -d "$(jq -n --arg s 'one-paragraph summary' '{summary:$s}')" \\
  "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/finish"
\`\`\`
Records your summary and gracefully stops pi. Call once the solution is backed
by reproducible evidence (and an accepted flag where the platform is integrated).
Do not continue after it succeeds — AegisX will stop pi.
`

const AEGISX_TARGET_SKILL_MD = `---
name: aegisx-target
description: Controls the challenge's remote target (inspect/start/extend/stop) via AegisX's HTTP API with curl. Use only when this challenge has a remote target to manage.
---

# AegisX target control

Manage the remote target with curl (\`AEGISX_API_URL\` and \`AEGISX_RUN_ID\` are
set; \`curl\` is on PATH):
\`\`\`sh
curl -fsS "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/target"          # inspect
curl -fsS -X POST "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/target/start"
curl -fsS -X POST "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/target/extend"
curl -fsS -X POST "\${AEGISX_API_URL%/}/api/runs/\${AEGISX_RUN_ID}/target/stop"
\`\`\`
Inspect before starting; extend before expiry to preserve session/state; stop
before finishing the run.
`

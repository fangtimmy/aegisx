import {
	DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
	DEFAULT_INITIAL_PROMPT_TEMPLATE,
	DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
} from "./prompt-defaults"
import type { ThinkingLevel } from "./thinking"
import { isThinkingLevel } from "./thinking"

export type SettingWidget =
	| "boolean"
	| "number"
	| "text"
	| "select"
	| "model"
	| "prompt"

export type SettingGroup =
	| "Agent"
	| "Runtime"
	| "Container"
	| "Scheduler"
	| "Prompts"

type BaseDef = {
	key: SettingKey
	group: SettingGroup
	title: string
	description?: string
	widget: SettingWidget
	order: number
}

export type SettingDef =
	| (BaseDef & {
			type: "boolean"
			default: boolean
	  })
	| (BaseDef & {
			type: "integer"
			default: number
			minimum: number
			maximum: number
			step?: number
	  })
	| (BaseDef & {
			type: "number"
			default: number
			minimum: number
			maximum: number
			step?: number
	  })
	| (BaseDef & {
			type: "string"
			default: string
			minLength?: number
			maxLength?: number
			pattern?: RegExp
	  })
	| (BaseDef & {
			type: "nullstring"
			default: string | null
			maxLength?: number
	  })
	| (BaseDef & {
			type: "enum"
			default: string
			enum: { value: string; label: string }[]
	  })

// v3 is container-only; every run runs in a Docker container. The only knobs
// that matter for a run are the agent defaults, the platform/provider timeouts,
// the container resources, and the prompt templates. Earlier "local" mode,
// concurrency, retry, tool-output, and per-tool-timeout settings belonged to
// the deleted v2 in-process agent loop and had no effect here.
export type FlatSettings = {
	"agent.defaultModelId": string | null
	"agent.defaultThinkingLevel": ThinkingLevel
	"agent.compactionEnabled": boolean
	"agent.retryEnabled": boolean
	"agent.retryMaxRetries": number
	"scheduler.maxConcurrentRuns": number
	"scheduler.defaultRunTimeoutMs": number
	"runtime.maxAttachmentMb": number
	"runtime.platformRequestTimeoutMs": number
	"runtime.providerDiscoverTimeoutMs": number
	"container.image": string
	"container.cpus": number
	"container.memoryMb": number
	"container.pidsLimit": number
	"container.workspace": string
	"container.tmpfsSize": string
	"prompts.mainSystem": string
	"prompts.childSystem": string
	"prompts.initial": string
}

export type SettingKey = keyof FlatSettings

const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Extra high" },
	{ value: "max", label: "Maximum" },
]

const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/

export const SETTINGS_DEFS: SettingDef[] = [
	{
		key: "agent.defaultModelId",
		type: "nullstring",
		default: null,
		group: "Agent",
		title: "Default model",
		description: "Used when creating a new run.",
		widget: "model",
		order: 10,
	},
	{
		key: "agent.defaultThinkingLevel",
		type: "enum",
		default: "off",
		enum: THINKING_OPTIONS,
		group: "Agent",
		title: "Default reasoning level",
		widget: "select",
		order: 20,
	},
	{
		key: "agent.compactionEnabled",
		type: "boolean",
		default: true,
		group: "Agent",
		title: "Context compaction",
		description:
			"Compact the conversation when it nears the context window so long CTF runs survive. Applied to new runs.",
		widget: "boolean",
		order: 25,
	},
	{
		key: "agent.retryEnabled",
		type: "boolean",
		default: true,
		group: "Agent",
		title: "Auto-retry provider errors",
		description:
			"Retry transient provider errors automatically. Applied to new runs.",
		widget: "boolean",
		order: 30,
	},
	{
		key: "agent.retryMaxRetries",
		type: "integer",
		default: 3,
		minimum: 0,
		maximum: 10,
		group: "Agent",
		title: "Max retries",
		widget: "number",
		order: 35,
	},
	{
		key: "scheduler.maxConcurrentRuns",
		type: "integer",
		default: 4,
		minimum: 1,
		maximum: 32,
		group: "Scheduler",
		title: "Max concurrent runs",
		description:
			"Global cap on simultaneously running solver runs (local container resources). Enforced as a hard guardrail by the orchestrator.",
		widget: "number",
		order: 10,
	},
	{
		key: "scheduler.defaultRunTimeoutMs",
		type: "integer",
		default: 3_600_000,
		minimum: 60_000,
		maximum: 86_400_000,
		group: "Scheduler",
		title: "Default run timeout (ms)",
		description:
			"Per-run hard deadline. At the halfway point the orchestrator is notified; at the deadline the turn is aborted to idle.",
		widget: "number",
		order: 20,
	},
	{
		key: "runtime.maxAttachmentMb",
		type: "integer",
		default: 512,
		minimum: 1,
		maximum: 10_240,
		group: "Runtime",
		title: "Max attachment size (MB)",
		widget: "number",
		order: 30,
	},
	{
		key: "runtime.platformRequestTimeoutMs",
		type: "integer",
		default: 30_000,
		minimum: 1_000,
		maximum: 300_000,
		group: "Runtime",
		title: "Platform request timeout (ms)",
		widget: "number",
		order: 100,
	},
	{
		key: "runtime.providerDiscoverTimeoutMs",
		type: "integer",
		default: 10_000,
		minimum: 1_000,
		maximum: 120_000,
		group: "Runtime",
		title: "Provider discover timeout (ms)",
		widget: "number",
		order: 110,
	},
	{
		key: "container.image",
		type: "string",
		default: "aegisx/solver:kali",
		minLength: 1,
		maxLength: 300,
		pattern: IMAGE_PATTERN,
		group: "Container",
		title: "Container image",
		widget: "text",
		order: 10,
	},
	{
		key: "container.cpus",
		type: "number",
		default: 2,
		minimum: 0.1,
		maximum: 16,
		step: 0.1,
		group: "Container",
		title: "CPUs",
		widget: "number",
		order: 20,
	},
	{
		key: "container.memoryMb",
		type: "integer",
		default: 2048,
		minimum: 128,
		maximum: 32_768,
		group: "Container",
		title: "Memory (MB)",
		widget: "number",
		order: 30,
	},
	{
		key: "container.pidsLimit",
		type: "integer",
		default: 256,
		minimum: 16,
		maximum: 4_096,
		group: "Container",
		title: "PIDs limit",
		widget: "number",
		order: 40,
	},
	{
		key: "container.workspace",
		type: "string",
		default: "/workspace",
		minLength: 1,
		maxLength: 500,
		group: "Container",
		title: "Workspace path",
		widget: "text",
		order: 50,
	},
	{
		key: "container.tmpfsSize",
		type: "string",
		default: "64m",
		minLength: 1,
		maxLength: 20,
		group: "Container",
		title: "tmpfs size",
		widget: "text",
		order: 70,
	},
	{
		key: "prompts.mainSystem",
		type: "string",
		default: DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
		maxLength: 100_000,
		group: "Prompts",
		title: "Main system prompt",
		description: "Applied to new runs. Blank is blank — not the built-in default.",
		widget: "prompt",
		order: 10,
	},
	{
		key: "prompts.childSystem",
		type: "string",
		default: DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
		maxLength: 100_000,
		group: "Prompts",
		title: "Child system prompt",
		description:
			"Base system prompt for delegated child pi processes launched by the main agent (see the aegisx-child skill). Blank is blank — not the built-in default.",
		widget: "prompt",
		order: 20,
	},
	{
		key: "prompts.initial",
		type: "string",
		default: DEFAULT_INITIAL_PROMPT_TEMPLATE,
		maxLength: 100_000,
		group: "Prompts",
		title: "Initial user prompt",
		description:
			"Bootstrap message for new runs. Blank is blank — not the built-in default.",
		widget: "prompt",
		order: 30,
	},
]

const DEF_BY_KEY = new Map(
	SETTINGS_DEFS.map((def) => [def.key, def] as const),
)

export const SETTING_KEYS = SETTINGS_DEFS.map((def) => def.key)

export function isSettingKey(value: string): value is SettingKey {
	return DEF_BY_KEY.has(value as SettingKey)
}

export function settingDef(key: SettingKey): SettingDef {
	const def = DEF_BY_KEY.get(key)
	if (!def) throw new Error(`Unknown setting key: ${key}`)
	return def
}

export function defaultSettings(): FlatSettings {
	const out = {} as FlatSettings
	for (const def of SETTINGS_DEFS) {
		;(out as Record<string, unknown>)[def.key] = def.default
	}
	return out
}

export function isSettingModified(
	settings: FlatSettings,
	key: SettingKey,
): boolean {
	return !Object.is(get(settings, key), settingDef(key).default)
}

export function modifiedSettingKeys(settings: FlatSettings): SettingKey[] {
	return SETTING_KEYS.filter((key) => isSettingModified(settings, key))
}

/** Map pre-flat / unversioned config.json settings into flat keys. */
export function migrateLegacySettings(raw: unknown): FlatSettings {
	const source =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {}

	// Already flat (has at least one known flat key)
	if (SETTING_KEYS.some((key) => key in source)) {
		return parseSettings(source)
	}

	const flat: Record<string, unknown> = {}
	const map: Record<string, SettingKey> = {
		defaultModelId: "agent.defaultModelId",
		defaultThinkingLevel: "agent.defaultThinkingLevel",
		maxAttachmentMb: "runtime.maxAttachmentMb",
		platformRequestTimeoutMs: "runtime.platformRequestTimeoutMs",
		providerDiscoverTimeoutMs: "runtime.providerDiscoverTimeoutMs",
		containerImage: "container.image",
		cpus: "container.cpus",
		memoryMb: "container.memoryMb",
		pidsLimit: "container.pidsLimit",
		containerWorkspace: "container.workspace",
		tmpfsSize: "container.tmpfsSize",
		mainSystemPromptTemplate: "prompts.mainSystem",
		childSystemPromptTemplate: "prompts.childSystem",
		initialPromptTemplate: "prompts.initial",
	}
	for (const [from, to] of Object.entries(map)) {
		if (from in source) flat[to] = source[from]
	}

	// Legacy empty prompt meant "use builtin"; materialize defaults.
	for (const key of [
		"prompts.mainSystem",
		"prompts.childSystem",
		"prompts.initial",
	] as const) {
		if (flat[key] === "") delete flat[key]
	}

	// cpuLimit millicores → cpus
	if (
		typeof source.cpuLimit === "number" &&
		Number.isFinite(source.cpuLimit) &&
		flat["container.cpus"] === undefined
	) {
		flat["container.cpus"] = source.cpuLimit / 1000
	}

	return parseSettings(flat)
}

export function get<K extends SettingKey>(
	settings: Partial<FlatSettings> | FlatSettings,
	key: K,
): FlatSettings[K] {
	const value = settings[key]
	if (value !== undefined) return value as FlatSettings[K]
	return settingDef(key).default as FlatSettings[K]
}

function coerceValue(def: SettingDef, raw: unknown): unknown | undefined {
	if (raw === undefined) return undefined
	switch (def.type) {
		case "boolean":
			return typeof raw === "boolean" ? raw : undefined
		case "integer": {
			if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
			const value = Math.trunc(raw)
			if (value < def.minimum || value > def.maximum) return undefined
			return value
		}
		case "number": {
			if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
			if (raw < def.minimum || raw > def.maximum) return undefined
			return raw
		}
		case "string": {
			if (typeof raw !== "string") return undefined
			if (def.minLength !== undefined && raw.length < def.minLength)
				return undefined
			if (def.maxLength !== undefined && raw.length > def.maxLength)
				return undefined
			if (def.pattern && !def.pattern.test(raw)) return undefined
			return raw
		}
		case "nullstring": {
			if (raw === null) return null
			if (typeof raw !== "string") return undefined
			if (raw.length === 0) return null
			if (def.maxLength !== undefined && raw.length > def.maxLength)
				return undefined
			return raw
		}
		case "enum": {
			if (typeof raw !== "string") return undefined
			if (!def.enum.some((item) => item.value === raw)) return undefined
			if (def.key === "agent.defaultThinkingLevel" && !isThinkingLevel(raw)) {
				return undefined
			}
			return raw
		}
	}
}

/** Merge raw object with defaults; unknown keys dropped; invalid values use default. */
export function parseSettings(raw: unknown): FlatSettings {
	const source =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {}
	const out = defaultSettings()
	for (const def of SETTINGS_DEFS) {
		const coerced = coerceValue(def, source[def.key])
		if (coerced !== undefined) {
			;(out as Record<string, unknown>)[def.key] = coerced
		}
	}
	return out
}

/** Apply a partial patch; only known keys; invalid values ignored. */
export function patchSettings(
	current: FlatSettings,
	patch: unknown,
): FlatSettings {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		return { ...current }
	}
	const source = patch as Record<string, unknown>
	const out = { ...current }
	for (const [key, raw] of Object.entries(source)) {
		if (!isSettingKey(key)) continue
		const def = settingDef(key)
		const coerced = coerceValue(def, raw)
		if (coerced !== undefined) {
			;(out as Record<string, unknown>)[key] = coerced
		}
	}
	return out
}

export const CONFIG_DOCUMENT_VERSION = 1 as const

export type ConfigDocumentV1 = {
	version: typeof CONFIG_DOCUMENT_VERSION
	settings: FlatSettings
	providers: unknown[]
}

export function isConfigDocumentV1(raw: unknown): raw is {
	version: 1
	settings: unknown
	providers: unknown[]
} {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
	const doc = raw as Record<string, unknown>
	return (
		doc.version === CONFIG_DOCUMENT_VERSION &&
		doc.settings !== undefined &&
		Array.isArray(doc.providers)
	)
}

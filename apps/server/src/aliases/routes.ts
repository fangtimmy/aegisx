import type { ModelAlias } from "@aegisx/shared"
import type { Hono } from "hono"
import { Type } from "typebox"

import type { AliasData, ConfigStore } from "../infrastructure/config-store"
import { badRequest, conflict, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"

const thinkingLevelSchema = Type.Union(
  [
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
  ],
  { description: "推理强度" }
)

const aliasInput = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 100 }),
    /** Ordered list of ProviderModel.id values; v1 UI exposes one entry. */
    modelIds: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 16,
    }),
    thinkingLevel: thinkingLevelSchema,
  },
  { additionalProperties: false }
)

const aliasUpdateInput = Type.Partial(aliasInput, {
  additionalProperties: false,
})

function publicAlias(alias: AliasData): ModelAlias {
  return {
    id: alias.id,
    label: alias.label,
    modelIds: [...alias.modelIds],
    thinkingLevel: alias.thinkingLevel,
  }
}

function cloneAliases(store: ConfigStore): AliasData[] {
  return store.getAliases().map((a) => ({ ...a, modelIds: [...a.modelIds] }))
}

/** Whether a referenced ProviderModel.id currently exists under any provider. */
function modelExists(store: ConfigStore, modelId: string): boolean {
  return store
    .getProviders()
    .some((p) => p.models.some((m) => m.id === modelId))
}

/** Validate that every referenced model id resolves to a configured model.
 * Dangling refs are tolerated at *resolve* time (the first available model
 * wins), but rejected at *write* time so the editor never stores garbage. */
function validateModelIds(
  store: ConfigStore,
  modelIds: string[],
  errorPrefix: string
): string[] {
  for (const id of modelIds) {
    if (!modelExists(store, id)) {
      throw new Error(`${errorPrefix}: unknown model ${id}`)
    }
  }
  return modelIds
}

export function registerAliasRoutes(
  app: Hono,
  options: { configStore: ConfigStore }
) {
  const { configStore } = options

  app.get("/api/model-aliases", (c) =>
    c.json({ items: configStore.getAliases().map(publicAlias) })
  )

  app.post("/api/model-aliases", validateJson(aliasInput), (c) => {
    const input = c.req.valid("json")
    const label = input.label.trim()
    if (!label) {
      return badRequest(c, "invalid_alias", "Alias name is required")
    }
    const aliases = cloneAliases(configStore)
    if (aliases.some((a) => a.label === label)) {
      return conflict(c, "duplicate_alias", "Alias name already exists")
    }
    let modelIds: string[]
    try {
      modelIds = validateModelIds(configStore, input.modelIds, "Invalid alias")
    } catch (error) {
      return badRequest(
        c,
        "invalid_alias",
        error instanceof Error ? error.message : "Invalid alias"
      )
    }
    const alias: AliasData = {
      id: crypto.randomUUID(),
      label,
      modelIds,
      thinkingLevel: input.thinkingLevel,
    }
    aliases.push(alias)
    configStore.updateAliases(aliases)
    return c.json(publicAlias(alias), 201)
  })

  app.patch(
    "/api/model-aliases/:aliasId",
    validateJson(aliasUpdateInput),
    (c) => {
      const aliases = cloneAliases(configStore)
      const alias = aliases.find((a) => a.id === c.req.param("aliasId"))
      if (!alias) return notFound(c, "Alias not found")
      const input = c.req.valid("json")
      if (input.label !== undefined) {
        const label = input.label.trim()
        if (!label) {
          return badRequest(c, "invalid_alias", "Alias name is required")
        }
        if (aliases.some((a) => a.id !== alias.id && a.label === label)) {
          return conflict(c, "duplicate_alias", "Alias name already exists")
        }
        alias.label = label
      }
      if (input.modelIds !== undefined) {
        try {
          alias.modelIds = validateModelIds(
            configStore,
            input.modelIds,
            "Invalid alias"
          )
        } catch (error) {
          return badRequest(
            c,
            "invalid_alias",
            error instanceof Error ? error.message : "Invalid alias"
          )
        }
      }
      if (input.thinkingLevel !== undefined) {
        alias.thinkingLevel = input.thinkingLevel
      }
      configStore.updateAliases(aliases)
      return c.json(publicAlias(alias))
    }
  )

  app.delete("/api/model-aliases/:aliasId", (c) => {
    const aliases = cloneAliases(configStore)
    const idx = aliases.findIndex((a) => a.id === c.req.param("aliasId"))
    if (idx === -1) return notFound(c, "Alias not found")
    aliases.splice(idx, 1)
    configStore.updateAliases(aliases)
    return c.body(null, 204)
  })
}

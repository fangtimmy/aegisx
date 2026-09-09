import { PROVIDER_TYPES } from "@aegisx/shared"
import { Type } from "typebox"

/** No body allowed (action endpoints that only take path params). */
export const EmptyInputSchema = Type.Object({}, { additionalProperties: false })

export const ProviderTypeSchema = Type.Union(
  PROVIDER_TYPES.map((type) => Type.Literal(type))
)

export const RemoteTargetInfoSchema = Type.Object(
  {
    name: Type.String(),
    services: Type.Array(Type.String()),
  },
  { additionalProperties: false }
)

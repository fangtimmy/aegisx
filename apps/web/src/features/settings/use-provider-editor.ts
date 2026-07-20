import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import {
  apiRequest,
  jsonRequest,
  type PiModelProfile,
  type ProviderConnection,
  type ProviderModel,
} from "@/lib/api"
import type { ProviderInput } from "./provider-config"

type ProviderUpdate = Omit<ProviderInput, "apiKey"> & { apiKey?: string }

export function useProviderEditor(provider: ProviderConnection) {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<ProviderModel | null>(null)
  const [editingBinding, setEditingBinding] =
    useState<ProviderModel["piBinding"]>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [bindingModel, setBindingModel] = useState<ProviderModel | null>(null)
  const [selectedBuiltinProvider, setSelectedBuiltinProvider] = useState("")
  const [selectedBuiltinModel, setSelectedBuiltinModel] =
    useState<PiModelProfile | null>(null)
  const save = useMutation({
    mutationFn: (input: ProviderUpdate) =>
      apiRequest<ProviderConnection>(
        `/providers/${provider.id}`,
        jsonRequest("PATCH", input)
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  })
  const discover = useMutation({
    mutationFn: () =>
      apiRequest<{ models: string[] }>(
        `/providers/${provider.id}/models/discover`,
        { method: "POST" }
      ),
    onSuccess: ({ models }) => {
      const known = new Set(provider.models.map((model) => model.modelId))
      const fresh = models.filter((model) => !known.has(model))
      setDiscovered(fresh)
      setSelected(fresh)
    },
  })
  const addModels = useMutation({
    mutationFn: (models: Array<{ modelId: string; label: string }>) =>
      Promise.all(
        models.map((model) =>
          apiRequest<ProviderModel>(
            `/providers/${provider.id}/models`,
            jsonRequest("POST", model)
          )
        )
      ),
    onSuccess: () => {
      setDiscovered(null)
      setSelected([])
      setAddOpen(false)
      queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
  const modelMutation = useMutation({
    mutationFn: ({ modelId, body }: { modelId: string; body: object }) =>
      apiRequest<ProviderModel>(
        `/provider-models/${modelId}`,
        jsonRequest("PATCH", body)
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  })
  const editModel = useMutation({
    mutationFn: ({
      id,
      label,
      metadata,
      binding,
    }: {
      id: string
      label: string
      metadata: ProviderModel["metadata"]
      binding: ProviderModel["piBinding"]
    }) =>
      apiRequest<ProviderModel>(
        `/provider-models/${id}`,
        jsonRequest("PATCH", { label, metadata, binding })
      ),
    onSuccess: () => {
      setEditingModel(null)
      queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
  const builtins = useQuery({
    enabled: Boolean(bindingModel),
    queryKey: ["providers", provider.id, "builtins"],
    queryFn: () =>
      apiRequest<{ items: PiModelProfile[] }>(
        `/providers/${provider.id}/models/builtins`
      ),
  })
  const removeModel = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/provider-models/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] })
      queryClient.invalidateQueries({ queryKey: ["settings"] })
    },
  })
  const builtinProfiles = builtins.data?.items ?? []
  const builtinProviderIds = [
    ...new Set(builtinProfiles.map((model) => model.providerId)),
  ]
  const filteredBuiltinModels = builtinProfiles.filter(
    (model) => model.providerId === selectedBuiltinProvider
  )
  const selectedProfile = selectedBuiltinModel

  return {
    showKey,
    setShowKey,
    discovered,
    setDiscovered,
    selected,
    setSelected,
    addOpen,
    setAddOpen,
    editingModel,
    setEditingModel,
    editingBinding,
    setEditingBinding,
    metadataError,
    setMetadataError,
    bindingModel,
    setBindingModel,
    selectedBuiltinProvider,
    setSelectedBuiltinProvider,
    selectedBuiltinModel,
    setSelectedBuiltinModel,
    save,
    discover,
    addModels,
    modelMutation,
    editModel,
    builtins,
    removeModel,
    builtinProfiles,
    builtinProviderIds,
    filteredBuiltinModels,
    selectedProfile,
  }
}

export type ProviderEditor = ReturnType<typeof useProviderEditor>

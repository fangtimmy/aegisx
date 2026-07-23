import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import {
  keys,
  type PiModelProfile,
  type ProviderConnection,
  type ProviderModel,
  providersApi,
} from "@/api"
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
      providersApi.updateProvider(provider.id, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.providers.all }),
  })
  const discover = useMutation({
    mutationFn: () => providersApi.discoverModels(provider.id),
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
          providersApi.createProviderModel(provider.id, model)
        )
      ),
    onSuccess: () => {
      setDiscovered(null)
      setSelected([])
      setAddOpen(false)
      queryClient.invalidateQueries({ queryKey: keys.providers.all })
    },
  })
  const modelMutation = useMutation({
    mutationFn: ({ modelId, body }: { modelId: string; body: object }) =>
      providersApi.updateProviderModel(modelId, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.providers.all }),
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
    }) => providersApi.updateProviderModel(id, { label, metadata, binding }),
    onSuccess: () => {
      setEditingModel(null)
      queryClient.invalidateQueries({ queryKey: keys.providers.all })
    },
  })
  const builtins = useQuery({
    enabled: Boolean(bindingModel),
    queryKey: ["providers", provider.id, "builtins"],
    queryFn: () => providersApi.listBuiltinModels(provider.id),
  })
  const removeModel = useMutation({
    mutationFn: (id: string) => providersApi.deleteProviderModel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.providers.all })
      queryClient.invalidateQueries({ queryKey: keys.settings.all })
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

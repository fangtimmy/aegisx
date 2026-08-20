import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"

import {
  keys,
  type PiModelProfile,
  type ProviderConnection,
  type ProviderModel,
  providersApi,
} from "@/api"

import type { ProviderInput } from "./provider-config"

type ProviderUpdate = Omit<ProviderInput, "apiKey"> & { apiKey?: string }

export type EditForm = {
  label: string
  metadata: string
}

export function useProviderEditor(provider: ProviderConnection) {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<ProviderModel | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [importModel, setImportModel] = useState<ProviderModel | null>(null)
  const [importSearch, setImportSearch] = useState("")
  const [selectedBuiltinModel, setSelectedBuiltinModel] =
    useState<PiModelProfile | null>(null)
  const editForm = useForm<EditForm>({
    defaultValues: { label: "", metadata: "{}" },
  })
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
      void queryClient.invalidateQueries({ queryKey: keys.providers.all })
    },
  })
  const modelMutation = useMutation({
    mutationFn: ({ modelId, body }: { modelId: string; body: object }) =>
      providersApi.updateProviderModel(modelId, body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: keys.providers.all }),
  })
  const editModel = useMutation({
    mutationFn: ({
      id,
      label,
      metadata,
    }: {
      id: string
      label: string
      metadata: ProviderModel["metadata"]
    }) => providersApi.updateProviderModel(id, { label, metadata }),
    onSuccess: () => {
      setEditingModel(null)
      void queryClient.invalidateQueries({ queryKey: keys.providers.all })
    },
  })
  /** Open the edit dialog on a model: snapshot its current values into the
   * form. The same reset runs after a metadata import so the textarea always
   * mirrors server state (a stale form would write the old JSON back on
   * save, silently dropping the import). */
  const openEditModel = (model: ProviderModel) => {
    editModel.reset()
    setEditingModel(model)
    editForm.reset({
      label: model.label,
      metadata: JSON.stringify(model.metadata, null, 2),
    })
    setMetadataError(null)
  }
  const builtins = useQuery({
    enabled: Boolean(importModel),
    queryKey: ["providers", provider.id, "builtins"],
    queryFn: () => providersApi.listBuiltinModels(provider.id),
  })
  const importMetadata = useMutation({
    mutationFn: ({ id, profile }: { id: string; profile: PiModelProfile }) =>
      providersApi.importProviderModelMetadata(id, {
        providerId: profile.providerId,
        modelId: profile.modelId,
      }),
    onSuccess: (updated) => {
      setImportModel(null)
      // The import dialog sits on top of the edit dialog; feed the imported
      // metadata back into the still-open edit form (see openEditModel).
      setEditingModel(updated)
      editForm.reset({
        label: updated.label,
        metadata: JSON.stringify(updated.metadata, null, 2),
      })
      void queryClient.invalidateQueries({ queryKey: keys.providers.all })
    },
  })
  const removeModel = useMutation({
    mutationFn: (id: string) => providersApi.deleteProviderModel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.providers.all })
      void queryClient.invalidateQueries({ queryKey: keys.settings.all })
    },
  })
  const builtinProfiles = builtins.data?.items ?? []
  const selectedProfile = selectedBuiltinModel

  useEffect(() => {
    if (!importModel) return
    setImportSearch(importModel.modelId)
    setSelectedBuiltinModel(null)
  }, [importModel])

  useEffect(() => {
    if (!importModel || !builtins.data) return
    const query = importModel.modelId.toLowerCase()
    const exact = builtins.data.items.find(
      (model) => model.modelId.toLowerCase() === query
    )
    setSelectedBuiltinModel(exact ?? null)
  }, [importModel, builtins.data])

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
    metadataError,
    setMetadataError,
    importModel,
    setImportModel,
    importSearch,
    setImportSearch,
    selectedBuiltinModel,
    setSelectedBuiltinModel,
    editForm,
    openEditModel,
    save,
    discover,
    addModels,
    modelMutation,
    editModel,
    builtins,
    importMetadata,
    removeModel,
    builtinProfiles,
    selectedProfile,
  }
}

export type ProviderEditor = ReturnType<typeof useProviderEditor>

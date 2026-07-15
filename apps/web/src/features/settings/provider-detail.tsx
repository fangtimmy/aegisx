import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Eye, EyeOff, RefreshCw, Star, Trash2 } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { CheckboxGroup } from "@/components/ui/checkbox-group"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  apiRequest,
  jsonRequest,
  type ProviderConnection,
  type ProviderModel,
  type SettingsPublic,
} from "@/lib/api"
import { type ProviderInput, providerTypeLabels } from "./provider-config"
import { ProviderTypeField } from "./provider-dialog"

export function ProviderDetail({
  provider,
  settings,
  onDelete,
  deleteError,
  deletePending,
}: {
  provider: ProviderConnection
  settings: SettingsPublic
  onDelete: () => void
  deleteError?: Error | null
  deletePending: boolean
}) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState(provider.label)
  const [type, setType] = useState(provider.type)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState(provider.apiKey)
  const [showKey, setShowKey] = useState(false)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const save = useMutation({
    mutationFn: (input: ProviderInput) =>
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
        {
          method: "POST",
        }
      ),
    onSuccess: ({ models }) => {
      const known = new Set(provider.models.map((model) => model.modelId))
      const fresh = models.filter((model) => !known.has(model))
      setDiscovered(fresh)
      setSelected(fresh)
    },
  })
  const addModels = useMutation({
    mutationFn: () =>
      Promise.all(
        selected.map((modelId) =>
          apiRequest<ProviderModel>(
            `/providers/${provider.id}/models`,
            jsonRequest("POST", { modelId, label: modelId })
          )
        )
      ),
    onSuccess: () => {
      setDiscovered(null)
      setSelected([])
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
  const setDefault = useMutation({
    mutationFn: (defaultModelId: string) =>
      apiRequest<SettingsPublic>(
        "/settings",
        jsonRequest("PATCH", {
          defaultModelId,
          environment: settings.environment,
          containerImage: settings.containerImage,
          cpus: settings.cpus,
          memoryMb: settings.memoryMb,
          pidsLimit: settings.pidsLimit,
          maxConcurrency: settings.maxConcurrency,
        })
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  })

  return (
    <div className="flex flex-col gap-6">
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>Provider configuration</CardFrameTitle>
          <CardFrameDescription>
            {providerTypeLabels[provider.type]}
          </CardFrameDescription>
          <CardFrameAction>
            <Switch
              aria-label={
                provider.enabled ? "Disable provider" : "Enable provider"
              }
              checked={provider.enabled}
              disabled={save.isPending}
              onCheckedChange={(enabled) =>
                save.mutate({
                  label,
                  type,
                  baseUrl,
                  apiKey,
                  enabled: enabled === true,
                })
              }
            />
          </CardFrameAction>
        </CardFrameHeader>
        <Card
          render={
            <form
              onSubmit={(event) => {
                event.preventDefault()
                save.mutate({
                  label: label.trim(),
                  type,
                  baseUrl: baseUrl.trim(),
                  apiKey,
                  enabled: provider.enabled,
                })
              }}
            />
          }
        >
          <CardPanel className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="selected-provider-name">Name</FieldLabel>
              <Input
                id="selected-provider-name"
                onChange={(event) => setLabel(event.target.value)}
                required
                type="text"
                value={label}
              />
            </Field>
            <ProviderTypeField onChange={setType} value={type} />
            <Field>
              <FieldLabel htmlFor="selected-provider-base-url">
                Base URL
              </FieldLabel>
              <Input
                id="selected-provider-base-url"
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                type="url"
                value={baseUrl}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="selected-provider-api-key">
                API key
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  autoComplete="off"
                  id="selected-provider-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                />
                <InputGroupAddon align="inline-end">
                  <Button
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey((value) => !value)}
                    size="icon-sm"
                    title={showKey ? "Hide API key" : "Show API key"}
                    type="button"
                    variant="ghost"
                  >
                    {showKey ? <EyeOff /> : <Eye />}
                  </Button>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            {save.error && (
              <Alert className="sm:col-span-2" variant="error">
                <CircleAlert />
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            {deleteError && (
              <Alert className="sm:col-span-2" variant="error">
                <CircleAlert />
                <AlertDescription>{deleteError.message}</AlertDescription>
              </Alert>
            )}
          </CardPanel>
          <CardFooter className="flex-wrap gap-2">
            <Button loading={save.isPending} type="submit">
              Save provider
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button type="button" variant="outline" />}
              >
                <Trash2 /> Delete provider
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {provider.label}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the provider and its models.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    disabled={deletePending}
                    loading={deletePending}
                    onClick={onDelete}
                    type="button"
                    variant="destructive"
                  >
                    Delete provider
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </CardFooter>
        </Card>
      </CardFrame>

      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
          <CardDescription>
            Only enabled models can start a run.
          </CardDescription>
          <CardAction>
            <Button
              loading={discover.isPending}
              onClick={() => discover.mutate()}
              type="button"
              variant="outline"
            >
              <RefreshCw /> Fetch models
            </Button>
          </CardAction>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">
          {discover.error && (
            <Alert variant="error">
              <CircleAlert />
              <AlertDescription>{discover.error.message}</AlertDescription>
            </Alert>
          )}
          {(addModels.error || modelMutation.error || setDefault.error) && (
            <Alert variant="error">
              <CircleAlert />
              <AlertDescription>
                {
                  (addModels.error ?? modelMutation.error ?? setDefault.error)
                    ?.message
                }
              </AlertDescription>
            </Alert>
          )}
          {discovered && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {discovered.length
                    ? `${discovered.length} new models found`
                    : "No new models found"}
                </span>
                {discovered.length > 0 && (
                  <Button
                    disabled={selected.length === 0}
                    loading={addModels.isPending}
                    onClick={() => addModels.mutate()}
                    size="sm"
                    type="button"
                  >
                    Add selected ({selected.length})
                  </Button>
                )}
              </div>
              <CheckboxGroup
                aria-label="Models to add"
                className="grid gap-2 sm:grid-cols-2"
                onValueChange={setSelected}
                value={selected}
              >
                {discovered.map((modelId) => (
                  <Label className="min-w-0" key={modelId}>
                    <Checkbox value={modelId} />
                    <span className="min-w-0 break-all font-mono text-xs">
                      {modelId}
                    </span>
                  </Label>
                ))}
              </CheckboxGroup>
            </div>
          )}
          <div className="divide-y">
            {provider.models.length === 0 ? (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyTitle>No models configured</EmptyTitle>
                  <EmptyDescription>
                    Fetch models from this provider to add them.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              provider.models.map((model) => (
                <div className="flex items-center gap-3 py-3" key={model.id}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">
                      {model.label}
                    </p>
                    <p className="truncate font-mono text-muted-foreground text-xs">
                      {model.modelId}
                    </p>
                  </div>
                  <Button
                    aria-label={`Set ${model.label} as default`}
                    disabled={setDefault.isPending}
                    loading={
                      setDefault.isPending && setDefault.variables === model.id
                    }
                    onClick={() => setDefault.mutate(model.id)}
                    size="icon"
                    title="Set as default"
                    type="button"
                    variant={
                      settings.defaultModelId === model.id
                        ? "secondary"
                        : "ghost"
                    }
                  >
                    <Star
                      className={
                        settings.defaultModelId === model.id
                          ? "fill-current"
                          : undefined
                      }
                    />
                  </Button>
                  <Switch
                    aria-label={
                      model.enabled
                        ? `Disable ${model.label}`
                        : `Enable ${model.label}`
                    }
                    checked={model.enabled}
                    disabled={modelMutation.isPending}
                    onCheckedChange={(enabled) =>
                      modelMutation.mutate({
                        modelId: model.id,
                        body: { enabled: enabled === true },
                      })
                    }
                  />
                </div>
              ))
            )}
          </div>
        </CardPanel>
        <CardFooter className="text-muted-foreground text-xs">
          {provider.models.length} configured
        </CardFooter>
      </Card>
    </div>
  )
}

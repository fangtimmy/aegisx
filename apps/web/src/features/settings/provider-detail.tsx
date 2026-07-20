import { CircleAlert, Eye, EyeOff, Trash2 } from "lucide-react"
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
  CardFooter,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import type { ProviderConnection } from "@/lib/api"
import { providerTypeLabels } from "./provider-config"
import { ProviderTypeField } from "./provider-dialog"
import { ProviderModels } from "./provider-models"
import { useProviderEditor } from "./use-provider-editor"

export function ProviderDetail({
  provider,
  onDelete,
  deleteError,
  deletePending,
}: {
  provider: ProviderConnection
  onDelete: () => void
  deleteError?: Error | null
  deletePending: boolean
}) {
  const editor = useProviderEditor(provider)
  const {
    apiKey,
    baseUrl,
    label,
    save,
    setApiKey,
    setBaseUrl,
    setLabel,
    setShowKey,
    setType,
    showKey,
    type,
  } = editor

  return (
    <div className="flex flex-col gap-4">
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
                  apiKey: apiKey.trim() || undefined,
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
                  apiKey: apiKey.trim() || undefined,
                  enabled: provider.enabled,
                })
              }}
            />
          }
        >
          <CardPanel className="grid grid-cols-2 gap-4">
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
                  placeholder="Leave blank to keep the current key"
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
              <Alert className="col-span-2" variant="error">
                <CircleAlert />
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            {deleteError && (
              <Alert className="col-span-2" variant="error">
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
      <ProviderModels editor={editor} provider={provider} />
    </div>
  )
}

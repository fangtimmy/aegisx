import { useMutation } from "@tanstack/react-query"
import { CircleAlert, Plus } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  apiRequest,
  jsonRequest,
  type ProviderConnection,
  type ProviderType,
} from "@/lib/api"
import {
  type ProviderInput,
  providerTypeDefaults,
  providerTypeLabels,
  providerTypes,
} from "./provider-config"

export function ProviderDialog({
  onCreated,
}: {
  onCreated: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ProviderType>("openai-compatible")
  const [label, setLabel] = useState("")
  const [baseUrl, setBaseUrl] = useState(providerTypeDefaults[type])
  const [apiKey, setApiKey] = useState("")
  const mutation = useMutation({
    mutationFn: (input: ProviderInput) =>
      apiRequest<ProviderConnection>("/providers", jsonRequest("POST", input)),
    onSuccess: (provider) => {
      onCreated(provider.id)
      setOpen(false)
      setLabel("")
      setApiKey("")
    },
  })

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        <Plus /> Add
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate({
              label: label.trim(),
              type,
              baseUrl: baseUrl.trim(),
              apiKey,
              enabled: true,
            })
          }}
        >
          <DialogPanel className="grid gap-4">
            <ProviderTypeField
              onChange={(next) => {
                setType(next)
                setBaseUrl(providerTypeDefaults[next])
              }}
              value={type}
            />
            <Field>
              <FieldLabel htmlFor="provider-label">Name</FieldLabel>
              <Input
                id="provider-label"
                onChange={(event) => setLabel(event.target.value)}
                required
                type="text"
                value={label}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
              <Input
                id="provider-base-url"
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                type="url"
                value={baseUrl}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api-key">API key</FieldLabel>
              <Input
                autoComplete="new-password"
                id="provider-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                type="password"
                value={apiKey}
              />
            </Field>
            {mutation.error && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button loading={mutation.isPending} type="submit">
              Add provider
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function ProviderTypeField({
  value,
  onChange,
}: {
  value: ProviderType
  onChange: (value: ProviderType) => void
}) {
  return (
    <Field name="type">
      <FieldLabel>Provider type</FieldLabel>
      <Select
        items={providerTypeLabels}
        name="type"
        onValueChange={(next) => onChange(next as ProviderType)}
        value={value}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {providerTypes.map((type) => (
            <SelectItem key={type} value={type}>
              {providerTypeLabels[type]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  )
}

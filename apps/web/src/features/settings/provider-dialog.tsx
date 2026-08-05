import { useMutation } from "@tanstack/react-query"
import { CircleAlert, Plus } from "lucide-react"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { type ProviderType, providersApi } from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
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
  providerTypeDefaults,
  providerTypeLabels,
  providerTypes,
} from "./provider-config"

type ProviderFormValues = {
  type: ProviderType
  label: string
  baseUrl: string
  apiKey: string
}

export function ProviderDialog({
  onCreated,
}: {
  onCreated: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const form = useForm<ProviderFormValues>({
    defaultValues: {
      type: "openai-compatible",
      label: "",
      baseUrl: providerTypeDefaults["openai-compatible"],
      apiKey: "",
    },
  })
  const mutation = useMutation({
    mutationFn: (values: ProviderFormValues) =>
      providersApi.createProvider({
        label: values.label.trim(),
        type: values.type,
        baseUrl: values.baseUrl.trim(),
        apiKey: values.apiKey,
        enabled: true,
      }),
    onSuccess: (provider) => {
      onCreated(provider.id)
      setOpen(false)
      form.reset()
    },
  })

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (next) form.reset()
      }}
      open={open}
    >
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        <Plus /> 添加
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>添加供应商</DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        >
          <DialogPanel className="grid gap-4">
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <ProviderTypeField
                  onChange={(next) => {
                    field.onChange(next)
                    form.setValue("baseUrl", providerTypeDefaults[next])
                  }}
                  value={field.value}
                />
              )}
            />
            <Field>
              <FieldLabel htmlFor="provider-label">名称</FieldLabel>
              <Controller
                control={form.control}
                name="label"
                render={({ field }) => (
                  <Input
                    id="provider-label"
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    required
                    type="text"
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
              <Controller
                control={form.control}
                name="baseUrl"
                render={({ field }) => (
                  <Input
                    id="provider-base-url"
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    required
                    type="url"
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api-key">API key</FieldLabel>
              <Controller
                control={form.control}
                name="apiKey"
                render={({ field }) => (
                  <Input
                    autoComplete="new-password"
                    id="provider-api-key"
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    type="password"
                    value={field.value}
                  />
                )}
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
            <DialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </DialogClose>
            <Button loading={mutation.isPending} type="submit">
              添加供应商
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
      <FieldLabel>供应商类型</FieldLabel>
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

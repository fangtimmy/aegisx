import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, Link2, Settings2 } from "lucide-react"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { type EventPlatform, type PlatformType, platformsApi } from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogDescription,
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  credentialLabels,
  credentialPrefixes,
  platformLabels,
  refreshEvent,
} from "./platform-config"

export function ConnectPlatformDialog({
  eventId,
  platform,
}: {
  eventId: string
  platform?: EventPlatform
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const form = useForm<{
    type: PlatformType
    baseUrl: string
    credential: string
    remoteEventId: string
  }>({
    defaultValues: {
      type: platform?.type ?? "ctfd",
      baseUrl: platform?.baseUrl ?? "",
      credential: platform?.credential ?? "",
      remoteEventId: platform?.remoteEventId ?? "",
    },
  })
  const type = form.watch("type")
  const baseUrl = form.watch("baseUrl")
  const credential = form.watch("credential")
  const remoteEventId = form.watch("remoteEventId")
  const discover = useMutation({
    mutationFn: () =>
      platformsApi.discoverRemoteEvents({
        type,
        baseUrl: baseUrl.trim(),
        credential,
      }),
    onSuccess: ({ items }) =>
      form.setValue("remoteEventId", items[0]?.id ?? ""),
  })
  const testConnection = useMutation({
    mutationFn: () =>
      platformsApi.testPlatformConnection({
        type,
        baseUrl: baseUrl.trim(),
        credential,
      }),
    onSuccess: ({ credential: renewedCredential }) => {
      if (renewedCredential) form.setValue("credential", renewedCredential)
    },
  })
  const bind = useMutation({
    mutationFn: (values: {
      type: PlatformType
      baseUrl: string
      credential: string
      remoteEventId: string
    }) =>
      platformsApi.bindPlatform(eventId, {
        type: values.type,
        baseUrl: values.baseUrl.trim(),
        credential: values.credential,
        remoteEventId: values.type === "ctfd" ? "site" : values.remoteEventId,
      }),
    onSuccess: async () => {
      await refreshEvent(queryClient, eventId)
      setOpen(false)
      form.reset({
        type: platform?.type ?? "ctfd",
        baseUrl: platform?.baseUrl ?? "",
        credential: platform?.credential ?? "",
        remoteEventId: platform?.remoteEventId ?? "",
      })
    },
  })
  const discoverData = discover.data
  const needsDiscovery = !platform && type !== "ctfd" && !discoverData

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          discover.reset()
          testConnection.reset()
          bind.reset()
          form.reset({
            type: platform?.type ?? "ctfd",
            baseUrl: platform?.baseUrl ?? "",
            credential: platform?.credential ?? "",
            remoteEventId: platform?.remoteEventId ?? "",
          })
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button
            aria-label={platform ? "Update platform connection" : undefined}
            type="button"
            variant="outline"
          />
        }
      >
        {platform ? <Settings2 /> : <Link2 />}
        {!platform && "Connect platform"}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {platform ? "Update platform connection" : "Connect CTF platform"}
          </DialogTitle>
          <DialogDescription>
            Credentials are stored only for this event and are never exposed to
            agents.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={form.handleSubmit((values) => {
            if (needsDiscovery) discover.mutate()
            else bind.mutate(values)
          })}
        >
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>Platform</FieldLabel>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Select
                    disabled={Boolean(platform)}
                    items={platformLabels}
                    onValueChange={(value) => {
                      field.onChange(value as PlatformType)
                      form.setValue("remoteEventId", "")
                      discover.reset()
                      testConnection.reset()
                    }}
                    value={field.value}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {(Object.keys(platformLabels) as PlatformType[]).map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {platformLabels[value]}
                          </SelectItem>
                        )
                      )}
                    </SelectPopup>
                  </Select>
                )}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="platform-url">Platform URL</FieldLabel>
              <Controller
                control={form.control}
                name="baseUrl"
                render={({ field }) => (
                  <Input
                    disabled={Boolean(platform)}
                    id="platform-url"
                    onBlur={() => {
                      field.onBlur()
                      discover.reset()
                    }}
                    onChange={(event) => {
                      field.onChange(event)
                      testConnection.reset()
                    }}
                    required
                    type="url"
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="platform-credential">
                {credentialLabels[type]}
              </FieldLabel>
              <Controller
                control={form.control}
                name="credential"
                render={({ field }) => (
                  <InputGroup>
                    <InputGroupInput
                      autoComplete="off"
                      id="platform-credential"
                      onBlur={() => {
                        field.onBlur()
                        discover.reset()
                      }}
                      onChange={(event) => {
                        field.onChange(event)
                        testConnection.reset()
                      }}
                      required
                      type="text"
                      value={field.value}
                    />
                    {credentialPrefixes[type] && (
                      <InputGroupAddon>
                        <InputGroupText>
                          {credentialPrefixes[type]}
                        </InputGroupText>
                      </InputGroupAddon>
                    )}
                  </InputGroup>
                )}
                rules={{ required: true }}
              />
            </Field>
            {discoverData && type !== "ctfd" && (
              <Field>
                <FieldLabel>Competition</FieldLabel>
                <Controller
                  control={form.control}
                  name="remoteEventId"
                  render={({ field }) => (
                    <Select
                      items={Object.fromEntries(
                        discoverData.items.map((event) => [
                          event.id,
                          event.name,
                        ])
                      )}
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a competition" />
                      </SelectTrigger>
                      <SelectPopup>
                        {discoverData.items.map((event) => (
                          <SelectItem key={event.id} value={event.id}>
                            {event.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                  rules={{ required: true }}
                />
              </Field>
            )}
            {testConnection.isSuccess && (
              <Alert variant="success">
                <CircleCheck />
                <AlertDescription>Connection successful</AlertDescription>
              </Alert>
            )}
            {(testConnection.error || discover.error || bind.error) && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>
                  {
                    (testConnection.error ?? discover.error ?? bind.error)
                      ?.message
                  }
                </AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={
                !baseUrl.trim() ||
                !credential ||
                discover.isPending ||
                bind.isPending
              }
              loading={testConnection.isPending}
              onClick={() => testConnection.mutate()}
              type="button"
              variant="outline"
            >
              Test connection
            </Button>
            <Button
              disabled={
                !baseUrl.trim() ||
                !credential ||
                testConnection.isPending ||
                Boolean(discoverData && type !== "ctfd" && !remoteEventId)
              }
              loading={discover.isPending || bind.isPending}
              type="submit"
            >
              {needsDiscovery
                ? "Load competitions"
                : platform
                  ? "Update connection"
                  : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

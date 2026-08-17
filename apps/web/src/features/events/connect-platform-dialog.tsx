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
  defaultBaseUrls,
  fixedRemoteEventIds,
  platformLabels,
  refreshEvent,
} from "./platform-config"

/** Connect-dialog initial values, prefilling the platform's default URL for
 * new bindings (existing bindings keep their stored URL). */
function initialFormValues(platform?: EventPlatform) {
  const type = platform?.type ?? "ctfd"
  return {
    type,
    baseUrl: platform?.baseUrl ?? defaultBaseUrls[type] ?? "",
    credential: platform?.credential ?? "",
    remoteEventId: platform?.remoteEventId ?? "",
  }
}

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
  }>({ defaultValues: initialFormValues(platform) })
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
        remoteEventId: fixedRemoteEventIds[values.type] ?? values.remoteEventId,
      }),
    onSuccess: async () => {
      await refreshEvent(queryClient, eventId)
      setOpen(false)
      form.reset(initialFormValues(platform))
    },
  })
  const discoverData = discover.data
  const needsDiscovery =
    !platform && !(type in fixedRemoteEventIds) && !discoverData

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          discover.reset()
          testConnection.reset()
          bind.reset()
          form.reset(initialFormValues(platform))
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button
            aria-label={platform ? "更新平台连接" : undefined}
            type="button"
            variant="outline"
          />
        }
      >
        {platform ? <Settings2 /> : <Link2 />}
        {!platform && "连接平台"}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {platform ? "更新平台连接" : "连接 CTF 平台"}
          </DialogTitle>
          <DialogDescription>
            凭据仅对本赛事保存，且不会暴露给 agent。
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
              <FieldLabel>平台</FieldLabel>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Select
                    disabled={Boolean(platform)}
                    items={platformLabels}
                    onValueChange={(value) => {
                      const next = value as PlatformType
                      field.onChange(next)
                      // Swap the URL only while it is empty or still a
                      // pristine platform default; keep user-typed URLs.
                      if (
                        !baseUrl ||
                        Object.values(defaultBaseUrls).includes(baseUrl)
                      ) {
                        form.setValue("baseUrl", defaultBaseUrls[next] ?? "")
                      }
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
              <FieldLabel htmlFor="platform-url">平台 URL</FieldLabel>
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
            {discoverData && !(type in fixedRemoteEventIds) && (
              <Field>
                <FieldLabel>赛事</FieldLabel>
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
                        <SelectValue placeholder="选择一个赛事" />
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
                <AlertDescription>连接成功</AlertDescription>
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
              取消
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
              测试连接
            </Button>
            <Button
              disabled={
                !baseUrl.trim() ||
                !credential ||
                testConnection.isPending ||
                Boolean(
                  discoverData &&
                  !(type in fixedRemoteEventIds) &&
                  !remoteEventId
                )
              }
              loading={discover.isPending || bind.isPending}
              type="submit"
            >
              {needsDiscovery ? "加载赛事" : platform ? "更新连接" : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

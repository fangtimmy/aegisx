import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Boxes, CircleAlert, Settings2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import {
  apiRequest,
  jsonRequest,
  type ProviderConnection,
  type SettingsPublic,
} from "@/lib/api"
import { ProviderDetail } from "./provider-detail"
import { ProviderDialog } from "./provider-dialog"
import { RuntimeDefaults } from "./runtime-defaults"

export function SettingsScreen() {
  const queryClient = useQueryClient()
  const [section, setSection] = useState<"models" | "runtime">("models")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiRequest<{ items: ProviderConnection[] }>("/providers"),
  })
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiRequest<SettingsPublic>("/settings"),
  })
  useEffect(() => {
    const items = providers.data?.items ?? []
    if (items.length === 0) {
      if (selectedId) setSelectedId(null)
      return
    }
    if (!items.some((provider) => provider.id === selectedId)) {
      setSelectedId(items[0].id)
    }
  }, [providers.data, selectedId])
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedId(null)
      queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
  const toggleProvider = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiRequest<ProviderConnection>(
        `/providers/${id}`,
        jsonRequest("PATCH", { enabled })
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  })

  if (providers.isPending || settings.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" />
        Loading settings...
      </div>
    )
  }
  if (providers.error || settings.error) {
    return (
      <Alert variant="error">
        <CircleAlert />
        <AlertDescription>
          {(providers.error ?? settings.error)?.message}
        </AlertDescription>
      </Alert>
    )
  }
  const items = providers.data?.items ?? []
  const selected = items.find((provider) => provider.id === selectedId)
  return (
    <Tabs
      className="w-full flex-row items-start gap-4"
      onValueChange={(value) => setSection(value as "models" | "runtime")}
      orientation="vertical"
      value={section}
    >
      <div className="w-48 shrink-0 border-s">
        <TabsList className="w-full items-stretch" variant="underline">
          <TabsTab value="models">
            <Boxes aria-hidden="true" /> Model providers
          </TabsTab>
          <TabsTab value="runtime">
            <Settings2 aria-hidden="true" /> Runtime defaults
          </TabsTab>
        </TabsList>
      </div>
      <div className="min-w-0 flex-1">
        <TabsPanel value="runtime">
          <Frame className="min-w-0">
            <FrameHeader>
              <FrameTitle>Runtime defaults</FrameTitle>
              <FrameDescription>Used for every new run.</FrameDescription>
            </FrameHeader>
            <FramePanel>
              <RuntimeDefaults
                providers={items}
                settings={settings.data as SettingsPublic}
              />
            </FramePanel>
          </Frame>
        </TabsPanel>
        <TabsPanel value="models">
          <div className="grid min-w-0 grid-cols-[18rem_minmax(0,1fr)] gap-4">
            <CardFrame className="h-min">
              <CardFrameHeader>
                <CardFrameTitle>Providers</CardFrameTitle>
                <CardFrameDescription>
                  {items.length} configured
                </CardFrameDescription>
                <CardFrameAction>
                  <ProviderDialog
                    onCreated={(id) => {
                      setSelectedId(id)
                      queryClient.invalidateQueries({ queryKey: ["providers"] })
                    }}
                  />
                </CardFrameAction>
              </CardFrameHeader>
              <Card>
                <CardPanel className="p-2">
                  <nav aria-label="Provider connections">
                    {items.map((provider) => (
                      <div className="mb-1 flex items-center" key={provider.id}>
                        <Button
                          className="h-auto min-w-0 flex-1 justify-start px-3 py-2 text-left"
                          aria-pressed={selectedId === provider.id}
                          onClick={() => setSelectedId(provider.id)}
                          type="button"
                          variant={
                            selectedId === provider.id ? "secondary" : "ghost"
                          }
                        >
                          <span className="block truncate font-medium text-sm">
                            {provider.label}
                          </span>
                          <span className="block text-muted-foreground text-xs">
                            {provider.models.length} models
                            {provider.apiKey ? "" : " · No key"}
                          </span>
                        </Button>
                        <Switch
                          aria-label={
                            provider.enabled
                              ? `Disable ${provider.label}`
                              : `Enable ${provider.label}`
                          }
                          checked={provider.enabled}
                          className="mr-3"
                          disabled={
                            toggleProvider.isPending &&
                            toggleProvider.variables?.id === provider.id
                          }
                          onCheckedChange={(enabled) =>
                            toggleProvider.mutate({
                              id: provider.id,
                              enabled: enabled === true,
                            })
                          }
                        />
                      </div>
                    ))}
                  </nav>
                  {toggleProvider.error && (
                    <Alert className="mt-2" variant="error">
                      <CircleAlert />
                      <AlertDescription>
                        {toggleProvider.error.message}
                      </AlertDescription>
                    </Alert>
                  )}
                </CardPanel>
              </Card>
            </CardFrame>
            <div className="min-w-0">
              {selected ? (
                <ProviderDetail
                  deleteError={remove.error}
                  deletePending={remove.isPending}
                  key={selected.id}
                  onDelete={() => remove.mutate(selected.id)}
                  provider={selected}
                />
              ) : (
                <Card>
                  <CardPanel>
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>No provider selected</EmptyTitle>
                        <EmptyDescription>
                          Add or select a provider to configure it.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </CardPanel>
                </Card>
              )}
            </div>
          </div>
        </TabsPanel>
      </div>
    </Tabs>
  )
}

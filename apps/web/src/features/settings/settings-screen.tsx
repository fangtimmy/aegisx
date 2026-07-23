import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Boxes,
  Braces,
  CircleAlert,
  Settings2,
  SlidersHorizontal,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { keys, providersApi, type SettingsPublic, settingsApi } from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { GeneralSettings } from "./general-settings"
import { PromptSettings } from "./prompt-settings"
import { ProviderDetail } from "./provider-detail"
import { ProviderDialog } from "./provider-dialog"
import { RuntimeDefaults } from "./runtime-defaults"

type SettingsSection = "general" | "models" | "prompts" | "runtime"

const sectionPaths: Record<SettingsSection, string> = {
  general: "/settings/general",
  models: "/settings/models",
  prompts: "/settings/prompts",
  runtime: "/settings/runtime",
}

export function SettingsScreen() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const section =
    (Object.entries(sectionPaths).find(
      ([, path]) => path === location.pathname
    )?.[0] as SettingsSection | undefined) ?? "general"
  const providers = useQuery({
    queryKey: keys.providers.all,
    queryFn: () => providersApi.listProviders(),
  })
  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
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
    mutationFn: (id: string) => providersApi.deleteProvider(id),
    onSuccess: () => {
      setSelectedId(null)
      queryClient.invalidateQueries({ queryKey: keys.providers.all })
    },
  })
  const toggleProvider = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      providersApi.updateProvider(id, { enabled }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.providers.all }),
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
      onValueChange={(value) =>
        navigate(sectionPaths[value as SettingsSection])
      }
      orientation="vertical"
      value={section}
    >
      <div className="w-48 shrink-0 border-s">
        <TabsList className="w-full items-stretch" variant="underline">
          <TabsTab value="general">
            <SlidersHorizontal aria-hidden="true" /> General
          </TabsTab>
          <TabsTab value="models">
            <Boxes aria-hidden="true" /> Model providers
          </TabsTab>
          <TabsTab value="prompts">
            <Braces aria-hidden="true" /> Agent prompts
          </TabsTab>
          <TabsTab value="runtime">
            <Settings2 aria-hidden="true" /> Runtime defaults
          </TabsTab>
        </TabsList>
      </div>
      <div className="min-w-0 flex-1">
        <TabsPanel value="general">
          <GeneralSettings />
        </TabsPanel>
        <TabsPanel value="prompts">
          <CardFrame className="min-w-0">
            <CardFrameHeader>
              <CardFrameTitle>Agent prompts</CardFrameTitle>
              <CardFrameDescription>
                Templates used when new Runs and Agents start.
              </CardFrameDescription>
            </CardFrameHeader>
            <Card>
              <CardPanel>
                <PromptSettings
                  key={settings.data?.updatedAt}
                  settings={settings.data as SettingsPublic}
                />
              </CardPanel>
            </Card>
          </CardFrame>
        </TabsPanel>
        <TabsPanel value="runtime">
          <CardFrame className="min-w-0">
            <CardFrameHeader>
              <CardFrameTitle>Runtime defaults</CardFrameTitle>
              <CardFrameDescription>
                Used for every new run.
              </CardFrameDescription>
            </CardFrameHeader>
            <Card>
              <CardPanel>
                <RuntimeDefaults
                  providers={items}
                  settings={settings.data as SettingsPublic}
                />
              </CardPanel>
            </Card>
          </CardFrame>
        </TabsPanel>
        <TabsPanel value="models">
          <div className="grid min-w-0 grid-cols-[18rem_minmax(0,1fr)] gap-4">
            <CardFrame className="h-min">
              <CardFrameHeader>
                <CardFrameTitle>
                  <span className="flex items-center gap-2">
                    Providers
                    <Badge variant="secondary">{items.length}</Badge>
                  </span>
                </CardFrameTitle>
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
                      <div
                        className={cn(
                          "mb-1 flex items-center rounded-lg hover:bg-accent/50 focus-within:bg-accent/50",
                          selectedId === provider.id &&
                            "bg-secondary hover:bg-secondary focus-within:bg-secondary"
                        )}
                        key={provider.id}
                      >
                        <Button
                          className="h-auto min-w-0 flex-1 justify-start bg-transparent px-3 py-2 text-left hover:bg-transparent data-pressed:bg-transparent"
                          aria-pressed={selectedId === provider.id}
                          onClick={() => setSelectedId(provider.id)}
                          type="button"
                          variant="ghost"
                        >
                          <span className="flex min-w-0 flex-1 flex-col items-start">
                            <span className="w-full truncate font-medium text-sm">
                              {provider.label}
                            </span>
                            {!provider.apiKey && (
                              <span className="text-muted-foreground text-xs">
                                No key
                              </span>
                            )}
                          </span>
                          <Badge size="sm" variant="secondary">
                            {provider.models.length}
                          </Badge>
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

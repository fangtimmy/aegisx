import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Boxes, CircleAlert, Settings2, SlidersHorizontal } from "lucide-react"
import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { keys, providersApi, settingsApi } from "@/api"
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
import { ProviderDetail } from "./provider-detail"
import { ProviderDialog } from "./provider-dialog"
import { SchemaSettingsForm } from "./schema-form"

type SettingsSection = "general" | "models" | "settings"

const sectionPaths: Record<SettingsSection, string> = {
  general: "/settings/general",
  models: "/settings/models",
  settings: "/settings/settings",
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
        正在加载设置…
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
            <SlidersHorizontal aria-hidden="true" /> 常规
          </TabsTab>
          <TabsTab value="models">
            <Boxes aria-hidden="true" /> 模型供应商
          </TabsTab>
          <TabsTab value="settings">
            <Settings2 aria-hidden="true" /> 设置
          </TabsTab>
        </TabsList>
      </div>
      <div className="min-w-0 flex-1">
        <TabsPanel value="general">
          <GeneralSettings />
        </TabsPanel>
        <TabsPanel value="settings">
          <CardFrame className="min-w-0">
            <CardFrameHeader>
              <CardFrameTitle>设置</CardFrameTitle>
              <CardFrameDescription>
                可搜索的配置项。修改会自动保存。
              </CardFrameDescription>
            </CardFrameHeader>
            <Card>
              <CardPanel>
                {settings.data && (
                  <SchemaSettingsForm data={settings.data} providers={items} />
                )}
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
                    供应商
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
                  <nav aria-label="供应商连接">
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
                                无密钥
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
                              ? `禁用 ${provider.label}`
                              : `启用 ${provider.label}`
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
                        <EmptyTitle>未选择供应商</EmptyTitle>
                        <EmptyDescription>
                          添加或选择一个供应商以配置它。
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

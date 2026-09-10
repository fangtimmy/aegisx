import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { get } from "@aegisx/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"

import { registerActivityRoutes } from "./activity/routes"
import { readBootstrapSpec, runBootstrap } from "./bootstrap"
import { createDatabase } from "./db"
import { SCHEMA_VERSION } from "./db/schema"
import { createCatalogReader } from "./events/catalog"
import { registerEventRoutes } from "./events/routes"
import { agentAuth } from "./infrastructure/agent-auth"
import { createConfigStore } from "./infrastructure/config-store"
import { jsonError } from "./infrastructure/http-errors"
import { createStorage } from "./infrastructure/storage"
import { registerWebApp } from "./infrastructure/web-static"
import { registerPlatformRoutes } from "./platforms/routes"
import { createPlatformService } from "./platforms/service"
import { registerProviderRoutes } from "./providers/routes"
import { createContainerManager } from "./run/container/container-manager"
import {
  createLocalContainerManager,
  isLocalExecBackend,
} from "./run/container/local-manager"
import { registerRunRoutes } from "./run/routes"
import { createAgentService } from "./run/service"
import { registerSchedulerRoutes } from "./scheduler/routes"
import { registerSettingsRoutes } from "./settings/routes"

export function createApp(options: { dataDir: string }) {
  // A compiled single-binary build embeds the SPA under its basename at the
  // bunfs virtual root (`bun build --asset apps/web/dist`); source runs only
  // serve the web app when AEGISX_WEB_DIR points at a built dist.
  const embeddedWebDir = resolve(import.meta.dir, "dist")
  const webDir =
    process.env.AEGISX_WEB_DIR ??
    (existsSync(embeddedWebDir) ? embeddedWebDir : undefined)
  const configStore = createConfigStore(options.dataDir)
  const { db, sqlite, releaseLock } = createDatabase(options.dataDir)

  const storage = createStorage(options.dataDir)
  const getSettings = () => configStore.getSettings()

  const platformService = createPlatformService(
    db,
    storage,
    () => get(getSettings(), "runtime.maxAttachmentMb") * 1024 * 1024,
    configStore
  )

  // Single-image appliance (AEGISX_EXEC_BACKEND=local): the solver tool box
  // is this same container; otherwise solver tool boxes are separate docker
  // containers driven over dockerode.
  const containerManager = isLocalExecBackend()
    ? createLocalContainerManager()
    : createContainerManager()
  const agentService = createAgentService({
    db,
    dataDir: options.dataDir,
    containerManager,
    platformService,
    configStore,
    getSettings,
    // Appliance/eval builds run without a human: boot recovery must not strand
    // the queues behind a pause nobody can clear (see AgentServiceOptions).
    unattended: process.env.AEGISX_UNATTENDED === "1",
  })

  // Flag writes are a side path (platform → DB); refresh the submitting
  // agent's view and notify the event's scheduler. A full solve additionally
  // stops the challenge's other live agents; a multi-flag partial steers
  // them (partial carries the platform's progress message).
  platformService.setAgentHooks({
    onAgentFlagAccepted: (challengeId, agentId, outcome) => {
      if (agentId) agentService.refresh(agentId)
      agentService.notifyFlagAccepted(challengeId, agentId, outcome)
    },
    onAgentFlagPartial: (challengeId, message, agentId) => {
      if (agentId) agentService.refresh(agentId)
      agentService.notifyFlagPartial(challengeId, message, agentId)
    },
  })

  const boot = agentService.recoverOnBoot().catch((error: unknown) => {
    console.error("Boot recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  // Appliance auto-configuration (AEGISX_BOOTSTRAP=1): provider/event/
  // platform/scheduler setup from env, after boot recovery settled. A few
  // bounded retries ride out transient platform/gateway unavailability at
  // boot; the flow is idempotent, so retries only fill what's missing.
  if (process.env.AEGISX_BOOTSTRAP === "1") {
    const spec = readBootstrapSpec(process.env)
    void boot.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await runBootstrap(
            { db, configStore, platformService, agentService },
            spec
          )
          return
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (attempt >= 3) {
            console.error("Bootstrap failed (giving up; restart to retry)", {
              error: message,
            })
            return
          }
          console.warn("Bootstrap attempt failed, retrying", {
            attempt,
            error: message,
          })
          await new Promise((r) => setTimeout(r, 15_000))
        }
      }
    })
  }

  const app = new Hono()
  const catalog = createCatalogReader(db, platformService)

  // Agent identity gate: Bearer-token requests resolve to an agent principal
  // and are confined to the agent API surface; tokenless requests (user/UI)
  // pass through untouched.
  app.use("*", agentAuth(db))

  app.onError((error, c) => {
    // Hono's body parser reports malformed request bodies (e.g. broken JSON)
    // as client-input HTTPExceptions — not server faults, so no "Request
    // failed" log and a 400 envelope instead of the 500 path.
    if (error instanceof HTTPException) {
      return jsonError(c, { code: "invalid_json", message: error.message }, 400)
    }
    console.error("Request failed", {
      method: c.req.method,
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
    })
    return c.json(
      { error: { code: "internal_error", message: "Request failed" } },
      500
    )
  })

  if (!webDir) {
    app.get("/", (c) =>
      c.json({ name: "AegisX", status: "ok", version: SCHEMA_VERSION })
    )
  }

  // Model runtime sync is lazy: a live run's ModelRuntime refreshes on
  // demand when a model switch targets a provider/model added after the run
  // started (agent-factory's ensureWorkspaceRuntimeFresh). Provider/settings
  // writes only persist config here.
  registerProviderRoutes(app, { configStore })
  registerSettingsRoutes(app, { db, configStore })
  registerPlatformRoutes(app, platformService)
  registerEventRoutes(app, {
    db,
    storage,
    platformService,
    agentManager: {
      usageForEvent: (eventId: string) => agentService.usageForEvent(eventId),
      deleteAgentsForEvent: (eventId: string, scope: "solver" | "all") =>
        agentService.deleteAgentsForEvent(eventId, scope),
    },
    getSettings,
    catalog,
    cleanupChallengeChannels: (challengeId: string) =>
      agentService.channels.cleanupChallengeChannels(challengeId),
    deleteChallengeWorkspace: (eventId, challengeId) =>
      agentService.deleteChallengeWorkspace(eventId, challengeId),
    cleanupEventChannels: (eventId: string) =>
      agentService.channels.cleanupEventChannels(eventId),
    deleteEventWorkspaces: (eventId: string) =>
      agentService.deleteEventWorkspaces(eventId),
    cleanupQueueState: (eventId: string) =>
      agentService.queue().forget(eventId),
  })
  registerRunRoutes(app, {
    db,
    agentService,
  })
  registerSchedulerRoutes(app, { db, agentService })
  registerActivityRoutes(app, { db })

  // The SPA catch-all must be registered after every /api route.
  if (webDir) {
    registerWebApp(app, webDir)
  }

  return {
    app,
    db,
    close: async () => {
      await agentService.close()
      sqlite.close()
      releaseLock()
    },
  }
}

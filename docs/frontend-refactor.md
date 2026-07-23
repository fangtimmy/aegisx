# Frontend Architecture Refactor

Status: complete (core); large-page splits ongoing as needed
Last updated: 2026-07-23

## Goals

- Shared wire types are the single source of truth for messages and stream events.
- Feature code does not assemble HTTP paths or query keys ad hoc.
- REST/React Query and conversation SSE state stay on separate tracks.
- Event navigation is path-driven and easy to read.

## Done

### Shared contract

- `apps/shared/message.ts` defines `PublicAgentMessage` and content parts.
- `ConversationMessage.message` is typed as `PublicAgentMessage`.
- `RunStreamEvent.message.progress` uses the same public message type.
- Server inspector/session boundaries cast once into that public shape.

### API layer (`apps/web/src/api`)

- `client.ts` — `apiRequest` / `jsonRequest`
- `keys.ts` — query key factory
- Resource modules: `events`, `challenges`, `runs`, `providers`, `settings`, `platforms`
- Features import from `@/api`; `@/lib/api` is a deprecated re-export only

### Domain + stream

- `apps/web/src/domain/conversation.ts` — pure `buildConversation` / labels
- `apps/web/src/stream/parse-event.ts` — SSE payload parse
- `apps/web/src/stream/conversation-store.ts` — committed + live reconciliation
- `apps/web/src/stream/apply-run-meta.ts` — single React Query patch entry for run/agent meta
- `use-run-controller` uses keys + runsApi + stream helpers

### Routing

- Settings and event routes are declared from section/tab tables in `App.tsx`
- Event tab resolution uses helpers instead of nested pathname ternaries

### Feature splits

- Platform: `platform-binding`, `connect-platform-dialog`, `import-challenges-dialog`, `platform-config`
- Provider models: list UI + `provider-model-dialogs` + `provider-model-format`
- Runtime defaults: number fields via `number-field-control`
- Removed `eventKeys` shim (use `keys.events`)

## Layout

```text
apps/web/src/
  api/           HTTP + query keys
  domain/        pure conversation model
  stream/        SSE store + RQ meta adapter
  features/      UI and feature hooks
  components/    shell + coss ui (ui is read-only)
  lib/           toast/utils + deprecated api re-export
```

## Rules going forward

1. No new bare `fetch(\`/api/...\`)` or path strings inside features — add to `api/*`.
2. No second `setQueryData` path for run SSE meta — use `applyRunMetaFromStream`.
3. Do not put conversation tokens into React Query; they belong in `ConversationStore`.
4. Do not edit `components/ui/**`.
5. Prefer `@/api` imports; do not grow `@/lib/api`.

## Optional follow-ups

- Further split statistics / general-settings / challenge-dialog if they grow again.
- Delete `@/lib/api` once no remaining imports.
- Bundle-size investigation only if startup metrics require it.

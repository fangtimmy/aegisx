# Maintainability Refactor

Status: in progress
Last updated: 2026-07-20

This document tracks the maintainability cleanup described in the initial
refactor plan. It is intentionally incremental: behavior and API contracts
must remain stable while responsibilities become easier to locate and test.

## Goals

- Keep application assembly separate from HTTP route implementation.
- Keep Run lifecycle coordination separate from tools and read models.
- Keep platform and provider integrations behind explicit boundaries.
- Keep frontend data/control state separate from view rendering.
- Prefer existing dependencies and small local abstractions over new framework
  layers.
- Make every structural change verifiable with the existing checks and tests.

## Completed

### Baseline

- [x] Recorded the existing architecture and Run lifecycle constraints.
- [x] Verified the baseline with backend checks and tests.
- [x] Verified the baseline with frontend checks, typecheck, tests, and build.
- [x] Kept the existing API, SSE event shape, database schema, and Run behavior.

### Backend Assembly And Routes

- [x] Reduced `apps/server/src/app.ts` to application initialization and route
  registration.
- [x] Moved event, challenge, and attachment routes to
  `apps/server/src/event-routes.ts`.
- [x] Moved Run creation, detail, statistics, file, SSE, and control routes to
  `apps/server/src/run-routes.ts`.
- [x] Moved Settings, Prompt, and settings import/export routes to
  `apps/server/src/settings-routes.ts`.
- [x] Left Provider and Model management in
  `apps/server/src/provider-routes.ts`.

### Run Responsibilities

- [x] Moved Agent-specific tools to `apps/server/src/run-tools.ts`.
- [x] Moved conversation, Usage, tool statistics, and Inspector reads to
  `apps/server/src/run-inspector.ts`.
- [x] Moved Run persistence writes and event publication to
  `apps/server/src/run-state-store.ts`.
- [x] Moved `RunActionError` to `apps/server/src/run-errors.ts`.
- [x] Kept Run state transitions, session lifecycle, concurrency, and target
  coordination in `apps/server/src/runs.ts`.

### Frontend Responsibilities

- [x] Moved Run queries, SSE connection handling, Agent selection, and Run
  control mutations to `apps/web/src/features/runs/use-run-controller.ts`.
- [x] Kept Run layout and user interaction rendering in
  `apps/web/src/features/runs/run-workspace.tsx`.
- [x] Moved Provider editor state and mutations to
  `apps/web/src/features/settings/use-provider-editor.ts`.
- [x] Kept Provider configuration rendering in
  `apps/web/src/features/settings/provider-detail.tsx`.
- [x] Moved Provider model list, model dialogs, and Pi binding UI to
  `apps/web/src/features/settings/provider-models.tsx`.

### Platform Responsibilities

- [x] Moved platform-facing errors to
  `apps/server/src/platform-errors.ts`.
- [x] Moved inventory and attachment synchronization to
  `apps/server/src/platform-sync.ts`.
- [x] Moved submission persistence and completion checks to
  `apps/server/src/platform-submissions.ts`.
- [x] Moved target lifecycle operations to
  `apps/server/src/platform-targets.ts`.
- [x] Centralized active target states used by detach and ignore checks.
- [x] Detect a disappeared Docker container after failed workspace operations,
  then pause the Run and release its sessions.

### Verification

- [x] Backend `bun run check` passes.
- [x] Backend `bun run test` passes: 45 tests. The script runs the suite
  serially because Run and Docker integration tests share host resources.
- [x] Frontend `bun run check` passes.
- [x] Frontend `bun run typecheck` passes.
- [x] Frontend `bun test` passes: 9 tests.
- [x] Frontend `bun run build` passes.
- [x] `git diff --check` passes.
- [x] No new dependency was added.

The frontend build still reports the existing bundle-size warning for a chunk
larger than 500 kB. It does not currently fail the build.

Current checkpoint: P0 behavior protection, both P1 batches, and frontend
cleanup are complete. The type/error boundary audit is mostly complete; deep
validation of persisted Agent message contents remains. The other remaining
work is conditional Vite bundle investigation and final cleanup review.

## Next Work

Work in this order. Each item should be completed as a small change followed
by the full relevant check and test command.

### P0: Protect Behavior

- [x] Add explicit Run lifecycle regression cases for restart recovery,
  pause/resume, child failure, concurrency, and container failure cleanup.
- [x] Add focused SSE replay tests for ordering, terminal events, and reconnect
  behavior.
- [x] Review the frontend test boundary. The existing `RunStreamStore` tests
  cover stream reconciliation and terminal closure; no React hook harness was
  added solely for `useRunController`.

Acceptance criteria: the tests fail when lifecycle or stream behavior changes,
and the existing backend and frontend test suites remain green.

### P1: Simplify Platform Service

- [x] Review `apps/server/src/platform-service.ts` and separate only the
  responsibilities that have stable boundaries: inventory sync, attachment
  sync, submission, and target lifecycle.
- [x] Centralize target-state rules so Run completion, platform detachment, and
  event deletion do not duplicate policy checks.
- [x] Keep platform adapters in `platform-ctfd.ts`, `platform-ret2shell.ts`,
  and `platform-a1ctf.ts` focused on remote protocol translation.

Acceptance criteria: platform behavior and existing integration tests are
unchanged; no generic repository or service hierarchy is introduced.

### P1: Finish Run Core Cleanup

- [x] Review the remaining `runs.ts` sections for persistence writes,
  lifecycle transitions, and session attachment boundaries.
- [x] Extract a small persistence boundary only where it removes real
  duplication from Run state transitions.
- [x] Keep one clear owner for Run status transitions and Run locks.

Acceptance criteria: no status transition is implemented in more than one
place, and lifecycle tests cover every public action.

### P2: Finish Frontend Cleanup

- [x] Split the stable Provider configuration and model-management sections
  from `provider-detail.tsx`.
- [x] Audit query keys and mutation invalidation across Settings and Run
  features. Existing root keys (`providers`, `settings`, and `runs`) are
  consistent, so no speculative renaming was added.
- [x] Keep `components/ui` unchanged because no concrete behavior or
  accessibility issue was found.

Acceptance criteria: feature components own page composition while hooks own
server state and side effects; no new global state layer is added.

### P2: Type And Error Boundary Audit

- [x] Remove avoidable `as unknown as` casts at API and event boundaries. The
  remaining three casts are retained for the Node/web stream type mismatch and
  explicit AgentEvent-to-public-event shape conversions.
- [ ] Deep-validate persisted Agent message roles and content parts. Top-level
  message shape, Usage records, and inbox metadata are already checked at
  their read boundaries.
- [x] Unify repeated `not_found` and action-error response formatting in
  `http-errors.ts` across route modules.

Acceptance criteria: typecheck remains strict and error responses retain their
current status codes and public shape.

### P3: Build And Documentation Follow-up

- [ ] Investigate the Vite chunk warning only if startup or delivery metrics
  show a real problem.
- [x] Update this document after each completed batch.
- [x] Review the final diff, run all checks, and create a focused commit after
  the user requested committing.

## Working Rules

- One responsibility change per batch.
- Preserve public API and database behavior unless explicitly planned.
- Do not add an abstraction for a single implementation.
- Do not reformat unrelated files.
- Delete helpers made obsolete by a refactor.
- Run the narrow test first, then the full suite before marking a checkbox.

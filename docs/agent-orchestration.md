# Multi-agent orchestration

This document records runtime constraints that are not obvious from the UI. The implementation in `apps/server/src/runs.ts` and the database schema remain authoritative.

## Run model

- A run has exactly one main agent and zero or more child agents.
- Only the main agent can create children or complete the run.
- Child agents cannot create more agents.
- User messages are delivered only to the main agent.
- All agents in a run use the run's model, credentials, and execution environment.
- `maxConcurrency` counts active agents, not runs.

The main agent can call `spawn_agent` to start focused work in the background and `inspect_agent` to read a child status when needed. Completed child output is persisted to the main agent inbox and delivered automatically.

## Lifecycle

- A main agent that finishes a turn without completing the run becomes `idle`; the run remains `running`.
- A child that finishes becomes `completed` or `failed` and reports its result to the main agent.
- A child failure does not fail the run.
- Pause, resume, stop, and completion apply to every non-terminal agent in the run.
- Resume requires enough concurrency capacity for all paused agents.
- On API startup, interrupted running agents and runs become `paused`; no model or tool is called automatically.
- Only `finish_run(summary, flag?)` changes a run to `completed`.

## Persistence

SQLite stores run and agent state, ordered messages, pending inbox entries, context summaries, runtime snapshots, and compaction usage. Inbox entries are marked delivered only after the corresponding message is persisted.

Runtime snapshots expose the effective system prompt, logical working directory, model, and tools. API keys, flags, home paths, and data paths are redacted before snapshots or events leave the runtime.

## Workspaces

Every agent in a run uses the same workspace root and the same path namespace. Tool arguments, shell commands, runtime snapshots, and reported artifact paths are all relative to that root.

The workspace is collaborative rather than isolated. Delegated tasks should avoid conflicting writes; AegisX does not lock files or merge per-agent copies. Local execution inherits API process permissions, while container execution uses the run's shared restricted container.

## Events and usage

SSE events identify the run or agent they belong to:

```ts
type RunEvent =
  | { type: "status"; run: RunPublic }
  | { type: "agent_status"; agent: AgentPublic }
  | { type: "agent_event"; agentId: string; event: AgentEvent }
```

Conversation history and live events are isolated by agent ID. Run usage is the sum of message and compaction usage for every agent in the run.

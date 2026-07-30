> **ARCHIVED.** v2 frontend notes; superseded by [../architecture.md](../architecture.md).

# Frontend notes (v2)

See [architecture-v2.md](./architecture-v2.md) for the current contract.

```text
apps/web/src/
  api/       HTTP + query keys
  domain/    pure conversation model (Message-based)
  stream/    live SSE ConversationStore
  features/  UI
```

Rules:

1. No bare `fetch('/api/...')` in features — use `api/*`.
2. Conversation tokens live in `ConversationStore`, not React Query.
3. Do not edit `components/ui/**`.
4. Stream endpoint: `GET /api/runs/:id/stream` (live only).

import { useCallback, useSyncExternalStore } from "react"

import type { ConversationStore } from "./conversation-store"

/** Subscribe to one agent's slice of the {@link ConversationStore}. Collapses
 * the `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)` boilerplate
 * (and its per-agent `useCallback` pair) into one call. The selector should be
 * stable — a module-level function or a `useCallback` — since a new reference
 * re-reads the snapshot on every render (harmless for the store's memoized
 * values, but noisy). */
export function useStoreValue<T>(
  store: ConversationStore,
  agentId: string,
  selector: (store: ConversationStore, agentId: string) => T
): T {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(agentId, listener),
    [store, agentId]
  )
  const getSnapshot = useCallback(
    () => selector(store, agentId),
    [selector, store, agentId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

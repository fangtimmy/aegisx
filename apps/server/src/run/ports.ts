/**
 * Write-once port for the run assembly root's late-bound modules.
 *
 * The assembly graph is cyclic: the queue's launch spawns through the
 * factory, the factory's boot recovery resets queue items, and the status
 * core / channels / factory all read the scheduler admin. The modules
 * therefore cannot be built with plain consts in one pass. Each port is bound
 * exactly once, immediately after its owner is constructed, and is read only
 * from closures that run after the whole service is wired.
 *
 * Modelling the slot as possibly-unbound removes the definite-assignment
 * (`let x!`) escape hatch: the type shows the value may not exist yet, every
 * read goes through {@link RunPort.get}, and an out-of-order read fails loudly
 * instead of silently yielding undefined.
 */
export type RunPort<T> = {
  bind(value: T): void
  get(): T
}

export function createRunPort<T>(name: string): RunPort<T> {
  let value: T | undefined
  return {
    bind(next: T): void {
      value = next
    },
    get(): T {
      if (value === undefined) {
        throw new Error(`run port "${name}" read before bind`)
      }
      return value
    },
  }
}

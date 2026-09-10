/** Public outlet of the host layer: code outside the runtime (route layers
 * such as run/routes, run/scheduler-admin, events) imports host capabilities
 * only from here — never from run/host/* internals (enforced by lint). */
export { roleField, usageField, usageTotalsSql } from "./session-queries"

/** Single-line lifecycle log for the process console. Run-lifecycle lines
 * are meant to be grepped in `docker logs` and read in dev: an in-process
 * HH:MM:SS stamp keeps the timeline readable without `docker logs -t`, and
 * the fields render as one-line JSON. Call sites are domain-event
 * chokepoints — never per turn or per tool call. */
export function logEvent(
  scope: string,
  message: string,
  fields?: Record<string, unknown>
): void {
  const stamp = new Date().toTimeString().slice(0, 8)
  const rest =
    fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ""
  console.log(`${stamp} ${scope}: ${message}${rest}`)
}

// Wake sources a child's own session lifecycle publishes on the RPC extension-event lane
// (`extension_event` records). A turn that ended on a terminal provider error is only "terminal
// with no live continuation" when none of these owns the session: a goal's recovery timer
// (`goal_continuation_timer_state`), a terminal monitor's live watches (`terminal_monitor_state`),
// or a wake-source channel (`wake_source_state`). The runner subscribes through
// `subscribeExtensionEvents`, so these records are parsed at the handle, never by the wire client.

export type TurnWakeSources = {
  readonly observe: (record: unknown) => void
  readonly hasLiveWakeSources: () => boolean
  readonly reset: () => void
}

type WakeSourceRecord = { readonly name?: unknown; readonly data?: unknown }

function asWakeSourceRecord(record: unknown): WakeSourceRecord | undefined {
  if (typeof record !== "object" || record === null) return undefined
  return record as WakeSourceRecord
}

function isExtensionEventNamed(record: WakeSourceRecord, name: string): boolean {
  return record.name === name
}

function goalTimerArmed(data: unknown): boolean | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const armed = (data as { readonly armed?: unknown }).armed
  return typeof armed === "boolean" ? armed : undefined
}

function monitorActiveCount(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const count = (data as { readonly activeCount?: unknown }).activeCount
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined
}

function wakeSourceActiveCount(data: unknown): number | undefined {
  return monitorActiveCount(data)
}

export function createTurnWakeSources(): TurnWakeSources {
  let goalTimerLive = false
  const wakeChannels = new Map<string, number>()
  const monitorWatches = new Map<string, true>()

  const trackMonitorSnapshot = (data: unknown): void => {
    const count = monitorActiveCount(data)
    if (count === undefined) return
    if (count === 0) {
      monitorWatches.clear()
      return
    }
    const items = typeof data === "object" && data !== null ? (data as { readonly monitors?: unknown }).monitors : undefined
    if (!Array.isArray(items)) return
    const seen = new Set<string>()
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const id = (item as { readonly id?: unknown }).id
      if (typeof id === "string" && id.length > 0) {
        monitorWatches.set(id, true)
        seen.add(id)
      }
    }
    for (const id of [...monitorWatches.keys()]) {
      if (!seen.has(id)) monitorWatches.delete(id)
    }
  }

  return {
    observe(record) {
      const event = asWakeSourceRecord(record)
      if (event === undefined || typeof event.name !== "string") return
      if (isExtensionEventNamed(event, "goal_continuation_timer_state")) {
        const armed = goalTimerArmed(event.data)
        if (armed !== undefined) goalTimerLive = armed
        return
      }
      if (isExtensionEventNamed(event, "terminal_monitor_state")) {
        trackMonitorSnapshot(event.data)
        return
      }
      if (isExtensionEventNamed(event, "terminal_monitor_ended")) {
        const id =
          typeof event.data === "object" && event.data !== null
            ? (event.data as { readonly id?: unknown }).id
            : undefined
        if (typeof id === "string") monitorWatches.delete(id)
        return
      }
      if (isExtensionEventNamed(event, "wake_source_state")) {
        const count = wakeSourceActiveCount(event.data)
        const source =
          typeof event.data === "object" && event.data !== null
            ? (event.data as { readonly source?: unknown }).source
            : undefined
        if (count !== undefined && typeof source === "string" && source.length > 0) {
          if (count > 0) wakeChannels.set(source, count)
          else wakeChannels.delete(source)
        }
      }
    },
    hasLiveWakeSources() {
      if (goalTimerLive) return true
      if (wakeChannels.size > 0) return true
      return monitorWatches.size > 0
    },
    reset() {
      goalTimerLive = false
      wakeChannels.clear()
      monitorWatches.clear()
    },
  }
}

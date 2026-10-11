import type { SenpiExtensionAPI } from "../../extension/types"
import { isRecord, sessionIdFrom } from "./wiring-context"

/** Permission is local to this engine run, never restored from transcript history. */
export function createMemoryUserActivity() {
  const accepted = new Set<string>()
  const reconciled = new Set<string>()
  const inputs = new Map<string, string>()
  return {
    has: (sessionId: string): boolean => accepted.has(sessionId),
    reset(sessionId: string): void {
      accepted.delete(sessionId)
      reconciled.delete(sessionId)
      for (const [inputId, owner] of inputs) if (owner === sessionId) inputs.delete(inputId)
    },
    async reconcileOnce(sessionId: string, reconcile: () => Promise<void>): Promise<void> {
      if (!accepted.has(sessionId) || reconciled.has(sessionId)) return
      await reconcile()
      reconciled.add(sessionId)
    },
    register(pi: SenpiExtensionAPI): void {
      pi.on("input", (payload, eventCtx) => {
        if (!isRecord(payload) || payload.source === "extension"
          || typeof payload.inputId !== "string"
          || typeof payload.text !== "string"
          || (payload.text.trim().length === 0 && (!Array.isArray(payload.images) || payload.images.length === 0))) return
        const sessionId = sessionIdFrom(eventCtx)
        if (sessionId !== undefined) inputs.set(payload.inputId, sessionId)
      })
      pi.on("input_disposition", (payload) => {
        if (!isRecord(payload) || typeof payload.inputId !== "string") return
        const sessionId = inputs.get(payload.inputId)
        inputs.delete(payload.inputId)
        if (sessionId !== undefined && (payload.disposition === "started" || payload.disposition === "queued")) {
          accepted.add(sessionId)
        }
      })
    },
  }
}

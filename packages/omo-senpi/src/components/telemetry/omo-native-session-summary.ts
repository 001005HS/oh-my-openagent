import { createHash } from "node:crypto"

import type { EventTelemetryProperties, TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"

import type { OmoNativeEventName } from "./product-identity"
import type { SummaryStore } from "./session-summary-store"
import {
  addTurn,
  openWindow,
  summaryProperties,
  type EndedBy,
  type SummaryTurn,
  type SummaryWindow,
} from "./session-summary-window"

export type { SummaryTurn } from "./session-summary-window"

export const RAW_TURN_SAMPLE_RATE = 0.05
export const CHECKPOINT_MAX_TURNS = 50
export const CHECKPOINT_MAX_WINDOW_MS = 30 * 60_000

export type SessionSummaryOptions = {
  readonly captureEvent: (name: OmoNativeEventName, properties: EventTelemetryProperties) => void
  readonly store: SummaryStore
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
  readonly sessionRole?: string
  readonly now?: () => number
  readonly sampleRate?: number
}

export type SessionSummaryRecorder = {
  readonly isRawTurnSampled: (sessionHash: string) => boolean
  readonly sampleRate: number
  readonly recordTurn: (sessionHash: string, turn: SummaryTurn) => void
  /** `reload` keeps the session's sequence and file so the next registration continues it. */
  readonly finish: (sessionHash: string, reason: string | undefined) => void
}

type Live = { nextSeq: number; window: SummaryWindow | null }

export function isSessionSampled(sessionHash: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return false
  const bucket = createHash("sha256").update(`turn-sample:${sessionHash}`).digest().readUInt32BE(0)
  return bucket / 0x1_0000_0000 < sampleRate
}

export function createSessionSummaryRecorder(options: SessionSummaryOptions): SessionSummaryRecorder {
  const now = options.now ?? Date.now
  const sampleRate = options.sampleRate ?? RAW_TURN_SAMPLE_RATE
  const sessionRole = options.sessionRole ?? "main"
  const live = new Map<string, Live>()
  const resumedSeq = new Map<string, number>()
  let recovered = false

  const emit = (sessionHash: string, window: SummaryWindow, seq: number, endedBy: EndedBy, role: string): void => {
    options.captureEvent("session_summary", summaryProperties(sessionHash, window, {
      endedBy,
      seq,
      sampleRate,
      sampled: isSessionSampled(sessionHash, sampleRate),
      sessionRole: role,
    }))
  }

  // Rollups a crashed or killed process left behind are sent once, from the first live event, so the
  // capture path is already installed and only one of several racing processes claims each file.
  const recoverOrphans = (): void => {
    if (recovered) return
    recovered = true
    for (const orphan of options.store.claimOrphans()) {
      resumedSeq.set(orphan.sessionHash, orphan.nextSeq + 1)
      if (orphan.window === null && orphan.nextSeq === 0) continue
      emit(orphan.sessionHash, orphan.window ?? openWindow(now(), 0), orphan.nextSeq, "recovered", orphan.sessionRole)
    }
  }

  const liveFor = (sessionHash: string): Live => {
    const cached = live.get(sessionHash)
    if (cached !== undefined) return cached
    const stored = options.store.read(sessionHash)
    const entry: Live = stored === undefined
      ? { nextSeq: resumedSeq.get(sessionHash) ?? 0, window: null }
      : { nextSeq: stored.nextSeq, window: stored.window }
    live.set(sessionHash, entry)
    return entry
  }

  const persist = (sessionHash: string, entry: Live): void => {
    try {
      options.store.write({ sessionHash, sessionRole, nextSeq: entry.nextSeq, window: entry.window })
    } catch (error) {
      options.diagnostics?.({
        event: "telemetry_activity_state_write_failed",
        source: "omo-native-session-summary",
        error: error instanceof Error ? error : new Error(String(error)),
        errorKind: "error",
      })
    }
  }

  const flush = (sessionHash: string, entry: Live, endedBy: EndedBy): void => {
    emit(sessionHash, entry.window ?? openWindow(now(), 0), entry.nextSeq, endedBy, sessionRole)
    entry.nextSeq += 1
    entry.window = null
  }

  return {
    sampleRate,
    isRawTurnSampled: (sessionHash) => isSessionSampled(sessionHash, sampleRate),
    recordTurn(sessionHash, turn) {
      recoverOrphans()
      const entry = liveFor(sessionHash)
      const at = now()
      entry.window ??= openWindow(at, turn.turnIndex)
      addTurn(entry.window, turn, at)
      if (entry.window.turns >= CHECKPOINT_MAX_TURNS || at - entry.window.startedAt >= CHECKPOINT_MAX_WINDOW_MS) {
        flush(sessionHash, entry, "checkpoint")
      }
      persist(sessionHash, entry)
    },
    finish(sessionHash, reason) {
      recoverOrphans()
      const entry = liveFor(sessionHash)
      live.delete(sessionHash)
      if (reason === "reload") {
        if (entry.window !== null) flush(sessionHash, entry, "reload")
        if (entry.nextSeq > 0) persist(sessionHash, entry)
        return
      }
      if (entry.window !== null || entry.nextSeq > 0) flush(sessionHash, entry, "shutdown")
      options.store.remove(sessionHash)
    },
  }
}

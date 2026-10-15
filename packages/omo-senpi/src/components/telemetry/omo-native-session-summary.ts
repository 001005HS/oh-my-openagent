import { createHash } from "node:crypto"

import type { EventTelemetryProperties } from "@oh-my-opencode/telemetry-core"

import type { OmoNativeEventName } from "./product-identity"

export const RAW_TURN_SAMPLE_RATE = 0.05
export const CHECKPOINT_MAX_TURNS = 50
export const CHECKPOINT_MAX_WINDOW_MS = 30 * 60_000

export type SummaryTurn = {
  readonly turnIndex: number
  readonly provider: string
  readonly modelId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly costUsd: number
  readonly usageValid: boolean
  readonly stopReason: string | undefined
  readonly toolResultCount: number
  readonly toolErrorCount: number
}

type Window = {
  startedAt: number
  lastAt: number
  firstTurnIndex: number
  lastTurnIndex: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number
  invalidUsageTurns: number
  errorTurns: number
  abortedTurns: number
  toolResultCount: number
  toolErrorCount: number
  customModelTurns: number
  perTurnTotals: number[]
  modelTurns: Map<string, { provider: string; modelId: string; turns: number }>
}

export type SessionSummaryOptions = {
  readonly captureEvent: (name: OmoNativeEventName, properties: EventTelemetryProperties) => void
  readonly now?: () => number
  readonly sampleRate?: number
}

export type SessionSummaryRecorder = {
  readonly isRawTurnSampled: (sessionHash: string) => boolean
  readonly sampleRate: number
  readonly recordTurn: (sessionHash: string, turn: SummaryTurn) => void
  readonly finish: (sessionHash: string) => void
}

export function isSessionSampled(sessionHash: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return false
  const bucket = createHash("sha256").update(`turn-sample:${sessionHash}`).digest().readUInt32BE(0)
  return bucket / 0x1_0000_0000 < sampleRate
}

export function createSessionSummaryRecorder(options: SessionSummaryOptions): SessionSummaryRecorder {
  const now = options.now ?? Date.now
  const sampleRate = options.sampleRate ?? RAW_TURN_SAMPLE_RATE
  const windows = new Map<string, Window>()
  const sequences = new Map<string, number>()

  const emit = (sessionHash: string, window: Window, isFinal: boolean): void => {
    const seq = sequences.get(sessionHash) ?? 0
    sequences.set(sessionHash, seq + 1)
    options.captureEvent("session_summary", summaryProperties(sessionHash, window, {
      isFinal,
      seq,
      sampleRate,
      sampled: isSessionSampled(sessionHash, sampleRate),
    }))
  }

  return {
    sampleRate,
    isRawTurnSampled: (sessionHash) => isSessionSampled(sessionHash, sampleRate),
    recordTurn(sessionHash, turn) {
      const at = now()
      const window = windows.get(sessionHash) ?? openWindow(at, turn.turnIndex)
      windows.set(sessionHash, window)
      addTurn(window, turn, at)
      if (window.turns >= CHECKPOINT_MAX_TURNS || at - window.startedAt >= CHECKPOINT_MAX_WINDOW_MS) {
        windows.delete(sessionHash)
        emit(sessionHash, window, false)
      }
    },
    finish(sessionHash) {
      const window = windows.get(sessionHash)
      windows.delete(sessionHash)
      const checkpointed = sequences.has(sessionHash)
      if (window !== undefined || checkpointed) {
        const at = now()
        emit(sessionHash, window ?? openWindow(at, 0), true)
      }
      sequences.delete(sessionHash)
    },
  }
}

function openWindow(at: number, turnIndex: number): Window {
  return {
    startedAt: at,
    lastAt: at,
    firstTurnIndex: turnIndex,
    lastTurnIndex: turnIndex,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    invalidUsageTurns: 0,
    errorTurns: 0,
    abortedTurns: 0,
    toolResultCount: 0,
    toolErrorCount: 0,
    customModelTurns: 0,
    perTurnTotals: [],
    modelTurns: new Map(),
  }
}

function addTurn(window: Window, turn: SummaryTurn, at: number): void {
  window.lastAt = at
  window.lastTurnIndex = turn.turnIndex
  window.turns += 1
  window.inputTokens += turn.inputTokens
  window.outputTokens += turn.outputTokens
  window.cacheReadTokens += turn.cacheReadTokens
  window.cacheWriteTokens += turn.cacheWriteTokens
  window.reasoningTokens += turn.reasoningTokens
  window.totalTokens += turn.totalTokens
  window.costUsd += turn.costUsd
  if (!turn.usageValid) window.invalidUsageTurns += 1
  if (turn.stopReason === "error") window.errorTurns += 1
  if (turn.stopReason === "aborted") window.abortedTurns += 1
  window.toolResultCount += turn.toolResultCount
  window.toolErrorCount += turn.toolErrorCount
  if (turn.modelId === "custom") window.customModelTurns += 1
  window.perTurnTotals.push(turn.totalTokens)
  const key = `${turn.provider}/${turn.modelId}`
  const entry = window.modelTurns.get(key) ?? { provider: turn.provider, modelId: turn.modelId, turns: 0 }
  entry.turns += 1
  window.modelTurns.set(key, entry)
}

type EmitMeta = { readonly isFinal: boolean; readonly seq: number; readonly sampleRate: number; readonly sampled: boolean }

function summaryProperties(sessionHash: string, window: Window, meta: EmitMeta): EventTelemetryProperties {
  const dominant = dominantModel(window)
  return {
    $session_id: sessionHash,
    summary_seq: meta.seq,
    is_final: meta.isFinal,
    sample_rate: meta.sampleRate,
    raw_turns_sampled: meta.sampled,
    turns: window.turns,
    first_turn_index: window.firstTurnIndex,
    last_turn_index: window.lastTurnIndex,
    window_ms: window.lastAt - window.startedAt,
    input_tokens: window.inputTokens,
    output_tokens: window.outputTokens,
    cache_read_tokens: window.cacheReadTokens,
    cache_write_tokens: window.cacheWriteTokens,
    reasoning_tokens: window.reasoningTokens,
    total_tokens: window.totalTokens,
    total_tokens_p50: percentile(window.perTurnTotals, 0.5),
    total_tokens_p95: percentile(window.perTurnTotals, 0.95),
    total_tokens_max: window.perTurnTotals.reduce((max, value) => Math.max(max, value), 0),
    cost_usd: Math.round((window.costUsd + Number.EPSILON) * 10_000) / 10_000,
    invalid_usage_turns: window.invalidUsageTurns,
    error_turns: window.errorTurns,
    aborted_turns: window.abortedTurns,
    tool_result_count: window.toolResultCount,
    tool_error_count: window.toolErrorCount,
    model_count: window.modelTurns.size,
    custom_model_turns: window.customModelTurns,
    dominant_provider: dominant?.provider ?? "custom",
    dominant_model: dominant?.modelId ?? "custom",
    dominant_model_turns: dominant?.turns ?? 0,
  }
}

function dominantModel(window: Window): { provider: string; modelId: string; turns: number } | undefined {
  let best: { provider: string; modelId: string; turns: number } | undefined
  for (const entry of window.modelTurns.values()) {
    if (best === undefined || entry.turns > best.turns) best = entry
  }
  return best
}

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil(q * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0
}

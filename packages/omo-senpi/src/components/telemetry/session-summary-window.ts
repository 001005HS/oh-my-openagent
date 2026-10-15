import type { EventTelemetryProperties } from "@oh-my-opencode/telemetry-core"

export const MODEL_SLOTS = 3

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

export type ModelTotals = {
  provider: string
  modelId: string
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number
}

export type SummaryWindow = {
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
  models: ModelTotals[]
}

export const ENDED_BY = ["checkpoint", "shutdown", "reload", "recovered"] as const
export type EndedBy = (typeof ENDED_BY)[number]

export type SummaryMeta = {
  readonly endedBy: EndedBy
  readonly seq: number
  readonly sampleRate: number
  readonly sampled: boolean
  readonly sessionRole: string
}

export function openWindow(at: number, turnIndex: number): SummaryWindow {
  return {
    startedAt: at, lastAt: at, firstTurnIndex: turnIndex, lastTurnIndex: turnIndex, turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    totalTokens: 0, costUsd: 0, invalidUsageTurns: 0, errorTurns: 0, abortedTurns: 0,
    toolResultCount: 0, toolErrorCount: 0, customModelTurns: 0, perTurnTotals: [], models: [],
  }
}

export function addTurn(window: SummaryWindow, turn: SummaryTurn, at: number): void {
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
  const existing = window.models.find((entry) => entry.provider === turn.provider && entry.modelId === turn.modelId)
  const entry = existing ?? { provider: turn.provider, modelId: turn.modelId, turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
  entry.turns += 1
  entry.inputTokens += turn.inputTokens
  entry.outputTokens += turn.outputTokens
  entry.totalTokens += turn.totalTokens
  entry.costUsd += turn.costUsd
  if (existing === undefined) window.models.push(entry)
}

export function summaryProperties(sessionHash: string, window: SummaryWindow, meta: SummaryMeta): EventTelemetryProperties {
  return {
    $session_id: sessionHash,
    summary_seq: meta.seq,
    is_final: meta.endedBy === "shutdown",
    ended_by: meta.endedBy,
    session_role: meta.sessionRole,
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
    cost_usd: roundCost(window.costUsd),
    invalid_usage_turns: window.invalidUsageTurns,
    error_turns: window.errorTurns,
    aborted_turns: window.abortedTurns,
    tool_result_count: window.toolResultCount,
    tool_error_count: window.toolErrorCount,
    model_count: window.models.length,
    custom_model_turns: window.customModelTurns,
    ...modelSlots(window.models),
  }
}

function modelSlots(models: readonly ModelTotals[]): EventTelemetryProperties {
  const ranked = [...models].sort((left, right) => right.turns - left.turns || right.totalTokens - left.totalTokens)
  const slots: Record<string, string | number> = {}
  for (let slot = 1; slot <= MODEL_SLOTS; slot += 1) {
    const entry = ranked[slot - 1]
    slots[`m${slot}_provider`] = entry?.provider ?? "none"
    slots[`m${slot}_model`] = entry?.modelId ?? "none"
    slots[`m${slot}_turns`] = entry?.turns ?? 0
    slots[`m${slot}_input_tokens`] = entry?.inputTokens ?? 0
    slots[`m${slot}_output_tokens`] = entry?.outputTokens ?? 0
    slots[`m${slot}_total_tokens`] = entry?.totalTokens ?? 0
    slots[`m${slot}_cost_usd`] = roundCost(entry?.costUsd ?? 0)
  }
  const rest = ranked.slice(MODEL_SLOTS)
  slots["other_turns"] = rest.reduce((sum, entry) => sum + entry.turns, 0)
  slots["other_total_tokens"] = rest.reduce((sum, entry) => sum + entry.totalTokens, 0)
  slots["other_cost_usd"] = roundCost(rest.reduce((sum, entry) => sum + entry.costUsd, 0))
  return slots
}

function roundCost(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000
}

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil(q * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0
}

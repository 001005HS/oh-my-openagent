import { describe, expect, test } from "bun:test"
import type { EventTelemetryProperties } from "@oh-my-opencode/telemetry-core"

import {
  CHECKPOINT_MAX_TURNS,
  CHECKPOINT_MAX_WINDOW_MS,
  createSessionSummaryRecorder,
  isSessionSampled,
  percentile,
  type SummaryTurn,
} from "./omo-native-session-summary"
import { OMO_NATIVE_PROPERTY_ALLOWLISTS } from "./product-identity"

type Captured = { readonly name: string; readonly properties: EventTelemetryProperties }

function turn(overrides: Partial<SummaryTurn> = {}): SummaryTurn {
  return {
    turnIndex: 0,
    provider: "openai",
    modelId: "gpt-5.5",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: 5,
    totalTokens: 40,
    costUsd: 0.01,
    usageValid: true,
    stopReason: "stop",
    toolResultCount: 2,
    toolErrorCount: 0,
    ...overrides,
  }
}

function recorder(input: { readonly sampleRate?: number } = {}) {
  const captured: Captured[] = []
  let clock = 1_000
  const summary = createSessionSummaryRecorder({
    captureEvent: (name, properties) => captured.push({ name, properties }),
    now: () => clock,
    sampleRate: input.sampleRate ?? 0.05,
  })
  return { captured, summary, advance: (ms: number) => { clock += ms } }
}

describe("session_summary", () => {
  test("#given three turns #when the session ends #then one final summary carries their exact sums", () => {
    const { captured, summary, advance } = recorder()

    summary.recordTurn("s1", turn({ turnIndex: 0, totalTokens: 10, costUsd: 0.1 }))
    advance(500)
    summary.recordTurn("s1", turn({ turnIndex: 1, totalTokens: 30, costUsd: 0.2, stopReason: "error", toolErrorCount: 1 }))
    advance(500)
    summary.recordTurn("s1", turn({ turnIndex: 2, totalTokens: 20, costUsd: 0.3, modelId: "custom", provider: "custom" }))
    summary.finish("s1")

    expect(captured).toHaveLength(1)
    expect(captured[0]?.name).toBe("session_summary")
    expect(captured[0]?.properties).toMatchObject({
      $session_id: "s1",
      summary_seq: 0,
      is_final: true,
      turns: 3,
      first_turn_index: 0,
      last_turn_index: 2,
      window_ms: 1_000,
      total_tokens: 60,
      input_tokens: 30,
      total_tokens_p50: 20,
      total_tokens_p95: 30,
      total_tokens_max: 30,
      cost_usd: 0.6,
      error_turns: 1,
      tool_result_count: 6,
      tool_error_count: 1,
      model_count: 2,
      custom_model_turns: 1,
      dominant_model: "gpt-5.5",
      dominant_model_turns: 2,
    })
  })

  test("#given more turns than one window holds #when checkpoints fire #then summing the rows reproduces every turn once", () => {
    const { captured, summary } = recorder()
    const turns = CHECKPOINT_MAX_TURNS * 2 + 7

    for (let index = 0; index < turns; index += 1) summary.recordTurn("s1", turn({ turnIndex: index, totalTokens: index }))
    summary.finish("s1")

    expect(captured.map(({ properties }) => properties.summary_seq)).toEqual([0, 1, 2])
    expect(captured.map(({ properties }) => properties.is_final)).toEqual([false, false, true])
    const sum = (key: string) => captured.reduce((total, { properties }) => total + Number(properties[key]), 0)
    expect(sum("turns")).toBe(turns)
    expect(sum("total_tokens")).toBe((turns * (turns - 1)) / 2)
  })

  test("#given a long idle window #when the next turn arrives after the time limit #then the window is checkpointed", () => {
    const { captured, summary, advance } = recorder()

    summary.recordTurn("s1", turn({ turnIndex: 0 }))
    advance(CHECKPOINT_MAX_WINDOW_MS)
    summary.recordTurn("s1", turn({ turnIndex: 1 }))

    expect(captured).toHaveLength(1)
    expect(captured[0]?.properties).toMatchObject({ turns: 2, is_final: false })
  })

  test("#given a session that ended right after a checkpoint #when it finishes #then an empty final row still marks the end", () => {
    const { captured, summary } = recorder()

    for (let index = 0; index < CHECKPOINT_MAX_TURNS; index += 1) summary.recordTurn("s1", turn({ turnIndex: index }))
    summary.finish("s1")

    expect(captured.map(({ properties }) => [properties.summary_seq, properties.is_final, properties.turns])).toEqual([
      [0, false, CHECKPOINT_MAX_TURNS],
      [1, true, 0],
    ])
  })

  test("#given a session with no turns #when it finishes #then nothing is sent", () => {
    const { captured, summary } = recorder()
    summary.finish("s1")
    expect(captured).toHaveLength(0)
  })

  test("#given two sessions in one process #when both record #then their windows stay apart", () => {
    const { captured, summary } = recorder()
    summary.recordTurn("a", turn({ totalTokens: 1 }))
    summary.recordTurn("b", turn({ totalTokens: 100 }))
    summary.finish("a")
    summary.finish("b")
    expect(captured.map(({ properties }) => [properties.$session_id, properties.total_tokens])).toEqual([["a", 1], ["b", 100]])
  })

  test("#given the declared schema #when a summary is built #then it sends exactly the allowlisted keys", () => {
    const { captured, summary } = recorder()
    summary.recordTurn("s1", turn())
    summary.finish("s1")
    expect(Object.keys(captured[0]?.properties ?? {}).toSorted()).toEqual([...OMO_NATIVE_PROPERTY_ALLOWLISTS.session_summary].toSorted())
  })
})

describe("raw turn sampling", () => {
  test("#given the same session hash #when asked twice or from two recorders #then the decision never changes", () => {
    const hashes = Array.from({ length: 200 }, (_, index) => `session-${index}`)
    const first = hashes.map((hash) => isSessionSampled(hash, 0.05))
    const again = hashes.map((hash) => createSessionSummaryRecorder({ captureEvent: () => undefined, sampleRate: 0.05 }).isRawTurnSampled(hash))
    expect(again).toEqual(first)
  })

  test("#given 20,000 sessions #when sampled at 5% #then close to 5% are chosen", () => {
    let chosen = 0
    for (let index = 0; index < 20_000; index += 1) if (isSessionSampled(`h${index}`, 0.05)) chosen += 1
    expect(chosen / 20_000).toBeGreaterThan(0.04)
    expect(chosen / 20_000).toBeLessThan(0.06)
  })

  test("#given rates of 0 and 1 #when sampling #then none and all are chosen", () => {
    expect(isSessionSampled("any", 0)).toBe(false)
    expect(isSessionSampled("any", 1)).toBe(true)
  })

  test("#given the summary reports its sampling #when the session is sampled #then raw_turns_sampled matches the decision", () => {
    const { captured, summary } = recorder({ sampleRate: 1 })
    summary.recordTurn("s1", turn())
    summary.finish("s1")
    expect(captured[0]?.properties).toMatchObject({ raw_turns_sampled: true, sample_rate: 1 })
  })
})

describe("percentile", () => {
  test("#given values #when asked for nearest-rank percentiles #then it returns members of the set", () => {
    expect(percentile([], 0.5)).toBe(0)
    expect(percentile([7], 0.95)).toBe(7)
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.95)).toBe(95)
  })
})

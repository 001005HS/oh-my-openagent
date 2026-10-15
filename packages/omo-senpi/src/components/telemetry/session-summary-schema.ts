import { KNOWN_MODELS, KNOWN_PROVIDERS } from "./model-vocabulary"
import { ENDED_BY, MODEL_SLOTS } from "./session-summary-window"

const BOOLEAN_PROPERTY = Object.freeze({ type: "boolean" } as const)
const NUMBER_PROPERTY = Object.freeze({ type: "number" } as const)
const STRING_PROPERTY = Object.freeze({ type: "string" } as const)

function enumProperty<const Values extends readonly string[]>(values: Values): Readonly<{
  type: "string"
  values: Values
}> {
  return Object.freeze({ type: "string", values: Object.freeze(values) })
}

const MODEL_VALUES = [...new Set(Object.values(KNOWN_MODELS).flat()), "custom", "none"] as const
const PROVIDER_VALUES = [...KNOWN_PROVIDERS, "custom", "none"] as const

function modelSlotSchema(): Record<string, Readonly<{ type: "string" | "number"; values?: readonly string[] }>> {
  const slots: Record<string, Readonly<{ type: "string" | "number"; values?: readonly string[] }>> = {}
  for (let slot = 1; slot <= MODEL_SLOTS; slot += 1) {
    slots[`m${slot}_provider`] = enumProperty(PROVIDER_VALUES)
    slots[`m${slot}_model`] = enumProperty(MODEL_VALUES)
    for (const key of ["turns", "input_tokens", "output_tokens", "total_tokens", "cost_usd"]) {
      slots[`m${slot}_${key}`] = NUMBER_PROPERTY
    }
  }
  return slots
}

/**
 * `session_summary`: the assistant turns of one window, summed. Windows never overlap and a session keeps
 * one `summary_seq` sequence across reloads and crash recovery, so summing every row of a session
 * reproduces its per-turn totals; the percentiles describe only their own window. Raw `turn_completed`
 * rows ship only for sessions sampled at `sample_rate`, so their counts must be weighted by
 * `1 / sample_rate`. Per-model totals keep the top three models; the rest are folded into `other_*`.
 */
export const SESSION_SUMMARY_SCHEMA = Object.freeze({
  "$session_id": STRING_PROPERTY,
  aborted_turns: NUMBER_PROPERTY,
  cache_read_tokens: NUMBER_PROPERTY,
  cache_write_tokens: NUMBER_PROPERTY,
  cost_usd: NUMBER_PROPERTY,
  custom_model_turns: NUMBER_PROPERTY,
  ended_by: enumProperty(ENDED_BY),
  error_turns: NUMBER_PROPERTY,
  first_turn_index: NUMBER_PROPERTY,
  input_tokens: NUMBER_PROPERTY,
  invalid_usage_turns: NUMBER_PROPERTY,
  is_final: BOOLEAN_PROPERTY,
  last_turn_index: NUMBER_PROPERTY,
  model_count: NUMBER_PROPERTY,
  ...modelSlotSchema(),
  other_cost_usd: NUMBER_PROPERTY,
  other_total_tokens: NUMBER_PROPERTY,
  other_turns: NUMBER_PROPERTY,
  output_tokens: NUMBER_PROPERTY,
  raw_turns_sampled: BOOLEAN_PROPERTY,
  reasoning_tokens: NUMBER_PROPERTY,
  sample_rate: NUMBER_PROPERTY,
  session_role: enumProperty(["main", "child", "dag_child", "member"] as const),
  summary_seq: NUMBER_PROPERTY,
  tool_error_count: NUMBER_PROPERTY,
  tool_result_count: NUMBER_PROPERTY,
  total_tokens: NUMBER_PROPERTY,
  total_tokens_max: NUMBER_PROPERTY,
  total_tokens_p50: NUMBER_PROPERTY,
  total_tokens_p95: NUMBER_PROPERTY,
  turns: NUMBER_PROPERTY,
  window_ms: NUMBER_PROPERTY,
})

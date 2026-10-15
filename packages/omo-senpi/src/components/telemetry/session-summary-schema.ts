import { KNOWN_MODELS, KNOWN_PROVIDERS } from "./model-vocabulary"

const BOOLEAN_PROPERTY = Object.freeze({ type: "boolean" } as const)
const NUMBER_PROPERTY = Object.freeze({ type: "number" } as const)
const STRING_PROPERTY = Object.freeze({ type: "string" } as const)

function enumProperty<const Values extends readonly string[]>(values: Values): Readonly<{
  type: "string"
  values: Values
}> {
  return Object.freeze({ type: "string", values: Object.freeze(values) })
}

/**
 * `session_summary`: the assistant turns of one checkpoint window, summed. Windows never overlap, so
 * summing every `session_summary` row of a session reproduces the per-turn totals exactly; the
 * percentiles describe only their own window. Raw `turn_completed` rows ship only for sessions
 * sampled at `sample_rate`, so `turn_completed` counts must be weighted by `1 / sample_rate`.
 */
export const SESSION_SUMMARY_SCHEMA = Object.freeze({
  "$session_id": STRING_PROPERTY,
  aborted_turns: NUMBER_PROPERTY,
  cache_read_tokens: NUMBER_PROPERTY,
  cache_write_tokens: NUMBER_PROPERTY,
  cost_usd: NUMBER_PROPERTY,
  custom_model_turns: NUMBER_PROPERTY,
  dominant_model: enumProperty([...new Set(Object.values(KNOWN_MODELS).flat()), "custom"] as const),
  dominant_model_turns: NUMBER_PROPERTY,
  dominant_provider: enumProperty([...KNOWN_PROVIDERS, "custom"] as const),
  error_turns: NUMBER_PROPERTY,
  first_turn_index: NUMBER_PROPERTY,
  input_tokens: NUMBER_PROPERTY,
  invalid_usage_turns: NUMBER_PROPERTY,
  is_final: BOOLEAN_PROPERTY,
  last_turn_index: NUMBER_PROPERTY,
  model_count: NUMBER_PROPERTY,
  output_tokens: NUMBER_PROPERTY,
  raw_turns_sampled: BOOLEAN_PROPERTY,
  reasoning_tokens: NUMBER_PROPERTY,
  sample_rate: NUMBER_PROPERTY,
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

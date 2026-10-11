# OpenCode prompt composition

The engine owns model-specific prompt content. The OpenCode adapter imports
`@code-yeongyu/senpi/prompt-presets`; it never selects a local model body.
The selected `provider/model` string is split at its first slash. A matching
Senpi catalog entry supplies the same display name and preset metadata used
by Native; uncatalogued IDs retain their provider and full remaining ID.

For each supported agent/model pair, generation calls the Native
`resolvePreset` with automatic selection. Models without a preset use
`buildDynamicSystemPrompt`, the Native fallback. The builder receives the
terminal surface, OmO application name and the available tool names. Context is appended by the
OpenCode host rather than discovered by the engine's resource loader.

## The one host transform

`native-model-prompt.ts` owns the only transform. OpenCode's `question` and
`todowrite` capabilities enter the builder under Native's `ask_user_question`
and `todo` names; the generated text translates the question identifier and
backtick-delimited todo tool name back. When the existing task-system mode is
enabled, that identifier instead becomes `task_create` / `task_update` /
`task_list` / `task_get`, matching the role's tracking contract. The Native-only
`waitForAnswer true when the next step depends on the answer` parenthesis is
removed: OpenCode's question tool waits itself and has no such parameter. No
model-family text, whitespace, headings or calibration is normalized.

The transformed core is followed by a JSON model identity containing the
actual provider, full model ID and selected preset, then a model-independent
role append. The core and identity are enclosed in an `omo-model-core` frame
whose JSON metadata stores the configured model, tool names, task-system mode
and optional Hephaestus restriction. The per-request system transform rebuilds just that
frame for the actual runtime model, preserving role and user appends. This
also covers model changes after registration and model overrides applied by
categories. Unframed custom prompts are left alone; malformed frames are not
interpreted. Hephaestus's existing predicate also governs runtime switches.

The append describes the role's scope, available agents,
categories and skills, and the optional task-system interface. User prompt
appends retain their existing host ordering; frame replacement preserves them
byte for byte. The existing registration pipeline can append environment and
skill context outside the model core. Prometheus keeps its single planning-role asset and
the ulw-plan workflow; it now receives the same model core as other agents.

Native has no Sisyphus/Junior/Atlas persona selector. Its explicit custom
system-prompt override replaces the model core; this adapter does not use
that override. Roles are an OpenCode-specific append, not a second source
of model calibration.

Hephaestus retains its existing supported-model predicate and rejection
behavior. Content parity covers the models each agent permits; this change
does not expand model eligibility.

## Verification

The parity matrix compares actual agent factory output with Native-generated
content plus this transform and the independent role append. It enumerates
catalog IDs as production `provider/model` strings and covers the unknown-model
fallback too. Transform tests separately cover tool names, model identifiers,
dynamic role context and user appends. Mutation runs substitute a different
model's body and erase an identifier at the plugin boundary; both must fail.

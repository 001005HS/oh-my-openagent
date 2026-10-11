import {
  buildDynamicSystemPrompt,
  resolvePreset,
  type BuildDynamicSystemPromptOptions,
} from "@code-yeongyu/senpi/prompt-presets"
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all"
import { frameNativePrompt, replaceNativePromptFrames } from "./native-prompt-frame"
import { assertHephaestusSupportedModel } from "./hephaestus/model-support"

const catalog = new Map<string, ReturnType<typeof getBuiltinModels>[number]>(
  getBuiltinProviders().flatMap((provider) =>
    getBuiltinModels(provider).map((model) => [`${provider}/${model.id}`, model] as const),
  ),
)

export function resolveNativePromptModel(model = "") {
  const known = catalog.get(model)
  if (known) return known
  const slash = model.indexOf("/")
  return {
    provider: slash === -1 ? "" : model.slice(0, slash),
    id: slash === -1 ? model : model.slice(slash + 1),
  }
}

export function getNativePromptSource(model?: string): string {
  const identity = resolveNativePromptModel(model)
  return resolvePreset(identity, { promptPreset: "auto" })?.name ?? "default"
}

export function nativePromptOptions(
  selectedTools: readonly string[] = [],
): BuildDynamicSystemPromptOptions {
  return {
    cwd: "",
    selectedTools: selectedTools.map((name) =>
      name === "question" ? "ask_user_question" : name === "todowrite" ? "todo" : name,
    ),
    toolSnippets: {},
    promptGuidelines: [],
    contextFiles: [],
    skills: [],
    surface: "terminal",
    appName: "OmO",
  }
}

/** The sole host transform; model-core prose is otherwise preserved byte for byte. */
export function adaptNativePrompt(prompt: string, useTaskSystem = false): string {
  return prompt
    .replaceAll(/\bask_user_question\b/g, "question")
    .replaceAll(" (waitForAnswer true when the next step depends on the answer)", "")
    .replaceAll("`todo`", useTaskSystem ? "`task_create` / `task_update` / `task_list` / `task_get`" : "`todowrite`")
}

export function buildNativeAgentPrompt(
  model: string | undefined,
  role: string,
  selectedTools: readonly string[] = [],
  restriction?: "hephaestus",
  useTaskSystem = false,
): string {
  if (restriction === "hephaestus") assertHephaestusSupportedModel(model)
  const identity = resolveNativePromptModel(model)
  const options = nativePromptOptions(selectedTools)
  const preset = resolvePreset(identity, { promptPreset: "auto" }, options)
  const core = preset?.prompt ?? buildDynamicSystemPrompt(options)
  const modelIdentity = model
    ? `Model: ${JSON.stringify({ provider: identity.provider, id: identity.id, preset: preset?.name ?? null })}`
    : ""
  const body = [adaptNativePrompt(core, useTaskSystem), modelIdentity].filter(Boolean).join("\n\n")
  const framed = frameNativePrompt(body, {
    model: model ?? "",
    tools: [...selectedTools],
    ...(restriction ? { restriction } : {}),
    ...(useTaskSystem ? { useTaskSystem } : {}),
  })
  return role ? `${framed}\n\n${role}` : framed
}

export function reconcileNativeModelPrompts(system: string[], model: string | undefined): void {
  if (!model) return
  replaceNativePromptFrames(system, model, (context) =>
    buildNativeAgentPrompt(context.model, "", context.tools, context.restriction, context.useTaskSystem),
  )
}

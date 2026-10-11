import { afterEach, describe, expect, test } from "bun:test"
import { createSystemTransformHandler } from "./system-transform"
import { createAtlasAgent } from "../agents/atlas"
import { createHephaestusAgent, UnsupportedHephaestusModelError } from "../agents/hephaestus"
import { createOracleAgent } from "../agents/oracle"
import { createSisyphusAgent } from "../agents/sisyphus"
import { buildSisyphusJuniorPrompt } from "../agents/sisyphus-junior/agent"
import { getPrometheusPrompt } from "../agents/prometheus/system-prompt"
import { clearSisyphusRuntimePromptContext } from "../agents/sisyphus-runtime-prompt-reconciler"

afterEach(clearSisyphusRuntimePromptContext)

describe("per-request Native model prompt selection", () => {
  test.each([
    ["atlas", (model: string) => createAtlasAgent({ model }).prompt ?? ""],
    ["oracle", (model: string) => createOracleAgent(model).prompt ?? ""],
    ["prometheus", (model: string) => getPrometheusPrompt(model)],
  ] as const)("rebuilds %s while preserving user appends and neighboring system text", async (_name, render) => {
    const before = render("anthropic/claude-opus-5-5")
    const output = { system: ["HOST_SENTINEL", before + "\nUSER_APPEND_SENTINEL"] }

    await createSystemTransformHandler()(
      { model: { providerID: "openai", id: "gpt-5.4" } }, output,
    )

    expect(output.system).toEqual([
      "HOST_SENTINEL", render("openai/gpt-5.4") + "\nUSER_APPEND_SENTINEL",
    ])
  })

  test("keeps a provider namespace inside the model ID", async () => {
    const output = { system: [createOracleAgent("anthropic/claude-opus-5-5").prompt ?? ""] }
    await createSystemTransformHandler()(
      { model: { providerID: "synthetic", id: "vendor/gpt-5.4" } }, output,
    )
    expect(output.system).toEqual([createOracleAgent("synthetic/vendor/gpt-5.4").prompt ?? ""])
  })

  test("does not interpret unframed custom system prompts", async () => {
    const output = { system: ["CUSTOM_PROMPT_SENTINEL"] }
    await createSystemTransformHandler()(
      { model: { providerID: "openai", id: "gpt-5.4" } }, output,
    )
    expect(output.system).toEqual(["CUSTOM_PROMPT_SENTINEL"])
  })

  test("retains Hephaestus model eligibility on a runtime switch", async () => {
    const output = { system: [createHephaestusAgent("openai/gpt-5.4").prompt ?? ""] }
    await expect(createSystemTransformHandler()(
      { model: { providerID: "anthropic", id: "claude-opus-5-5" } }, output,
    )).rejects.toThrow(UnsupportedHephaestusModelError)
  })

  test.each([
    ["sisyphus", (model: string) => createSisyphusAgent(model, [], [], [], [], true).prompt ?? ""],
    ["sisyphus-junior", (model: string) => buildSisyphusJuniorPrompt(model, true)],
    ["hephaestus", (model: string) => createHephaestusAgent(model, [], [], [], [], true).prompt ?? ""],
  ] as const)("preserves %s task tracking when the model changes", async (_name, render) => {
    const output = { system: [render("openai/gpt-5.5") + "\nUSER_APPEND_SENTINEL"] }
    await createSystemTransformHandler()(
      { model: { providerID: "openai", id: "gpt-5.6-sol" } }, output,
    )
    expect(output.system).toEqual([render("openai/gpt-5.6-sol") + "\nUSER_APPEND_SENTINEL"])
    expect(output.system[0]).toContain("task_create")
    expect(output.system[0]).not.toContain("todowrite")
  })
})

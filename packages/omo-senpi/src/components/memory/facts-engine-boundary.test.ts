import { expect, onTestFinished, test } from "bun:test"
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@code-yeongyu/senpi"
import { GitMemoryRepo, buildDefaultSeedFiles } from "@oh-my-opencode/memory-core"
import { join } from "node:path"
import { ModelRegistry, ModelRuntime, createAgentSession } from "../../senpi-test-runtime"
import { composeOmoSenpiExtension } from "../../extension/compose"
import { createMemoryBinding } from "./binding"
import { createMemoryIdentityContext } from "./context"
import { FactsExtractorRunner } from "./facts-runner"
import { fixture } from "./facts-runner.test-support"
import { componentContext, memorySettings } from "./memory.test-support"
import { createMemoryWiring } from "./wiring"
import type { MemorySessionStateLike } from "./wiring-types"
import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"

async function engineFixture() {
  const { root, identity, queue } = await fixture()
  const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
  await repo.init({ seedFiles: buildDefaultSeedFiles() })
  const headBefore = await repo.head()
  const requests: Array<{ readonly model: string; readonly extraction: boolean }> = []
  let extractionCalls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json()
      if (typeof body !== "object" || body === null || !("model" in body) || typeof body.model !== "string") {
        return new Response("invalid request", { status: 400 })
      }
      const extraction = "tools" in body && JSON.stringify(body.tools).includes(FACTS_RECORD_TOOL_NAME)
      requests.push({ model: body.model, extraction })
      if (extraction) extractionCalls += 1
      const recordsFact = extraction && extractionCalls === 1
      const delta = recordsFact
        ? { role: "assistant", tool_calls: [{ index: 0, id: "record-fact", type: "function", function: {
          name: FACTS_RECORD_TOOL_NAME,
          arguments: JSON.stringify({ scope: "project", text: "The project uses Bun.", date: "2026-10-11" }),
        } }] }
        : { role: "assistant", content: "Done." }
      const base = { id: "completion-1", object: "chat.completion.chunk", created: 1, model: body.model }
      return new Response([
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: recordsFact ? "tool_calls" : "stop" }] })}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  onTestFinished(() => server.stop(true))
  const registry = new ModelRegistry(ModelRuntime.createSync({ modelsPath: null }))
  registry.registerProvider("openai", {
    api: "openai-completions", baseUrl: `${server.url}v1`, apiKey: "fixture-key",
    models: ["user-chosen", "gpt-6-luna-fast"].map((id) => ({
      id, name: id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000, maxTokens: 4096,
    })),
  })
  const memory = memorySettings({
    facts: { enabled: true, debounce_settles: 1 },
    reflection: { ...memorySettings().reflection, enabled: false },
    dream: { ...memorySettings().dream, enabled: false },
    recall: { ...memorySettings().recall, enabled: false },
  })
  const context = createMemoryIdentityContext({
    identity: identity.id, identityPaths: identity.paths,
    binding: createMemoryBinding({ identity: identity.id, repoPath: identity.paths.repo, boundAt: 1 }),
  })
  const start = async () => {
    const operations: Promise<unknown>[] = []
    const sessions = new Map<string, MemorySessionStateLike>()
    const wiring = createMemoryWiring({
      sessions, cwd: () => root,
      env: { HOME: root, OMO_CODING_AGENT_DIR: join(root, "agent") },
      loadConfig: () => ({ config: { memory }, layers: [], sources: [], diagnostics: [] }),
      createFactsExtractor: (options) => {
        const runner = new FactsExtractorRunner({ ...options, deadlineMs: 10_000 })
        const track = (operation: Promise<unknown>) => { operations.push(operation); return operation }
        return {
          launchPending: (signal, selection) => track(runner.launchPending(signal, selection)),
          reconcilePending: (signal) => track(runner.reconcilePending(signal)),
          cancelActive: () => runner.cancelActive(),
        }
      },
    })
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "always" })
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [composeOmoSenpiExtension([{
        name: "memory",
        register(pi, component) {
          wiring.registerStatic(pi, component)
          pi.on("session_start", async (_event, ctx) => {
            if (typeof ctx !== "object" || ctx === null || !("sessionManager" in ctx)) return
            const manager = ctx.sessionManager
            if (typeof manager !== "object" || manager === null || !("getSessionId" in manager)
              || typeof manager.getSessionId !== "function") return
            const id: unknown = manager.getSessionId()
            if (typeof id !== "string") return
            sessions.set(id, { context })
            await wiring.afterBind(pi, id, context, ctx)
          })
        },
      }], { logger: componentContext().logger })],
    })
    await loader.reload()
    const { session } = await createAgentSession({
      cwd: root, agentDir: join(root, "agent"), modelRegistry: registry,
      model: registry.find("openai", "user-chosen"), thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [],
    })
    await session.bindExtensions({ mode: "print" })
    const drain = async () => { await Promise.all(operations.splice(0)) }
    const close = async () => {
      await wiring.onSessionShutdown({ reason: "reload", sessionId: session.sessionId, deadlineAt: Date.now() + 10_000 })
      await drain()
      session.dispose()
    }
    onTestFinished(close)
    await drain()
    return { session, drain, close }
  }
  return { start, requests, queue, repo, headBefore }
}

test("#given pending facts #when the real engine launches and relaunches without a prompt #then no HTTP model request occurs", async () => {
  const f = await engineFixture()
  const first = await f.start()
  await first.close()
  await f.start()
  expect(f.requests).toEqual([])
  expect(await f.queue.listPending()).toHaveLength(1)
}, 30_000)

test("#given pending facts and a user-selected model #when the real engine accepts and finishes a prompt #then extraction works on that model", async () => {
  const f = await engineFixture()
  const run = await f.start()
  await run.session.prompt("The project uses Bun.", { source: "rpc" })
  await run.session.waitForIdle()
  await run.drain()
  expect(f.requests.filter((request) => request.extraction).length).toBeGreaterThan(0)
  expect(new Set(f.requests.map((request) => request.model))).toEqual(new Set(["user-chosen"]))
  expect(await f.queue.listPending()).toHaveLength(0)
  expect(await f.repo.head()).not.toBe(f.headBefore)
}, 30_000)

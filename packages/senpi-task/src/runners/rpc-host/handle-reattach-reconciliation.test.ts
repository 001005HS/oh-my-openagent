import { afterEach, describe, expect, test } from "bun:test"
import { childSpec, hostRunnerHarness } from "../rpc-host.test-support"
import { isHostSessionHandle } from "../rpc-host"
import { cleanupProjects, tempProject } from "../../manager/__fixtures__/manager-fakes"

const harness = hostRunnerHarness()
afterEach(async () => { await harness.release(); cleanupProjects() })

describe("host recovery adopts a turn finished during the transport gap", () => {
  test("the real host runner completes with the transcript answer and one prompt total", async () => {
    // Subscribe to the reattach attempt; the gate makes the transport gap deterministic.
    const recovering = Promise.withResolvers<void>()
    const reopen = Promise.withResolvers<void>()
    const host = await harness.fakeHost({ transcripts: true })
    const runner = harness.runnerOver(host, {
      reattachDelaysMs: [0],
      sleep: () => { recovering.resolve(); return reopen.promise },
    })
    const handle = await runner.start(childSpec({ state_dir: tempProject() }))
    if (!isHostSessionHandle(handle)) throw new Error("expected host session")
    const outcome = handle.waitForOutcome()
    host.cutConnections()
    await recovering.promise
    host.completeTurn(handle.hostSession.routingId, "REAL FINAL ANSWER")
    reopen.resolve()
    expect(await outcome).toEqual({ status: "completed", finalResponse: "REAL FINAL ANSWER" })
    expect(handle.lastAssistantText()).toBe("REAL FINAL ANSWER")
    expect(host.commands.filter((command) => command.type === "prompt")).toHaveLength(1)
    await handle.dispose()
  })
})

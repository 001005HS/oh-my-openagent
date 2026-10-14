import { describe, expect, test } from "bun:test"

import type { RunnerOutcome } from "../in-process/child-handle"
import { createTurnSettlement, type TurnSettlementProbe } from "./turn-settlement"

const PROVIDER_TIMEOUT = "Provider stream start timed out after 300000ms"

function agentEnd(errorMessage: string): unknown {
  return {
    type: "agent_end",
    willRetry: false,
    messages: [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
      },
    ],
  }
}

function idleState(): TurnSettlementProbe {
  return { isStreaming: false, steering: [], followUp: [], pendingMessageCount: 0 }
}

function deferredProbe(state: TurnSettlementProbe = idleState()): {
  readonly probe: () => Promise<TurnSettlementProbe>
  readonly calls: () => number
} {
  let calls = 0
  return {
    calls: () => calls,
    probe: () => {
      calls += 1
      return Promise.resolve(state)
    },
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("createTurnSettlement terminal provider error (senpi#3262)", () => {
  test("#given a terminal provider error whose idle event never arrives and no wake source lives #when the settle confirmation elapses #then the outcome settles failed with the provider's own text", async () => {
    // given
    const settled = deferred<RunnerOutcome>()
    const state = deferredProbe()
    const settlement = createTurnSettlement({
      settle: settled.resolve,
      abortedByUser: () => false,
      baseline: () => undefined,
      finalText: () => undefined,
      probe: state.probe,
      settleConfirmMs: 5,
      wakeSourcesLive: () => false,
    })

    // when - the turn ends terminally and the session never emits agent_idle
    settlement.observe(agentEnd(PROVIDER_TIMEOUT) as never)

    // then - the held error outcome settles through the confirmation probe, with the provider text
    const outcome = await settled.promise
    expect(state.calls()).toBeGreaterThan(0)
    expect(outcome).toEqual({
      status: "error",
      failure: { kind: "child-turn-failed", message: PROVIDER_TIMEOUT },
    })
  })

  test("#given a terminal provider error while a goal continuation timer is armed #when the confirmation elapses #then the held outcome never settles and a later agent_start clears it", async () => {
    // given
    let settled: RunnerOutcome | undefined
    const state = deferredProbe()
    let wakeLive = true
    const settlement = createTurnSettlement({
      settle: (outcome) => {
        settled = outcome
      },
      abortedByUser: () => false,
      baseline: () => undefined,
      finalText: () => undefined,
      probe: state.probe,
      settleConfirmMs: 5,
      wakeSourcesLive: () => wakeLive,
    })

    // when - the turn ends terminally; its wake tracker says a goal owns the recovery
    settlement.observe(agentEnd(PROVIDER_TIMEOUT) as never)

    // then - the held outcome is NOT settled: the session-scoped lifecycle keeps its wake
    await Bun.sleep(30)
    expect(settled).toBeUndefined()

    // when - the goal continuation actually starts a new turn
    wakeLive = false
    settlement.observe({ type: "agent_start" } as never)

    // then - the held outcome is dropped for the new turn
    await Bun.sleep(30)
    expect(settled).toBeUndefined()
  })

  test("#given a terminal provider error whose probe reports an active turn #when it later reports true idleness #then only the idle answer settles the held outcome", async () => {
    // given
    const settled = deferred<RunnerOutcome>()
    let idle = false
    const settlement = createTurnSettlement({
      settle: settled.resolve,
      abortedByUser: () => false,
      baseline: () => undefined,
      finalText: () => undefined,
      probe: () =>
        Promise.resolve(
          idle ? idleState() : { isStreaming: true, steering: [], followUp: [], pendingMessageCount: 0 },
        ),
      settleConfirmMs: 5,
      wakeSourcesLive: () => false,
    })

    // when
    settlement.observe(agentEnd(PROVIDER_TIMEOUT) as never)
    await Bun.sleep(30)
    idle = true

    // then - the first (busy) probe settled nothing; the idle one did
    const outcome = await settled.promise
    expect(outcome.status).toBe("error")
  })

  test("#given the regular path #when agent_idle arrives after a terminal agent_end #then the outcome settles immediately without probing", async () => {
    // given
    const settled = deferred<RunnerOutcome>()
    const state = deferredProbe()
    const settlement = createTurnSettlement({
      settle: settled.resolve,
      abortedByUser: () => false,
      baseline: () => undefined,
      finalText: () => undefined,
      probe: state.probe,
      settleConfirmMs: 60_000,
      wakeSourcesLive: () => false,
    })

    // when
    settlement.observe(agentEnd(PROVIDER_TIMEOUT) as never)
    settlement.observe({ type: "agent_idle" } as never)

    // then - idle is the one true signal: no confirmation timer ever armed
    const outcome = await settled.promise
    expect(state.calls()).toBe(0)
    expect(outcome).toEqual({
      status: "error",
      failure: { kind: "child-turn-failed", message: PROVIDER_TIMEOUT },
    })
  })

  test("#given a probe that rejects #when the settle confirmation runs #then the held outcome still settles failed (the error text is already known)", async () => {
    // given
    const settled = deferred<RunnerOutcome>()
    const settlement = createTurnSettlement({
      settle: settled.resolve,
      abortedByUser: () => false,
      baseline: () => undefined,
      finalText: () => undefined,
      probe: () => Promise.reject(new Error("get_state refused")),
      settleConfirmMs: 5,
      wakeSourcesLive: () => false,
    })

    // when
    settlement.observe(agentEnd(PROVIDER_TIMEOUT) as never)

    // then
    const outcome = await settled.promise
    expect(outcome).toEqual({
      status: "error",
      failure: { kind: "child-turn-failed", message: PROVIDER_TIMEOUT },
    })
  })
})

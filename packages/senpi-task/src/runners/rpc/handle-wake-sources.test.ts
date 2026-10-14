import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { AgentSessionEvent, RpcResponse } from "@code-yeongyu/senpi"
import { describe, expect, test } from "bun:test"

import type { RunnerOutcome } from "../in-process/child-handle"
import type { RpcChildHandle } from "../types"
import { createRpcChildHandle } from "./handle"
import type { RpcProtocolClient } from "./protocol-client"
import { createChildExtensionEvents } from "../child-extension-events"

const PROVIDER_TIMEOUT = "Provider stream start timed out after 300000ms"

type OutcomeTrackedHandle = RpcChildHandle & {
  waitForOutcome(): Promise<RunnerOutcome>
  dispose(): Promise<void>
}

const IDLE_STATE = {
  sessionId: "s-1",
  isStreaming: false,
  steering: [],
  followUp: [],
  pendingMessageCount: 0,
}

/**
 * The handle's settle confirmation rides the SAME raw record stream the child emits: goal
 * continuation timer records reach it as `extension_event` frames (senpi#3208 publishes them
 * through `pi.rpc.emit`), never through the permission-shaped extension channel. This suite
 * proves that ingestion at the real seam (senpi#3262).
 */
function createHarness(settleConfirmMs: number): {
  readonly handle: OutcomeTrackedHandle
  readonly emit: (record: unknown) => void
} {
  const child = Object.assign(new EventEmitter(), { pid: 4242 }) as unknown as ChildProcess
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const client = {
    extensionEvents: createChildExtensionEvents(),
    stderrTail: "",
    send: (command: { readonly type?: string }) =>
      Promise.resolve(
        command.type === "get_state"
          ? ({ success: true, command: "get_state", data: IDLE_STATE } as unknown as RpcResponse)
          : ({ success: true } as unknown as RpcResponse),
      ),
    onEvent: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    detach: () => listeners.clear(),
  } as unknown as RpcProtocolClient
  const handle = createRpcChildHandle({
    client,
    child,
    taskId: "st_00000002",
    heartbeatIntervalMs: settleConfirmMs,
    now: () => 1,
  }) as OutcomeTrackedHandle
  return {
    handle,
    emit: (record) => {
      for (const listener of listeners) listener(record as AgentSessionEvent)
    },
  }
}

function terminalProviderErrorTurn(): readonly unknown[] {
  const assistant = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: PROVIDER_TIMEOUT,
  }
  return [
    { type: "message_end", message: assistant },
    { type: "agent_end", willRetry: false, messages: [assistant] },
  ]
}

function goalTimer(armed: boolean, kind: string): unknown {
  return { type: "extension_event", name: "goal_continuation_timer_state", data: { armed, kind } }
}

describe("createRpcChildHandle goal wake-source tracking (senpi#3262)", () => {
  test("#given an armed providerRetry timer over the raw event stream #when the turn ends on a terminal provider error #then the outcome stays pending while the timer holds", async () => {
    // given
    const harness = createHarness(5)
    let settled: RunnerOutcome | undefined
    void harness.handle.waitForOutcome().then((outcome) => {
      settled = outcome
    })
    harness.emit(goalTimer(true, "providerRetry"))

    // when - the turn ends on the stream-start timeout and never emits agent_idle
    for (const record of terminalProviderErrorTurn()) harness.emit(record)
    await Bun.sleep(40)

    // then - the goal's provider-outage wait keeps the task running: nothing settles
    expect(settled).toBeUndefined()
    await harness.handle.dispose()
  })

  test("#given the providerRetry timer disarms after the turn ended #when the confirmation re-fires #then the outcome settles failed with the provider text", async () => {
    // given - the same held error as above, then the goal's retry timer goes off
    const harness = createHarness(5)
    harness.emit(goalTimer(true, "providerRetry"))
    for (const record of terminalProviderErrorTurn()) harness.emit(record)
    await Bun.sleep(40)

    // when
    harness.emit(goalTimer(false, "providerRetry"))

    // then
    const outcome = await harness.handle.waitForOutcome()
    expect(outcome).toEqual({
      status: "error",
      failure: { kind: "child-turn-failed", message: PROVIDER_TIMEOUT },
    })
    await harness.handle.dispose()
  })
})

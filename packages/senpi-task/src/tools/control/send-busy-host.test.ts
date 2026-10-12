import { describe, expect, test } from "bun:test"

import type { SendOutcome } from "../../steering"
import { bounded } from "../../lifecycle/__fixtures__/live-parent-clock"
import { runTaskSend } from "./send"
import type { SendManager, SendToolResult } from "./types"

function busyManager(): { manager: SendManager; settle: (outcome: SendOutcome) => void; calls: () => number } {
  const pending = Promise.withResolvers<SendOutcome>()
  let calls = 0
  return {
    manager: {
      sendToTask: () => {
        calls += 1
        return pending.promise
      },
      list: () => [],
    },
    settle: pending.resolve,
    calls: () => calls,
  }
}

function lateOutcomes(): { deliver: (result: SendToolResult) => void; next: Promise<SendToolResult> } {
  const arrived = Promise.withResolvers<SendToolResult>()
  return { deliver: arrived.resolve, next: arrived.promise }
}

describe("task_send against a busy task host (#10042)", () => {
  test("#given a send the host does not answer #when task_send runs #then it returns delivering and the outcome arrives later", async () => {
    // given
    const busy = busyManager()
    const late = lateOutcomes()

    // when
    const result = await bounded(runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
      deliverLateOutcome: late.deliver,
    }))
    busy.settle({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })

    // then
    expect(result.details).toMatchObject({ kind: "delivering", to: "st_00000001", reason: "host_slow" })
    expect((await bounded(late.next)).details).toEqual({ kind: "revived", task_id: "st_00000001", run_epoch: 2 })
  })

  test("#given a send still in flight #when the parent turn aborts #then task_send returns at once and the outcome still arrives", async () => {
    // given
    const busy = busyManager()
    const late = lateOutcomes()
    const controller = new AbortController()
    const running = runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
      signal: controller.signal,
      deliverLateOutcome: late.deliver,
    })

    // when
    controller.abort(new Error("parent aborted"))
    const result = await bounded(running)
    busy.settle({ kind: "not_continuable", task_id: "st_00000001", reason: "session_unavailable", suggestion: "read it" })

    // then
    expect(result.details).toMatchObject({ kind: "delivering", reason: "aborted" })
    expect((await bounded(late.next)).details).toMatchObject({ kind: "not_continuable", reason: "session_unavailable" })
  })

  test("#given a parent turn already aborted #when task_send runs #then nothing is sent", async () => {
    const busy = busyManager()
    const controller = new AbortController()
    controller.abort(new Error("parent aborted"))

    const result = await bounded(runTaskSend(busy.manager, { to: "st_00000001", message: "hi" }, "parent-1", undefined, {
      signal: controller.signal,
    }))

    expect(busy.calls()).toBe(0)
    expect(result.details).toMatchObject({ kind: "aborted" })
  })
})

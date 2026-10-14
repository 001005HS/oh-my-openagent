import { afterEach, describe, expect, test } from "bun:test"

import type { AwaitingInputReason } from "../state"
import { cleanupProjects, baseSpec, makeManager, tempProject } from "./__fixtures__/manager-fakes"

// senpi#3266: the one-step actions from "resumed, waiting for input" - cancel (task_cancel) or
// re-dispatch the task onto a fresh live session, replaying its persisted prompt.

afterEach(cleanupProjects)

type RedispatchCapable = {
  redispatchTask?: (idOrName: string, callerSessionId?: string) => Promise<RedispatchOutcome>
}

type RedispatchOutcome = {
  readonly kind: string
  readonly run_epoch?: number
  readonly reason?: string
  readonly owning_session_id?: string
}

function redispatcher(manager: unknown): { redispatchTask: (idOrName: string, callerSessionId?: string) => Promise<RedispatchOutcome> } {
  return manager as { redispatchTask: (idOrName: string, callerSessionId?: string) => Promise<RedispatchOutcome> }
}

async function flaggedTask(options: { readonly reason?: AwaitingInputReason } = {}) {
  const harness = makeManager({ project: tempProject() })
  const started = await harness.manager.start(baseSpec({ prompt: "build the report" }))
  if (started.kind !== "started") throw new Error(`expected started, got ${started.kind}`)
  harness.store.mutate(started.task_id, (record) => ({
    ...record,
    awaiting_input: { reason: options.reason ?? "resumed_turn_aborted", since: new Date().toISOString() },
  }))
  return { ...harness, taskId: started.task_id }
}

describe("TaskManager.redispatchTask (senpi#3266)", () => {
  test("#given a flagged task #when it is re-dispatched #then a fresh child launches from the persisted prompt and the flag clears", async () => {
    // given
    const { manager, store, inProcess, taskId } = await flaggedTask()
    const before = store.load(taskId)?.notification.run_epoch

    // when
    expect(typeof (manager as RedispatchCapable).redispatchTask).toBe("function")
    const outcome = await redispatcher(manager).redispatchTask(taskId, "parent-1")

    // then - one step: dead session abandoned, task running on a live one, same identity
    expect(outcome.kind).toBe("redispatched")
    const record = store.load(taskId)
    expect(record?.status).toBe("running")
    expect(record?.awaiting_input).toBeUndefined()
    expect(outcome.run_epoch).toBeGreaterThan(before ?? -1)
    expect(inProcess.startedSpecs.map((spec) => spec.prompt)).toEqual(["build the report", "build the report"])
  })

  test("#given a flagged task with a live handle #when it is re-dispatched #then the old handle is released before the fresh one attaches", async () => {
    // given
    const { manager, inProcess, taskId } = await flaggedTask()
    const oldFake = inProcess.handles.get(taskId)

    // when
    const outcome = await redispatcher(manager).redispatchTask(taskId, "parent-1")

    // then - exactly one live child: the old subscription is gone, the new one is resident
    expect(outcome.kind).toBe("redispatched")
    expect(oldFake?.unsubscribeCount() ?? 0).toBeGreaterThan(0)
    expect(manager.residentTaskIds().filter((id) => id === taskId)).toHaveLength(1)
  })

  test("#given a task that is not waiting for input #when re-dispatch is attempted #then it is refused as invalid_state", async () => {
    // given
    const { manager } = await flaggedTask()
    const plain = await manager.start(baseSpec({ prompt: "other work" }))
    if (plain.kind !== "started") throw new Error("expected started")

    // when
    const outcome = await redispatcher(manager).redispatchTask(plain.task_id, "parent-1")

    // then
    expect(outcome.kind).toBe("invalid_state")
  })

  test("#given a flagged task owned by another session #when re-dispatch is attempted without scope #then it is scope_denied", async () => {
    // given
    const { manager, taskId } = await flaggedTask()

    // when
    const outcome = await redispatcher(manager).redispatchTask(taskId, "some-other-session")

    // then
    expect(outcome.kind).toBe("scope_denied")
  })

  test("#given an unknown task #when re-dispatch is attempted #then it is not_found", async () => {
    // given
    const { manager } = await flaggedTask()

    // when
    const outcome = await redispatcher(manager).redispatchTask("st_00000000", "parent-1")

    // then
    expect(outcome.kind).toBe("not_found")
  })

  test("#given a flagged task #when it is cancelled instead #then cancel works in one step (task_cancel)", async () => {
    // given
    const { manager, store, taskId } = await flaggedTask()

    // when
    const outcome = await manager.cancelTask(taskId)

    // then
    expect(outcome.kind).toBe("cancelled")
    expect(store.load(taskId)?.status).toBe("cancelled")
  })
})

import { afterEach, describe, expect, spyOn, test } from "bun:test"

import type { ManagedChildHandle } from "./child-handle"
import type { ManagedStartSpec } from "./types"
import { RunnerError } from "../runners/in-process/runner-error"
import { bounded } from "../lifecycle/__fixtures__/live-parent-clock"
import { FakeRunner, baseSpec, cleanupProjects, makeManager, settings } from "./__fixtures__/manager-fakes"

afterEach(cleanupProjects)

class BusyHostRunner extends FakeRunner {
  readonly release = Promise.withResolvers<unknown>()
  readonly admitted = Promise.withResolvers<string>()

  override start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    return this.release.promise.then(async (refusal) => {
      if (refusal !== undefined) throw refusal
      const handle = await super.start(spec)
      this.admitted.resolve(spec.taskId)
      return handle
    })
  }
}

// The first start is admitted at once and holds the only lane; every later start waits on the host.
class LaneThenBusyRunner extends FakeRunner {
  readonly release = Promise.withResolvers<void>()
  readonly heldStart = Promise.withResolvers<string>()
  #starts = 0

  override start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    this.#starts += 1
    if (this.#starts === 1) return super.start(spec)
    this.heldStart.resolve(spec.taskId)
    return this.release.promise.then(() => super.start(spec))
  }
}

const oneLane = () => settings({ default_concurrency: 1, global_concurrency: 0 })

const hostBusy = () => new RunnerError({
  kind: "host_unavailable",
  reason: "host_busy",
  message: "the task host accepts connections but its event loop is not answering",
})

describe("task start against a busy host (#10042)", () => {
  for (const runInBackground of [true, false]) {
    test(`#given a host that does not answer #when a ${runInBackground ? "background" : "foreground"} task starts #then start returns a starting task instead of waiting for the host`, async () => {
      // given
      const held = new BusyHostRunner()
      const h = makeManager({ inProcess: held })

      // when
      const started = await bounded(h.manager.start(baseSpec({ run_in_background: runInBackground })))

      // then
      if (started.kind !== "started") throw new Error(`expected started, got ${started.kind}`)
      expect(started.starting).toBe(true)
      expect(h.store.load(started.task_id)?.status).toBe("running")
      held.release.resolve(undefined)
    })
  }

  test("#given a start still waiting on the host #when the host refuses it #then the record fails with the host's reason and waiters settle", async () => {
    // given
    const held = new BusyHostRunner()
    const h = makeManager({ inProcess: held, config: oneLane() })
    const started = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    if (started.kind !== "started") throw new Error("fixture did not start")
    const failed = Promise.withResolvers<void>()
    const append = h.store.appendEvent.bind(h.store)
    spyOn(h.store, "appendEvent").mockImplementation((id, event) => {
      const result = append(id, event)
      if (id === started.task_id && event.type === "task_start_failed") failed.resolve()
      return result
    })
    const waited = h.manager.waitFor(started.task_id)

    // when
    held.release.resolve(hostBusy())
    await bounded(failed.promise)

    // then
    const record = await bounded(waited)
    expect(record.status).toBe("error")
    expect(record.failure_kind).toBe("host_unavailable")
    // The same host refuses the next start too: reaching the runner at all (not a queue) proves the
    // failed start gave its lane slot back.
    const next = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    expect(next.kind).toBe("start_failed")
  })

  test("#given a start still waiting on the host #when the host admits it late #then the child runs and completes normally", async () => {
    // given
    const held = new BusyHostRunner()
    const h = makeManager({ inProcess: held })
    const started = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    if (started.kind !== "started") throw new Error("fixture did not start")
    const waited = h.manager.waitFor(started.task_id)

    // when
    held.release.resolve(undefined)
    await bounded(held.admitted.promise)
    const handle = held.handles.get(started.task_id)
    if (handle === undefined) throw new Error("admitted child has no handle")
    await bounded(handle.waitForSubscription())
    handle.settle({ status: "completed", finalResponse: "DONE" })

    // then
    const record = await bounded(waited)
    expect(record.status).toBe("completed")
    expect(record.final_response).toBe("DONE")
  })

  test("#given a start still waiting on the host #when the parent cancels it (a foreground abort) #then a late admission is discarded and the lane slot is free", async () => {
    // given
    const held = new BusyHostRunner()
    const h = makeManager({ inProcess: held, config: oneLane() })
    const started = await bounded(h.manager.start(baseSpec({ run_in_background: false })))
    if (started.kind !== "started") throw new Error("fixture did not start")

    // when
    const cancelled = await h.manager.cancelTask(started.task_id, "parent turn aborted")
    held.release.resolve(undefined)
    await bounded(held.admitted.promise)
    const next = await bounded(h.manager.start(baseSpec({ run_in_background: true })))

    // then
    expect(cancelled.kind).toBe("cancelled")
    expect(h.store.load(started.task_id)?.status).toBe("cancelled")
    expect(held.handles.get(started.task_id)?.subscribeCount()).toBe(0)
    if (next.kind !== "started") throw new Error("second start did not start")
    expect(next.queue_position).toBeUndefined()
  })

  test("#given a start still waiting on the host #when the caller awaits whenLaunched #then it settles only once the child is admitted and resident", async () => {
    // given
    const held = new BusyHostRunner()
    const h = makeManager({ inProcess: held })
    const started = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    if (started.kind !== "started") throw new Error("fixture did not start")
    expect(started.starting).toBe(true)
    const whenLaunched = h.manager.whenLaunched?.bind(h.manager)
    if (whenLaunched === undefined) throw new Error("the manager exposes no whenLaunched")
    let launched = false
    const settled = whenLaunched(started.task_id).then(() => { launched = true })

    // when
    held.release.resolve(undefined)
    await bounded(settled)

    // then
    expect(launched).toBe(true)
    expect(h.manager.getResidentHandle(started.task_id)).toBeDefined()
  })

  test("#given a start still waiting on the host #when the parent steers it #then the message is queued and delivered once the child is admitted", async () => {
    // given
    const held = new BusyHostRunner()
    const h = makeManager({ inProcess: held })
    const started = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    if (started.kind !== "started") throw new Error("fixture did not start")
    expect(started.starting).toBe(true)
    const delivered = Promise.withResolvers<void>()
    const append = h.store.appendEvent.bind(h.store)
    spyOn(h.store, "appendEvent").mockImplementation((id, event) => {
      const result = append(id, event)
      if (id === started.task_id && event.type === "steered") delivered.resolve()
      return result
    })

    // when
    const sent = await bounded(h.manager.sendToTask({ idOrName: started.task_id, message: "steer while starting", deliverAs: "steer" }))
    expect(sent.kind).toBe("queued")
    held.release.resolve(undefined)
    await bounded(delivered.promise)

    // then
    const handle = held.handles.get(started.task_id)
    if (handle === undefined) throw new Error("admitted child has no handle")
    expect(handle.steerCalls).toEqual(["steer while starting"])
    expect(handle.followUpCalls).toEqual([])
  })

  test("#given a task that waited for a lane and is now waiting on the host #when the parent steers it #then the message is queued and delivered once the child is admitted", async () => {
    // given
    const runner = new LaneThenBusyRunner()
    const h = makeManager({ inProcess: runner, config: oneLane() })
    const first = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    if (first.kind !== "started") throw new Error("first task did not start")
    const second = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    if (second.kind !== "started") throw new Error("second task did not start")
    expect(second.queue_position).toBeDefined()
    const firstHandle = runner.handles.get(first.task_id)
    if (firstHandle === undefined) throw new Error("first child has no handle")
    await bounded(firstHandle.waitForSubscription())
    const delivered = Promise.withResolvers<void>()
    const append = h.store.appendEvent.bind(h.store)
    spyOn(h.store, "appendEvent").mockImplementation((id, event) => {
      const result = append(id, event)
      if (id === second.task_id && event.type === "steered") delivered.resolve()
      return result
    })
    firstHandle.settle({ status: "completed", finalResponse: "DONE" })
    await bounded(runner.heldStart.promise)

    // when
    const sent = await bounded(h.manager.sendToTask({ idOrName: second.task_id, message: "steer while starting", deliverAs: "steer" }))
    expect(sent.kind).toBe("queued")
    runner.release.resolve()
    await bounded(delivered.promise)

    // then
    const handle = runner.handles.get(second.task_id)
    if (handle === undefined) throw new Error("admitted child has no handle")
    expect(handle.steerCalls).toEqual(["steer while starting"])
    expect(handle.followUpCalls).toEqual([])
  })

  test("#given a host that answers at once #when a task starts #then the result is reported as before, not as starting", async () => {
    const h = makeManager()
    const started = await bounded(h.manager.start(baseSpec({ run_in_background: true })))
    if (started.kind !== "started") throw new Error("fixture did not start")
    expect(started.starting).toBeUndefined()
    expect(started.status).toBe("running")
  })
})

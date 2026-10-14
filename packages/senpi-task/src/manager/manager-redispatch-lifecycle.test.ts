import { afterEach, describe, expect, test } from "bun:test"

import { createManagerResidencyRegistry } from "../../../omo-senpi/src/components/task/residency-registry"
import { createTaskLifecycle } from "../lifecycle/create"
import { NO_HOST_ENDPOINT } from "../lifecycle/host-session"
import { createTaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"
import { baseSpec, cleanupProjects, FakeRunner, settings, tempProject } from "./__fixtures__/manager-fakes"
import { createTaskManager } from "./manager"
import type { ManagedStartSpec } from "./types"

// senpi#3266 review: re-dispatch must work with the REAL destruction port, wired exactly as
// omo-senpi's engine wires it (components/task/engine.ts). A mock that skips teardown hid that the
// port's residency `dispose` left the record un-reattachable.

afterEach(cleanupProjects)

const OWNER_PID = 21_001

class CountingRunner extends FakeRunner {
  readonly disposed = new Map<ManagedChildHandle, number>()
  readonly aborted = new Map<ManagedChildHandle, number>()

  override async start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    const handle = await super.start(spec)
    const counted: ManagedChildHandle = Object.assign(handle, {
      dispose: async () => {
        this.disposed.set(counted, (this.disposed.get(counted) ?? 0) + 1)
      },
      abort: async () => {
        this.aborted.set(counted, (this.aborted.get(counted) ?? 0) + 1)
      },
    })
    return counted
  }
}

function productionLane() {
  const runner = new CountingRunner()
  const store = createTaskRecordStore({ project_dir: tempProject() })
  const config = settings({ default_concurrency: 5, max_depth: 1 })
  const manager = createTaskManager({
    store,
    config,
    cwd: "/tmp",
    hostPid: OWNER_PID,
    runners: { "in-process": runner, process: runner },
    planner: () => ({ kind: "resolved", plan: { model: "anthropic/claude" } }),
    destruction: {
      destroyResidentTask: (taskId, cause) => lifecycle.destroyResidentTask(taskId, cause),
      parkTerminalResident: (taskId) => lifecycle.parkTerminalResident(taskId),
    },
  })
  const lifecycle = createTaskLifecycle({ hostEndpoint: NO_HOST_ENDPOINT, store, config, hostPid: OWNER_PID, registry: createManagerResidencyRegistry(() => manager) })
  const dispose = (): void => {
    lifecycle.dispose?.()
    manager.workpools.dispose()
    for (const taskId of manager.residentTaskIds()) manager.forget(taskId, { path: "end" })
  }
  return { runner, store, manager, dispose }
}

describe("TaskManager.redispatchTask with the real destruction port (senpi#3266)", () => {
  test("#given a flagged resident task #when it is re-dispatched #then a fresh child is attached, the record stays resident and running, and the old child is torn down", async () => {
    // given
    const lane = productionLane()
    try {
      const started = await lane.manager.start(baseSpec({ prompt: "build the report" }))
      if (started.kind !== "started") throw new Error(`expected started, got ${started.kind}`)
      const taskId = started.task_id
      lane.store.mutate(taskId, (record) => ({ ...record, awaiting_input: { reason: "resumed_turn_aborted", since: new Date().toISOString() } }))
      const oldHandle = lane.manager.getResidentHandle(taskId)
      if (oldHandle === undefined) throw new Error("expected a live handle")
      const before = lane.store.load(taskId)?.notification.run_epoch ?? -1

      // when
      const outcome = await lane.manager.redispatchTask(taskId, "parent-1")

      // then
      expect(outcome).toMatchObject({ kind: "redispatched", task_id: taskId })
      const record = lane.store.load(taskId)
      expect(record?.status).toBe("running")
      expect(record?.residency_state).toBe("resident")
      expect(record?.host_pid).toBe(OWNER_PID)
      expect(record?.awaiting_input).toBeUndefined()
      expect(record?.notification.run_epoch ?? -1).toBeGreaterThan(before)
      const freshHandle = lane.manager.getResidentHandle(taskId)
      expect(freshHandle).toBeDefined()
      expect(freshHandle).not.toBe(oldHandle)
      expect(lane.runner.disposed.get(oldHandle) ?? 0).toBe(1)
      expect(lane.runner.aborted.get(oldHandle) ?? 0).toBe(1)
      expect(lane.runner.startedSpecs.map((spec) => spec.prompt)).toEqual(["build the report", "build the report"])
    } finally {
      lane.dispose()
    }
  })
})

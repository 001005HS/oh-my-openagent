import { describe, expect, test } from "bun:test"

import { createTurnWakeSources } from "./turn-wake-sources"

function extensionEvent(name: string, data: unknown): unknown {
  return { type: "extension_event", name, data }
}

describe("createTurnWakeSources (senpi#3262)", () => {
  test("#given a goal continuation armed #when the timer reports armed #then the wake tracker is live and stays live until it disarms", () => {
    // given
    const tracker = createTurnWakeSources()

    // when - the goal builtin reports an armed continuation timer (its providerRecovery path)
    tracker.observe(extensionEvent("goal_continuation_timer_state", { armed: true, kind: "providerRecovery" }))

    // then
    expect(tracker.hasLiveWakeSources()).toBe(true)

    // when - the timer fires or is cancelled
    tracker.observe(extensionEvent("goal_continuation_timer_state", { armed: false, kind: "providerRecovery" }))

    // then
    expect(tracker.hasLiveWakeSources()).toBe(false)
  })

  test("#given a terminal monitor watch registered #when its state rides the wire #then the tracker tracks it until every watch ends", () => {
    // given
    const tracker = createTurnWakeSources()

    // when - a monitor snapshot with one live watch
    tracker.observe(
      extensionEvent("terminal_monitor_state", {
        activeCount: 1,
        monitors: [{ id: "w1", description: "watch the build", startedAtMs: 1 }],
      }),
    )

    // then
    expect(tracker.hasLiveWakeSources()).toBe(true)

    // when - the watch's snapshot goes quiet
    tracker.observe(extensionEvent("terminal_monitor_state", { activeCount: 0, monitors: [] }))

    // then
    expect(tracker.hasLiveWakeSources()).toBe(false)
  })

  test("#given a non-lifecycle extension event #when observed #then the tracker ignores it", () => {
    // given
    const tracker = createTurnWakeSources()

    // when - a permission prompt and an unrelated record
    tracker.observe(extensionEvent("computer.permission_required", { type: "computer.permission_required", permission: "screen_recording" }))
    tracker.observe({ type: "agent_end", willRetry: false })

    // then
    expect(tracker.hasLiveWakeSources()).toBe(false)
  })

  test("#given a live tracker #when reset for a new turn #then prior wake sources are cleared", () => {
    // given
    const tracker = createTurnWakeSources()
    tracker.observe(extensionEvent("goal_continuation_timer_state", { armed: true, kind: "providerRecovery" }))
    expect(tracker.hasLiveWakeSources()).toBe(true)

    // when
    tracker.reset()

    // then
    expect(tracker.hasLiveWakeSources()).toBe(false)
  })
})

import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { cleanupProjects, tempProject } from "../../manager/__fixtures__/manager-fakes"
import type { RunnerOutcome } from "../in-process/child-handle"
import { reconcileHostTurn, type InputEffectStatus, type ReconciledTurnNotice } from "./reconcile-turn"

afterEach(cleanupProjects)

function scenario(options: {
  readonly streaming?: boolean
  readonly receipt?: InputEffectStatus
  readonly aborted?: boolean
  readonly deadline?: boolean
} = {}) {
  const path = join(tempProject(), "session.jsonl")
  writeFileSync(path, [
    { type: "message", id: "user-1", message: { role: "user", content: "work" } },
    { type: "message", id: "answer-1", message: { role: "assistant", stopReason: options.aborted ? "aborted" : "stop", content: [{ type: "text", text: "ANSWER" }] } },
    ...(options.deadline ? [{ type: "agent_end", aborted: true, abortSource: "system", deadline: { kind: "inactivity" } }] : []),
  ].map((row) => JSON.stringify(row)).join("\n"))
  const outcomes: RunnerOutcome[] = []
  const notices: ReconciledTurnNotice[] = []
  const port = {
    getState: async () => ({ sessionId: "session", isStreaming: options.streaming === true }),
    ...(options.receipt === undefined ? {} : { lastInputEffect: options.receipt }),
    settle: (outcome: RunnerOutcome) => { outcomes.push(outcome) },
    notify: (notice: ReconciledTurnNotice) => { notices.push(notice) },
  }
  return { path, port, outcomes, notices }
}

describe("host turn reconciliation authority", () => {
  test("streaming execution outranks a completed receipt and final transcript", async () => {
    const f = scenario({ streaming: true, receipt: { state: "done", outcome: { kind: "completed" } } })
    expect(await reconcileHostTurn(f.port, {}, f.path)).toBe("streaming")
    expect(f.outcomes).toEqual([])
    expect(f.notices).toEqual([])
  })

  test("idle completed tail adopts once by entry identity", async () => {
    const f = scenario()
    expect(await reconcileHostTurn(f.port, {}, f.path)).toBe("adopted")
    const record = { final_response: "ANSWER", host_session: { socket: "", routing_id: "", session_path: f.path, instance_id: "", adopted_entry_id: "answer-1" } }
    expect(await reconcileHostTurn(f.port, record, f.path)).toBe("adopted")
    expect(f.outcomes).toEqual([{ status: "completed", finalResponse: "ANSWER" }])
    expect(f.notices).toEqual([{ kind: "adopted", entryId: "answer-1" }])
  })

  for (const kind of ["aborted", "interrupted_by_reopen"] as const) {
    test(`idle ${kind} receipt rejects partial text and requests one continuation`, async () => {
      const f = scenario({ receipt: { state: "done", outcome: { kind } } })
      expect(await reconcileHostTurn(f.port, {}, f.path)).toBe("continued")
      expect(f.outcomes).toEqual([])
      expect(f.notices[0]?.kind).toBe("interrupted")
    })
  }

  test("accepted receipt identifies idle queued work without adopting old text", async () => {
    const f = scenario({ receipt: { state: "accepted" } })
    expect(await reconcileHostTurn(f.port, {}, f.path)).toBe("idle_queued")
    expect(f.notices[0]?.kind).toBe("idle_queued")
    expect(f.outcomes).toEqual([{ status: "cancelled" }])
  })

  test("accepted receipt outranks an older deadline in the transcript", async () => {
    const f = scenario({ receipt: { state: "accepted" }, deadline: true })
    expect(await reconcileHostTurn(f.port, {}, f.path)).toBe("idle_queued")
    expect(f.notices[0]?.kind).toBe("idle_queued")
  })
  test("stale applied receipt falls back to the completed transcript", async () => {
    const f = scenario({ receipt: { state: "applied" } })
    expect(await reconcileHostTurn(f.port, {}, f.path)).toBe("adopted")
    expect(f.outcomes).toEqual([{ status: "completed", finalResponse: "ANSWER" }])
  })

  test("an adoption marker without a persisted terminal still settles the recovered handle", async () => {
    const f = scenario()
    appendFileSync(f.path, `\n${JSON.stringify({ type: "custom", customType: "rpc_client_message_admission", data: { state: "completed" } })}\n`)
    const record = { host_session: { socket: "", routing_id: "", session_path: f.path, instance_id: "", adopted_entry_id: "answer-1" } }
    expect(await reconcileHostTurn(f.port, record, f.path)).toBe("adopted")
    expect(f.notices).toEqual([])
    expect(f.outcomes).toEqual([{ status: "completed", finalResponse: "ANSWER" }])
  })
  for (const receipt of [undefined, { state: "done", outcome: { kind: "deadline", deadline: { kind: "inactivity" } } } satisfies InputEffectStatus]) {
    test(`deadline ${receipt === undefined ? "transcript" : "receipt"} stops without adopting partial text`, async () => {
      const f = scenario({ receipt, aborted: true, deadline: true })
      expect(await reconcileHostTurn(f.port, {}, f.path)).toBe("stopped_deadline")
      expect(f.outcomes).toEqual([{ status: "cancelled" }])
      expect(f.notices).toEqual([{
        kind: "interrupted",
        reason: expect.any(String),
        deadline: { kind: "inactivity" },
      }])
    })
  }
})

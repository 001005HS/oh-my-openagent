import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { formatSessionList } from "./session-formatter"
import { getSdkSessionMessages } from "./sdk-storage"
import { describeSessionError } from "./session-error"

const notFoundBody = { name: "NotFoundError", data: { message: "Session not found: ses_gone" } }

describe("describeSessionError", () => {
  test("#given an OpenCode error body #when described #then it names the error and its message", () => {
    expect(describeSessionError(notFoundBody)).toBe("NotFoundError: Session not found: ses_gone")
  })

  test("#given a plain object with message and code #when described #then both appear", () => {
    expect(describeSessionError({ message: "database is locked", code: "SQLITE_BUSY" })).toBe("database is locked (SQLITE_BUSY)")
  })

  test("#given an object with no known fields #when described #then its JSON is shown, never [object Object]", () => {
    expect(describeSessionError({ status: 500 })).toBe('{"status":500}')
  })

  test("#given an Error, a string and null #when described #then each reads plainly", () => {
    expect(describeSessionError(new Error("boom"))).toBe("boom")
    expect(describeSessionError("plain text")).toBe("plain text")
    expect(describeSessionError(null)).toBe("null")
  })
})

describe("sdk session reads", () => {
  test("#given the SDK answers a session read with an error body #when read #then it rejects with an Error that carries the body's message", async () => {
    //#given
    const client = { session: { messages: async () => ({ error: notFoundBody }) } } as unknown as PluginInput["client"]

    //#when
    const failure = await getSdkSessionMessages(client, "ses_gone").then(() => undefined, (error: unknown) => error)

    //#then
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("NotFoundError: Session not found: ses_gone")
    expect((failure as Error).name).toBe("NotFoundError")
    expect((failure as Error).cause).toBe(notFoundBody)
  })
})

describe("formatSessionList", () => {
  test("#given one session whose info read rejects with an error body #when listed #then the others are listed and the skipped one is named", async () => {
    //#given
    const getInfo = async (id: string) => {
      if (id === "ses_gone") throw notFoundBody
      return { id, message_count: 1, agents_used: [], has_todos: false, has_transcript: false }
    }

    //#when
    const output = await formatSessionList(["ses_ok", "ses_gone"], getInfo)

    //#then
    expect(output).toContain("ses_ok")
    expect(output).toContain("Skipped 1 session that could not be read: ses_gone (NotFoundError: Session not found: ses_gone)")
    expect(output).not.toContain("[object Object]")
  })
})

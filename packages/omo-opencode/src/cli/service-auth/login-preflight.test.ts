import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { CredentialStore } from "./keystore"
import { fakeApi } from "./test-support"

const opened: string[] = []
mock.module("./browser", () => ({
  // Never waits: a regression that reaches the browser falls through to the device flow and ends at once.
  openSignInBrowser: async (url: string) => { opened.push(url); return false },
}))
const emptyStore: CredentialStore = { read: async () => null, write: async () => {}, clear: async () => {} }
mock.module("./keystore", () => ({ createCredentialStore: () => emptyStore }))

const { runServiceAuthCommand } = await import("./commands")

afterEach(() => {
  opened.length = 0
  process.exitCode = 0
})

async function closedOrigin(): Promise<string> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const origin = server.url.origin
  await server.stop(true)
  return origin
}

async function login(api: string): Promise<string[]> {
  const errors: string[] = []
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
  try {
    await runServiceAuthCommand(["login", "--api", api, "--accounts", api])
  } finally {
    error.mockRestore()
  }
  return errors
}

test("login against an unreachable service opens no browser and says it can't reach the service", async () => {
  const api = await closedOrigin()
  const errors = await login(api)
  expect(opened).toEqual([])
  expect(errors).toEqual([`Can't reach OmO accounts at ${api}. The service may not be available yet, or your network, proxy or certificate settings are blocking it.`])
  expect(process.exitCode).toBe(1)
})

test("login against a service whose health check is refused opens no browser and says it isn't available", async () => {
  const api = fakeApi(() => Response.json(
    { error: { code: "unavailable", message: "maintenance", retryable: true, requestId: "test" } }, { status: 503 }))
  const errors = await login(api)
  expect(opened).toEqual([])
  expect(errors).toEqual([`OmO accounts at ${api} aren't available right now. Try again later.`])
  expect(process.exitCode).toBe(1)
})

test("login against a reachable service checks health first, then opens the browser as before", async () => {
  const requests: string[] = []
  const api = fakeApi(request => {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (path === "/v1/health") return Response.json({ ok: true })
    return new Response(null, { status: 404 })
  })
  await login(api)
  expect(requests[0]).toBe("GET /v1/health")
  expect(opened).toHaveLength(1)
  expect(new URL(opened[0] ?? "").origin).toBe(api)
})

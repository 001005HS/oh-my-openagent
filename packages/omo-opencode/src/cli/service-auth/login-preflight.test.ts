import { afterEach, expect, spyOn, test } from "bun:test"
import { runServiceAuthCommand } from "./commands"
import { fakeApi, memorySecrets } from "./test-support"

afterEach(() => { process.exitCode = 0 })

async function closedOrigin(): Promise<string> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const origin = server.url.origin
  await server.stop(true)
  return origin
}

async function login(api: string, opened: string[]) {
  const errors: string[] = []
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
  const secrets = memorySecrets()
  try {
    const started = performance.now()
    await runServiceAuthCommand(["login", "--api", api, "--accounts", api], {
      open: async url => { opened.push(url); return true },
      store: secrets.store,
    })
    return { errors, elapsedMs: performance.now() - started }
  } finally {
    error.mockRestore()
  }
}

test("login against an unreachable service fails at once with one line and opens no browser", async () => {
  const opened: string[] = []
  const result = await login(await closedOrigin(), opened)
  expect(opened).toEqual([])
  expect(result.errors).toEqual(["OmO accounts aren't available yet."])
  expect(process.exitCode).toBe(1)
  expect(result.elapsedMs).toBeLessThan(5_000)
})

test("login against a service that answers health with an error opens no browser", async () => {
  const opened: string[] = []
  const api = fakeApi(() => new Response("not launched", { status: 503 }))
  const result = await login(api, opened)
  expect(opened).toEqual([])
  expect(result.errors).toEqual(["OmO accounts aren't available yet."])
  expect(process.exitCode).toBe(1)
})

test("login against a reachable service checks health first, then opens the browser as before", async () => {
  const opened: string[] = []
  const requests: string[] = []
  const api = fakeApi(request => {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (path === "/v1/health") return Response.json({ ok: true })
    return new Response(null, { status: 404 })
  })
  const errors: string[] = []
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
  const secrets = memorySecrets()
  try {
    await runServiceAuthCommand(["login", "--api", api, "--accounts", api], {
      open: async url => {
        opened.push(url)
        process.emit("SIGINT")
        return true
      },
      store: secrets.store,
    })
  } finally {
    error.mockRestore()
  }
  expect(requests[0]).toBe("GET /v1/health")
  expect(opened).toHaveLength(1)
  expect(new URL(opened[0] ?? "").origin).toBe(api)
  expect(errors).toEqual(["Sign-in cancelled."])
})

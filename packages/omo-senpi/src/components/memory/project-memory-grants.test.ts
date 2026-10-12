import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { registerMemoryGuard } from "./guard"
import { componentContext } from "./memory.test-support"
import { type FilesystemOperation, registerMemoryFilesystemPolicy } from "./policy-guard"
import { canonical, policyFixture, registeredPolicy } from "./policy-guard.test-support"
import { grantProjectMemoryRead } from "./project-memory-grants"
import { rmSyncEfaultTolerant } from "./teardown.test-support"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSyncEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function projectGrantFixture() {
  const setup = policyFixture(roots)
  const foreignRepo = join(setup.foreignRoot, "repo")
  const gitConfig = join(foreignRepo, ".git", "config")
  mkdirSync(join(foreignRepo, ".git"), { recursive: true })
  mkdirSync(join(setup.foreignRoot, "runtime"), { recursive: true })
  writeFileSync(gitConfig, "[core]")
  registerMemoryFilesystemPolicy(setup.pi, setup.own)
  const policy = registeredPolicy(setup)
  const decide = (operation: FilesystemOperation, path: string) =>
    policy.check({ operation, canonicalPath: canonical(path), toolName: operation === "write" ? "write" : "read" })
  return { setup, foreignRepo, gitConfig, decide }
}

describe("project memory read grants (#10044)", () => {
  test("#given a project identity the resolver returned #when its note is read #then the hard policy allows it", async () => {
    // given
    const { setup, foreignRepo, decide } = projectGrantFixture()
    grantProjectMemoryRead(setup.own, foreignRepo)

    // when / then
    expect(await decide("read", setup.foreignFile)).toEqual({ allow: true })
  })

  test("#given a granted project identity #when its notes are written, enumerated, or its git metadata read #then each stays denied", async () => {
    // given
    const { setup, foreignRepo, gitConfig, decide } = projectGrantFixture()
    grantProjectMemoryRead(setup.own, foreignRepo)

    // when / then
    expect((await decide("write", setup.foreignFile)).allow).toBe(false)
    expect((await decide("enumerate", foreignRepo)).allow).toBe(false)
    expect((await decide("read", gitConfig)).allow).toBe(false)
    expect((await decide("read", join(setup.foreignRoot, "runtime"))).allow).toBe(false)
  })

  test("#given no grant #when a project identity's note is read #then it stays denied", async () => {
    // given
    const { setup, decide } = projectGrantFixture()

    // when / then
    expect((await decide("read", setup.foreignFile)).allow).toBe(false)
  })

  test("#given a grant on one session's identity #when another bound identity reads the same note #then it stays denied", async () => {
    // given
    const first = projectGrantFixture()
    const second = policyFixture(roots)
    grantProjectMemoryRead(first.setup.own, first.foreignRepo)
    registerMemoryFilesystemPolicy(second.pi, second.own)

    // when
    const decision = await registeredPolicy(second).check({
      operation: "read",
      canonicalPath: canonical(second.foreignFile),
      toolName: "read",
    })

    // then
    expect(decision.allow).toBe(false)
  })

  test("#given a granted project identity #when the soft guard sees a read and a write tool call #then only the read passes", async () => {
    // given
    const { setup, foreignRepo } = projectGrantFixture()
    grantProjectMemoryRead(setup.own, foreignRepo)
    const pi = new FakeExtensionAPI()
    registerMemoryGuard(pi, componentContext(), { getContext: () => setup.own, resolveCwd: () => setup.workspace })
    const call = (toolName: string, input: Record<string, unknown>) =>
      pi.dispatch("tool_call", { type: "tool_call", toolCallId: "call-1", toolName, input }, {})

    // when
    const read = await call("read", { path: setup.foreignFile })
    const write = await call("write", { path: setup.foreignFile, content: "x" })

    // then
    expect(read.some((result) => result !== undefined)).toBe(false)
    expect(write).toContainEqual(expect.objectContaining({ block: true }))
  })
})

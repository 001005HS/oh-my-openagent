import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MEMORY_ROOT_ENV_VAR } from "./layout"
import { createProjectIdentityResolver } from "./project-scope"
import { resolveMemoryIdentity } from "./resolve"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(identityDirs: (layout: { workspace: string; child: string; sibling: string }) => readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "project-scope-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const child = join(workspace, "projects", "child")
  const sibling = join(root, "sibling")
  for (const dir of [join(child, "src"), sibling]) mkdirSync(dir, { recursive: true })
  const memoryRoot = join(root, "memory")
  const env = { [MEMORY_ROOT_ENV_VAR]: memoryRoot }
  for (const dir of identityDirs({ workspace, child, sibling })) {
    mkdirSync(resolveMemoryIdentity("auto", dir, env).paths.repo, { recursive: true })
  }
  return { workspace, child, sibling, env }
}

describe("createProjectIdentityResolver", () => {
  it("#given a child project with its own memory #when a file under it is touched #then that identity is returned", () => {
    // given
    const { workspace, child, env } = fixture(({ child }) => [child])
    const resolver = createProjectIdentityResolver({ sessionCwd: workspace, env })

    // when
    const found = resolver.forPath(join(child, "src", "index.ts"))

    // then
    expect(found?.projectDir).toBe(child)
    expect(found?.identity.id).toBe(resolveMemoryIdentity("auto", child, env).id)
  })

  it("#given the session's own project has memory #when a file in it is touched #then nothing is returned", () => {
    // given
    const { workspace, env } = fixture(({ workspace }) => [workspace])
    const resolver = createProjectIdentityResolver({ sessionCwd: workspace, env })

    // when / then
    expect(resolver.forPath(join(workspace, "README.md"))).toBeUndefined()
  })

  it("#given a project outside the session's working tree has memory #when its file is touched #then it is never returned", () => {
    // given
    const { workspace, sibling, env } = fixture(({ sibling }) => [sibling])
    const resolver = createProjectIdentityResolver({ sessionCwd: workspace, env })

    // when / then
    expect(resolver.forPath(join(sibling, "notes.md"))).toBeUndefined()
  })

  it("#given no project under the file has memory #when it is touched #then nothing is returned and nothing is created", () => {
    // given
    const { workspace, child, env } = fixture(() => [])
    const resolver = createProjectIdentityResolver({ sessionCwd: workspace, env })

    // when
    const found = resolver.forPath(join(child, "src", "index.ts"))

    // then
    expect(found).toBeUndefined()
    expect(existsSync(resolveMemoryIdentity("auto", child, env).paths.root)).toBe(false)
  })

  it("#given nested projects both with memory #when a file in the inner one is touched #then the nearest wins", () => {
    // given
    const { workspace, child, env } = fixture(({ workspace, child }) => [join(workspace, "projects"), child])
    const resolver = createProjectIdentityResolver({ sessionCwd: workspace, env })

    // when / then
    expect(resolver.forPath(join(child, "src", "index.ts"))?.projectDir).toBe(child)
    expect(resolver.forPath(join(workspace, "projects", "other.md"))?.projectDir).toBe(join(workspace, "projects"))
  })

  it("#given a directory was already probed #when another file under it is touched #then the filesystem is not probed again", () => {
    // given
    const { workspace, child, env } = fixture(({ child }) => [child])
    let probes = 0
    const resolver = createProjectIdentityResolver({
      sessionCwd: workspace,
      env,
      exists: (path) => {
        probes += 1
        return existsSync(path)
      },
    })

    // when
    resolver.forPath(join(child, "src", "a.ts"))
    const afterFirst = probes
    resolver.forPath(join(child, "src", "b.ts"))

    // then
    expect(afterFirst).toBeGreaterThan(0)
    expect(probes).toBe(afterFirst)
  })

  it("#given a relative path #when it is touched #then it resolves against the session's working tree", () => {
    // given
    const { workspace, child, env } = fixture(({ child }) => [child])
    const resolver = createProjectIdentityResolver({ sessionCwd: workspace, env })

    // when / then
    expect(resolver.forPath("projects/child/src/index.ts")?.projectDir).toBe(child)
  })

  it("#given a directory inside the working tree that is a symlink to a project outside it #when a file through it is touched #then nothing is returned", () => {
    // given
    const { workspace, sibling, env } = fixture(({ sibling }) => [sibling])
    symlinkSync(sibling, join(workspace, "linked"))
    const resolver = createProjectIdentityResolver({ sessionCwd: workspace, env })

    // when / then
    expect(resolver.forPath(join(workspace, "linked", "notes.md"))).toBeUndefined()
  })
})

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MEMORY_ROOT_ENV_VAR } from "./layout"
import { resolveMemoryIdentity } from "./resolve"

// Real `git worktree add` output is the platform contract the git auto identity reads, so this
// suite builds an actual clone with a linked worktree instead of faking the pointer files.
const GIT_IDENTITY = ["-c", "user.name=qa", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false"]

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, stdio: "ignore" })
}

let parent = ""
let main = ""
let worktree = ""
let plain = ""
let env: Record<string, string> = {}

beforeAll(() => {
  parent = realpathSync.native(mkdtempSync(join(tmpdir(), "memory-identity-worktree-")))
  main = join(parent, "project")
  worktree = join(parent, "project-feature")
  plain = join(parent, "not-a-repo")
  mkdirSync(main)
  mkdirSync(plain)
  mkdirSync(join(main, "packages", "api"), { recursive: true })
  git(main, ["init", "--quiet", "--initial-branch=main"])
  git(main, ["commit", "--quiet", "--allow-empty", "-m", "init"])
  git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree])
  mkdirSync(join(worktree, "packages", "api"), { recursive: true })
  env = { [MEMORY_ROOT_ENV_VAR]: join(parent, "memory") }
})

afterAll(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe("resolveMemoryIdentity with a real linked worktree", () => {
  it("#given auto_identity git #when the main checkout and its worktree resolve #then both share the main checkout's existing id", () => {
    // given
    const pathModeMain = resolveMemoryIdentity("auto", main, env)
    // when
    const gitModeMain = resolveMemoryIdentity("auto", main, env, undefined, { autoIdentity: "git" })
    const gitModeWorktree = resolveMemoryIdentity("auto", worktree, env, undefined, { autoIdentity: "git" })
    // then
    expect(gitModeMain.id).toBe(pathModeMain.id)
    expect(gitModeWorktree.id).toBe(pathModeMain.id)
    expect(gitModeWorktree.paths.repo).toBe(pathModeMain.paths.repo)
  })

  it("#given auto_identity git #when a worktree subdirectory resolves #then it shares the same subdirectory of the main checkout", () => {
    // given
    const pathModeMainSubdir = resolveMemoryIdentity("auto", join(main, "packages", "api"), env)
    // when
    const gitModeWorktreeSubdir = resolveMemoryIdentity("auto", join(worktree, "packages", "api"), env, undefined, {
      autoIdentity: "git",
    })
    // then
    expect(gitModeWorktreeSubdir.id).toBe(pathModeMainSubdir.id)
  })

  it("#given the default auto_identity #when the worktree resolves #then it keeps its own path-derived id", () => {
    // given
    const mainIdentity = resolveMemoryIdentity("auto", main, env)
    // when
    const worktreeIdentity = resolveMemoryIdentity("auto", worktree, env)
    const explicitPath = resolveMemoryIdentity("auto", worktree, env, undefined, { autoIdentity: "path" })
    // then
    expect(worktreeIdentity.id).not.toBe(mainIdentity.id)
    expect(explicitPath.id).toBe(worktreeIdentity.id)
  })

  it("#given auto_identity git #when an explicit agent name or a non-git directory resolves #then the result matches path mode", () => {
    // given
    const named = resolveMemoryIdentity("backend-lead", worktree, env)
    const outside = resolveMemoryIdentity("auto", plain, env)
    // when
    const namedGit = resolveMemoryIdentity("backend-lead", worktree, env, undefined, { autoIdentity: "git" })
    const outsideGit = resolveMemoryIdentity("auto", plain, env, undefined, { autoIdentity: "git" })
    // then
    expect(namedGit.id).toBe(named.id)
    expect(outsideGit.id).toBe(outside.id)
  })
})

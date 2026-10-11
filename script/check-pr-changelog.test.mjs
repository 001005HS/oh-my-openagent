import { describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { load } from "js-yaml"
import { checkPrChangelog, hasAddedUnreleasedLine, isUserFacingPath } from "./check-pr-changelog.mjs"

describe("shipped path classifier", () => {
  const files = ["dist", "bin", "assets/*.json", "packages/example/runtime", "packages/example/scripts",
    "!packages/example/scripts/install", ".agents/skills", "script/qa/strip-ansi.mjs", "docs/reference/guide.md"]
  test.each([
    "packages/omo-opencode/src/tools/delegate-task/categories.ts",
    "packages/omo-senpi/src/components/onboarding/component.ts",
    "packages/senpi-desktop-engine/crates/runtime/src/lib.rs",
    "packages/omo-senpi/skills/onboarding/SKILL.md",
    "packages/shared-skills/skills/research/SKILL.md",
    "packages/prompts-core/prompts/ultrawork/codex.md",
    ".agents/skills/research/SKILL.md", ".opencode/command/run.md",
    "bin/omo.js", "postinstall.mjs", "package.json",
    "assets/runtime.json", "packages/example/runtime/entry.mjs",
    "packages/example/scripts/bootstrap.ps1", "script/qa/strip-ansi.mjs",
  ])("requires a note for %s", (path) => {
    expect(isUserFacingPath(path, files)).toBe(true)
  })
  test.each([
    "packages/omo-senpi/src/components/onboarding/component.test.ts",
    "packages/omo-senpi/src/components/onboarding/test-harness.ts",
    "packages/omo-senpi/src/__fixtures__/source.ts",
    "packages/omo-senpi/src/tests/source.ts",
    "packages/example/runtime/source.spec.mjs",
    "packages/omo-senpi/plugin/extensions/omo.js",
    "packages/example/dist/runtime.js", "dist/cli.js",
    "packages/omo-codex/scripts/install-dist/install-local.mjs",
    "packages/example/src/config.generated.ts",
    "packages/shared-skills/upstreams/design/source.ts",
    "packages/example/scripts/install/setup.mjs",
    "packages/example/runtime/AGENTS.md", ".agents/skills/example/README.md",
    "docs/reference/guide.md", "README.md", "AGENTS.md", "changes.md",
    "script/build.ts", "scripts/check-third-party-notices.mjs",
    ".github/workflows/ci.yml", "bun.lock",
  ])("does not require a note for %s", (path) => {
    expect(isUserFacingPath(path, files)).toBe(false)
  })
})

describe("Unreleased added-line detection", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\nExisting note.\n\n## [1.0.0]\n\nOld note.\n"
  test.each([
    ["adds content", "## [Unreleased]\n\nNew note.\n", "@@ -0,0 +3 @@\n+New note.", true],
    ["edits content", "## [Unreleased]\n\nEdited note.\n", "@@ -5 +3 @@\n-Existing note.\n+Edited note.", true],
    ["adds bullets", "## [Unreleased]\n### Fixed\n- New note.\n", "@@ -0,0 +3 @@\n+- New note.", true],
    ["adds only heading", "## [Unreleased]\n### Fixed\n", "@@ -0,0 +2 @@\n+### Fixed", false],
    ["adds only blank", "## [Unreleased]\n\n", "@@ -0,0 +2 @@\n+", false],
    ["adds a released note", "## [Unreleased]\n\n## [1.0.0]\nNew note.\n", "@@ -0,0 +4 @@\n+New note.", false],
    ["has no section", "# Changelog\nNew note.\n", "@@ -0,0 +2 @@\n+New note.", false],
    ["moves existing content", "## [Unreleased]\nExisting note.\n", "@@ -0,0 +2 @@\n+Existing note.", false],
    ["adds comment", "## [Unreleased]\n<!-- hidden -->\n", "@@ -0,0 +2 @@\n+<!-- hidden -->", false],
    ["adds multiline comment", "## [Unreleased]\n<!--\nhidden\n-->\n", "@@ -0,0 +3 @@\n+hidden", false],
    ["stops at any level-two heading", "## [Unreleased]\n## Notes\nNew note.\n", "@@ -0,0 +3 @@\n+New note.", false],
    ["does not accept an unchanged section", before, "", false],
    ["ignores additions before the section", "New note.\n## [Unreleased]\nExisting note.\n", "@@ -0,0 +1 @@\n+New note.", false],
  ])("%s", (_name, after, diff, expected) => {
    expect(hasAddedUnreleasedLine(before, after, diff)).toBe(expected)
  })
  test("tracks line numbers through deletion, context and separate hunks", () => {
    const after = "# Changelog\n## [Unreleased]\nExisting note.\nNew note.\n## [1.0.0]\nOld note.\n"
    const diff = "@@ -1,2 +1 @@\n # Changelog\n-\n@@ -3,3 +2,3 @@\n ## [Unreleased]\n-\n Existing note.\n+New note.\n"
    expect(hasAddedUnreleasedLine(before, after, diff)).toBe(true)
  })
})

describe("gate verdict", () => {
  const facts = { changedFiles: ["packages/example/src/runtime.ts"], before: "", after: "", diff: "" }
  test("fails a runtime change despite unrelated labels", () => {
    expect(checkPrChangelog({ ...facts, labels: ["No-changelog", "ci:full-matrix"] }).pass).toBe(false)
  })
  test("passes the exact escape label", () => {
    expect(checkPrChangelog({ ...facts, labels: ["no-changelog"] }).pass).toBe(true)
  })
  test("passes a docs-only change", () => {
    expect(checkPrChangelog({ ...facts, changedFiles: ["docs/guide.md"] }).pass).toBe(true)
  })
  test("classifies removed shipped entries using the previous manifest", () => {
    expect(checkPrChangelog({ ...facts, changedFiles: ["assets/runtime.json"], files: [], previousFiles: ["assets/*.json"] }).pass).toBe(false)
  })
})

test("CLI uses the PR merge base, includes deleted sources, and accepts a real note", () => {
  const repo = mkdtempSync(join(tmpdir(), "changelog-gate-cli-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  const script = fileURLToPath(new URL("./check-pr-changelog.mjs", import.meta.url))
  const run = (base, labels = "[]") => spawnSync(process.execPath, [script, "--repo", repo, "--base", base, "--labels", labels], { encoding: "utf8", cwd: "/tmp" })
  try {
    git("init", "-q")
    writeFileSync(join(repo, "package.json"), JSON.stringify({ files: ["assets/runtime.json"] }))
    writeFileSync(join(repo, "CHANGELOG.md"), "## [Unreleased]\n\n## [1.0.0]\nOld note.\n")
    mkdirSync(join(repo, "assets"))
    writeFileSync(join(repo, "assets/runtime.json"), "{}\n")
    git("add", ".")
    git("commit", "-qm", "initial fixture")
    const base = git("rev-parse", "HEAD")
    git("branch", "base")
    rmSync(join(repo, "assets/runtime.json"))
    git("add", ".")
    git("commit", "-qm", "remove shipped asset")
    expect(run(base).status).toBe(1)
    expect(run(base, '["no-changelog"]').status).toBe(0)
    writeFileSync(join(repo, "CHANGELOG.md"), "## [Unreleased]\nRemoved asset.\n\n## [1.0.0]\nOld note.\n")
    git("add", ".")
    git("commit", "-qm", "document removal")
    const head = git("rev-parse", "HEAD")
    git("checkout", "-q", "base")
    writeFileSync(join(repo, "CHANGELOG.md"), "## [Unreleased]\nBase-only note.\n\n## [1.0.0]\nOld note.\n")
    git("add", ".")
    git("commit", "-qm", "advance base")
    const advancedBase = git("rev-parse", "HEAD")
    git("checkout", "-q", head)
    expect(run(advancedBase).status).toBe(0)
    expect(run("--invalid-option").status).toBe(1)
    expect(run(base, "{}").status).toBe(1)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("workflow limits label events before acquiring isolated concurrency", () => {
  const workflow = load(readFileSync(new URL("../.github/workflows/changelog-gate.yml", import.meta.url), "utf8"))
  const ci = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"))
  const job = workflow.jobs["changelog-gate"]
  expect(workflow.on.pull_request.branches).toEqual(["dev"])
  expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "labeled", "unlabeled"])
  expect(workflow.concurrency).toBeUndefined()
  const enabled = new Function("github", `return (${job.if})`)
  for (const action of ["opened", "synchronize", "reopened", "labeled", "unlabeled"]) {
    for (const label of ["no-changelog", "ci:full-matrix", "bug"]) {
      expect(enabled({ event: { action, label: { name: label } } })).toBe(
        !["labeled", "unlabeled"].includes(action) || label === "no-changelog")
    }
  }
  expect(job.concurrency.group).toBe("pr-changelog-gate-${{ github.event.pull_request.number }}")
  expect(job.concurrency.group).not.toBe(ci.concurrency.group)
  expect(ci.on.pull_request.types).not.toContain("labeled")
  expect(ci.on.pull_request.types).not.toContain("unlabeled")
  expect(job.steps[0].with.ref).toBe("${{ github.event.pull_request.head.sha }}")
  expect(job.steps[0].with["fetch-depth"]).toBe(0)
  expect(job.steps.at(-1).run).toBe("bun script/check-pr-changelog.mjs")
})

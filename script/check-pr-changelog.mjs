#!/usr/bin/env bun
import { execFileSync } from "node:child_process"

const noChangelogLabel = "no-changelog"

// Development artifacts never trigger release notes, even inside a shipped directory.
function excludedPath(path) {
  return /(^|\/)(?:tests?|__tests__|__fixtures__|fixtures|test-fixtures|node_modules|dist|build|install-dist|upstreams)(\/|$)/.test(path)
    || /(?:^|\/)(?:AGENTS|README|CHANGELOG|changes|THIRD-PARTY-NOTICES)\.md$/i.test(path)
    || /\.(?:test|spec|snap)\.[^/]+$/.test(path)
    || /(?:^|\/)(?:test-harness|test-utils|test-support)(?:\.[^/]+)?$/.test(path)
    || /^packages\/omo-senpi\/plugin\/extensions\//.test(path)
    || /(?:^|\/)[^/]+\.generated\.[^/]+$/.test(path)
}

export function isUserFacingPath(path, files = []) {
  if (excludedPath(path) || /^(?:docs|\.github)\//.test(path)) return false
  const included = files.filter((entry) => !entry.startsWith("!"))
  const excluded = files.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1))
  const matches = (entry) => new Bun.Glob(entry).match(path)
    || new Bun.Glob(`${entry.replace(/\/$/, "")}/**`).match(path)
  if (excluded.some(matches)) return false
  if (path === "package.json" || path === "postinstall.mjs" || path.startsWith("bin/")) return true
  if (/^packages\/[^/]+\/(?:src|crates)\//.test(path)) return true
  if (/^(?:\.agents|\.opencode)\/(?:skills|commands?)\//.test(path)) return true
  if (/^packages\/[^/]+\/(?:skills|commands?|prompts)\//.test(path)) return true
  return included.some(matches)
}

export function hasAddedUnreleasedLine(before, after, diff) {
  // Keep original line numbers while ignoring Markdown comments, including multiline ones.
  const visible = after.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ""))
  const eligible = new Set()
  let inUnreleased = false
  for (const [index, line] of visible.split("\n").entries()) {
    if (/^##\s/.test(line)) {
      inUnreleased = /^## \[Unreleased\](?:\s.*)?$/.test(line)
      continue
    }
    if (inUnreleased && line.trim() && !/^#{1,6}\s/.test(line.trim())) eligible.add(index + 1)
  }
  const previousLines = new Set(before.split("\n").map((line) => line.trim()))
  let headLine = 0
  let inHunk = false
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      headLine = Number(hunk[1])
      inHunk = true
    } else if (inHunk && line.startsWith("+")) {
      if (eligible.has(headLine) && !previousLines.has(line.slice(1).trim())) return true
      headLine += 1
    } else if (inHunk && line.startsWith(" ")) {
      headLine += 1
    }
  }
  return false
}

export function checkPrChangelog({ changedFiles, files = [], previousFiles = files, before, after, diff, labels = [] }) {
  const userFacingFiles = changedFiles.filter((path) => isUserFacingPath(path, files) || isUserFacingPath(path, previousFiles))
  if (labels.includes(noChangelogLabel)) return { pass: true, reason: "no-changelog label present", userFacingFiles }
  if (userFacingFiles.length === 0) return { pass: true, reason: "no user-facing changes", userFacingFiles }
  const pass = hasAddedUnreleasedLine(before, after, diff)
  return { pass, reason: pass ? "added an Unreleased content line" : "user-facing changes without an added Unreleased content line", userFacingFiles }
}

export function main(argv) {
  const args = { "--repo": process.cwd(), "--head": "HEAD", "--labels": process.env.CHANGELOG_GATE_LABELS ?? "[]" }
  for (let index = 0; index < argv.length; index += 2) {
    if (!["--repo", "--base", "--head", "--labels"].includes(argv[index]) || !argv[index + 1]) {
      throw new Error("usage: bun script/check-pr-changelog.mjs --base <revision> [--head <revision>] [--repo <path>] [--labels <JSON array>]")
    }
    args[argv[index]] = argv[index + 1]
  }
  const base = args["--base"] ?? process.env.CHANGELOG_GATE_BASE
  if (!base) throw new Error("missing --base")
  const labels = JSON.parse(args["--labels"])
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) throw new Error("labels must be a JSON string array")
  const git = (...gitArgs) => execFileSync("git", ["-C", args["--repo"], ...gitArgs], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  // Resolve untrusted CLI revisions before using them in Git commands or tree selectors.
  const resolve = (revision) => git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`).trim()
  const head = resolve(args["--head"])
  const mergeBase = git("merge-base", resolve(base), head).trim()
  // Disable rename detection: deleting a shipped source by moving it to docs must still count.
  const changedFiles = git("diff", "--no-renames", "--name-only", "-z", mergeBase, head).split("\0").filter(Boolean)
  const beforeManifest = JSON.parse(git("show", `${mergeBase}:package.json`))
  const afterManifest = JSON.parse(git("show", `${head}:package.json`))
  const readChangelog = (revision) => {
    const exists = git("ls-tree", "--name-only", revision, "--", "CHANGELOG.md").trim()
    return exists ? git("show", `${revision}:CHANGELOG.md`) : ""
  }
  const result = checkPrChangelog({
    changedFiles,
    files: afterManifest.files ?? [],
    previousFiles: beforeManifest.files ?? [],
    before: readChangelog(mergeBase),
    after: readChangelog(head),
    diff: git("diff", "--no-ext-diff", "--no-textconv", "--unified=0", mergeBase, head, "--", "CHANGELOG.md"),
    labels,
  })
  console.log(`changelog-gate: ${result.pass ? "PASS" : "FAIL"} - ${result.reason}`)
  for (const path of result.userFacingFiles) console.log(`  user-facing: ${path}`)
  if (!result.pass) console.log("Add a content line under ## [Unreleased] in CHANGELOG.md, or ask a maintainer to apply no-changelog.")
  return result.pass ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`changelog-gate: ERROR - ${error.message}`)
    process.exitCode = 1
  }
}

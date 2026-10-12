// Git layout probe for the opt-in `memory.auto_identity: "git"` mode (#9659).
//
// A linked worktree's `.git` is a `gitdir: <admin>` pointer file whose admin directory holds a
// `commondir` file naming the shared git directory. Mapping the worktree onto the main working
// tree (the parent of that common dir) lets every worktree of one clone share the main
// checkout's memory, while the main checkout itself keeps exactly the path it hashes today.
// Resolution walks up to the nearest `.git` entry and reads at most two small files, never
// spawning `git`; every unreadable or malformed pointer answers "not a linked worktree" so the
// caller keeps the path-derived identity.

import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { readFileSync, statSync } from "../fs/resilient"

export type GitEntryKind = "directory" | "file"

export interface GitLayoutProbe {
  readonly entryKind: (path: string) => GitEntryKind | undefined
  readonly readText: (path: string) => string | undefined
}

export interface LinkedWorktreeSource {
  readonly hashSource: string
  readonly slugSource: string
}

const GITDIR_POINTER = /^gitdir:\s*(.+)$/
const BARE_SUFFIX = /\.git$/

const defaultGitLayoutProbe: GitLayoutProbe = {
  entryKind(path) {
    try {
      const stats = statSync(path)
      if (stats.isDirectory()) return "directory"
      return stats.isFile() ? "file" : undefined
    } catch {
      // A missing or unreadable entry means "no git marker here"; the walk moves on.
      return undefined
    }
  },
  readText(path) {
    try {
      return readFileSync(path, "utf8")
    } catch {
      // An unreadable pointer falls back to the path-derived identity by contract.
      return undefined
    }
  },
}

export function resolveLinkedWorktreeSource(
  cwd: string,
  probe: GitLayoutProbe = defaultGitLayoutProbe,
): LinkedWorktreeSource | undefined {
  const start = resolve(cwd)
  for (let dir = start; ; dir = dirname(dir)) {
    const marker = join(dir, ".git")
    const kind = probe.entryKind(marker)
    if (kind === "directory") return undefined
    if (kind === "file") return fromPointerFile(marker, dir, relative(dir, start), probe)
    if (dirname(dir) === dir) return undefined
  }
}

function fromPointerFile(
  marker: string,
  checkoutRoot: string,
  subpath: string,
  probe: GitLayoutProbe,
): LinkedWorktreeSource | undefined {
  const pointer = firstLine(probe.readText(marker))
  const target = pointer === undefined ? undefined : GITDIR_POINTER.exec(pointer)?.[1]?.trim()
  if (target === undefined || target === "") return undefined
  const adminDir = absolutize(target, checkoutRoot)
  const commonDirText = firstLine(probe.readText(join(adminDir, "commondir")))
  if (commonDirText === undefined || commonDirText === "") return undefined
  const commonDir = absolutize(commonDirText, adminDir)
  const isStandardLayout = basename(commonDir) === ".git"
  const base = isStandardLayout ? dirname(commonDir) : commonDir
  const hashSource = subpath === "" ? base : join(base, subpath)
  if (subpath !== "") return { hashSource, slugSource: basename(hashSource) }
  const rootName = basename(base)
  const slugSource = isStandardLayout ? rootName : rootName.replace(BARE_SUFFIX, "") || rootName
  return { hashSource, slugSource }
}

function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.split(/\r?\n/, 1)[0]?.trim()
}

function absolutize(path: string, base: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path)
}

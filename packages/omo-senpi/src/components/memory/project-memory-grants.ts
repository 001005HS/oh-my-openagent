import { realpathSync } from "@oh-my-opencode/memory-core/fs"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { MemoryIdentityContext } from "./context"

// Read-only exceptions to the cross-identity memory denial (#10044). A bound identity may READ the
// committed notes of a project identity the project-scope resolver found inside its session's
// working tree, and only after that resolver returned it. Enumeration, writes, the project's git
// metadata and every other identity stay denied by the soft guard and the hard filesystem policy.
const grants = new WeakMap<MemoryIdentityContext, Set<string>>()

export function grantProjectMemoryRead(context: MemoryIdentityContext, projectRepo: string): void {
  let roots = grants.get(context)
  if (roots === undefined) {
    roots = new Set()
    grants.set(context, roots)
  }
  for (const root of [resolve(projectRepo), canonical(projectRepo)]) if (root !== undefined) roots.add(root)
}

export function isGrantedProjectMemoryRead(context: MemoryIdentityContext, target: string): boolean {
  const roots = grants.get(context)
  if (roots === undefined) return false
  const resolved = resolve(target)
  for (const root of roots) {
    if (isWithin(root, resolved) && !isWithin(join(root, ".git"), resolved)) return true
  }
  return false
}

function canonical(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

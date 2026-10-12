// Project-scoped memory (#10044): which memory identity owns a file a session touches.
//
// A session binds one identity, derived from its working directory. A file under a child project
// that has its own auto identity belongs to that identity's memory. The walk stops below the
// session's working directory, so a project outside the session's tree is never consulted and the
// session's own identity is never returned. Nothing is created: only identities whose repo already
// exists count.

import { existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import { resolveMemoryIdentity, type MemoryIdentity } from "./resolve"

export interface ProjectIdentity {
  readonly projectDir: string
  readonly identity: MemoryIdentity
}

export interface ProjectIdentityResolverOptions {
  readonly sessionCwd: string
  readonly env?: Record<string, string | undefined>
  readonly exists?: (path: string) => boolean
}

export interface ProjectIdentityResolver {
  forPath(filePath: string): ProjectIdentity | undefined
}

function isStrictlyInside(dir: string, root: string): boolean {
  const rel = relative(root, dir)
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)
}

export function createProjectIdentityResolver(options: ProjectIdentityResolverOptions): ProjectIdentityResolver {
  const sessionCwd = resolve(options.sessionCwd)
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const byDir = new Map<string, ProjectIdentity | null>()

  function identityAt(dir: string): ProjectIdentity | null {
    const cached = byDir.get(dir)
    if (cached !== undefined) return cached
    const identity = resolveMemoryIdentity("auto", dir, env, { exists })
    const found = exists(identity.paths.repo) ? { projectDir: dir, identity } : null
    byDir.set(dir, found)
    return found
  }

  return {
    forPath(filePath) {
      let dir = dirname(resolve(sessionCwd, filePath))
      while (isStrictlyInside(dir, sessionCwd)) {
        const found = identityAt(dir)
        if (found !== null) return found
        dir = dirname(dir)
      }
      return undefined
    },
  }
}

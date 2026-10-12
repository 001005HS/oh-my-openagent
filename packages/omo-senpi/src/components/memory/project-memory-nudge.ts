import {
  GitMemoryRepo,
  RecallCorpusCache,
  createProjectIdentityResolver,
  parseProjectMemoryPath,
  qualifyProjectDocuments,
  redactSecretLikeMaterial,
  type ProjectIdentity,
  type ProjectIdentityResolver,
  type RecallDocument,
} from "@oh-my-opencode/memory-core"

import { join } from "node:path"

import type { ComponentLogger, SenpiExtensionAPI } from "../../extension/types"
import type { MemoryIdentityContext } from "./context"
import { grantProjectMemoryRead, revokeProjectMemoryReads } from "./project-memory-grants"
import { isRecord, sessionIdFrom } from "./wiring-context"

export const PROJECT_MEMORY_NUDGE_MAX_NOTES = 30
export const PROJECT_MEMORY_RECALL_MAX_PROJECTS = 3

const TOUCH_TOOL_NAMES = new Set(["read", "edit", "write"])
const PATH_ARGUMENT_NAMES = ["path", "file_path", "filePath"] as const

export interface ProjectMemorySwitches {
  readonly nudge: boolean
  readonly recall: boolean
}

export interface ProjectMemoryNudgeOptions {
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  readonly switches: () => ProjectMemorySwitches
  readonly fallbackCwd: () => string
  readonly env?: Record<string, string | undefined>
  readonly logger?: Pick<ComponentLogger, "warn">
}

interface SessionScope {
  readonly cwd: string
  readonly resolver: ProjectIdentityResolver
  readonly nudged: Set<string>
  readonly touched: ProjectIdentity[]
  merged?: { readonly key: string; readonly documents: readonly RecallDocument[] }
}

export interface ProjectMemoryScope {
  register(pi: SenpiExtensionAPI): void
  touchedMostRecentFirst(sessionId: string): readonly ProjectIdentity[]
  recallDocuments(sessionId: string): Promise<readonly RecallDocument[]>
  sourceFor(sessionId: string, path: string): string | undefined
}

export function createProjectMemoryScope(options: ProjectMemoryNudgeOptions): ProjectMemoryScope {
  const sessions = new Map<string, SessionScope>()
  const corpora = new Map<string, RecallCorpusCache>()

  function scopeFor(sessionId: string, eventCtx: unknown): SessionScope {
    const cwd = isRecord(eventCtx) && typeof eventCtx.cwd === "string" && eventCtx.cwd.length > 0 ? eventCtx.cwd : options.fallbackCwd()
    const existing = sessions.get(sessionId)
    if (existing?.cwd === cwd) return existing
    const created: SessionScope = {
      cwd,
      resolver: createProjectIdentityResolver({ sessionCwd: cwd, ...(options.env === undefined ? {} : { env: options.env }) }),
      nudged: new Set(),
      touched: [],
    }
    sessions.set(sessionId, created)
    return created
  }

  async function corpusOf(project: ProjectIdentity) {
    const dir = project.identity.paths.repo
    let cache = corpora.get(dir)
    if (cache === undefined) {
      cache = new RecallCorpusCache()
      corpora.set(dir, cache)
    }
    return await cache.load(new GitMemoryRepo({ dir, agentId: project.identity.id }))
  }

  async function notesOf(project: ProjectIdentity): Promise<readonly RecallDocument[]> {
    return (await corpusOf(project)).documents
  }

  // The merged array keeps its identity while no project's HEAD moved, so the recall memos keyed
  // on a document array (BM25 index, CJK share) are built once per revision, not once per prompt.
  async function recallDocuments(sessionId: string): Promise<readonly RecallDocument[]> {
    const scope = sessions.get(sessionId)
    if (scope === undefined || !options.switches().recall) return []
    const projects = scope.touched.slice(0, PROJECT_MEMORY_RECALL_MAX_PROJECTS)
    const corpora = await Promise.all(projects.map(async (project) => ({ project, corpus: await corpusOf(project) })))
    const key = corpora.map(({ project, corpus }) => `${project.identity.id}@${corpus.revision ?? "none"}`).join(",")
    if (scope.merged?.key === key) return scope.merged.documents
    const documents = corpora.flatMap(({ project, corpus }) => qualifyProjectDocuments(project.identity.id, corpus.documents))
    scope.merged = { key, documents }
    return documents
  }

  function sourceFor(sessionId: string, path: string): string | undefined {
    const parsed = parseProjectMemoryPath(path)
    if (parsed === undefined) return undefined
    const project = sessions.get(sessionId)?.touched.find((entry) => entry.identity.id === parsed.identityId)
    return project === undefined ? undefined : join(project.identity.paths.repo, parsed.path)
  }

  function register(pi: SenpiExtensionAPI): void {
  pi.on("tool_result", async (payload: unknown, eventCtx: unknown) => {
    const touchedPath = touchedPathOf(payload)
    if (touchedPath === undefined) return undefined
    const sessionId = sessionIdFrom(eventCtx)
    if (sessionId === undefined) return undefined
    const context = options.resolveContext(sessionId)
    if (context === undefined) return undefined
    const switches = options.switches()
    if (!switches.nudge && !switches.recall) {
      revokeProjectMemoryReads(context)
      return undefined
    }

    const scope = scopeFor(sessionId, eventCtx)
    const project = scope.resolver.forPath(touchedPath)
    if (project === undefined || project.identity.id === context.identity) return undefined
    grantProjectMemoryRead(context, project.identity.paths.repo)
    const index = scope.touched.findIndex((entry) => entry.identity.id === project.identity.id)
    if (index >= 0) scope.touched.splice(index, 1)
    scope.touched.unshift(project)

    if (!switches.nudge || scope.nudged.has(project.identity.id)) return undefined
    let notes: readonly RecallDocument[]
    try {
      notes = await notesOf(project)
    } catch (error) {
      // Advice only: a project repo that cannot be read leaves the tool result untouched and is retried on the next touch.
      options.logger?.warn("omo-senpi project memory nudge skipped", {
        project: project.projectDir,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
    scope.nudged.add(project.identity.id)
    if (notes.length === 0) return undefined
    const content = isRecord(payload) && Array.isArray(payload.content) ? payload.content : []
    return { content: [...content, { type: "text", text: formatProjectMemoryNudge(project, notes), audience: "model" }] }
  })

  pi.on("session_compact", (payload: unknown, eventCtx: unknown) => {
    if (isRecord(payload) && payload.accepted === false) return
    const sessionId = sessionIdFrom(eventCtx)
    if (sessionId !== undefined) sessions.get(sessionId)?.nudged.clear()
  })

  pi.on("session_shutdown", (_payload: unknown, eventCtx: unknown) => {
    const sessionId = sessionIdFrom(eventCtx)
    if (sessionId === undefined) return
    sessions.delete(sessionId)
    const context = options.resolveContext(sessionId)
    if (context !== undefined) revokeProjectMemoryReads(context)
  })
  }

  return {
    register,
    touchedMostRecentFirst: (sessionId) => sessions.get(sessionId)?.touched ?? [],
    recallDocuments,
    sourceFor,
  }
}

export function formatProjectMemoryNudge(project: ProjectIdentity, notes: readonly RecallDocument[]): string {
  const shown = notes.slice(0, PROJECT_MEMORY_NUDGE_MAX_NOTES)
  const lines = [
    "",
    `[Project memory: ${project.projectDir}]`,
    "This project keeps its own memory from earlier sessions. Consult it actively: read any note below that bears on the work before relying on assumptions.",
    `Notes live under ${project.identity.paths.repo}; open one with the read tool at that directory plus the path shown.`,
    ...shown.map((note) => `- ${note.path}: ${redactSecretLikeMaterial(note.description)}`),
    ...(notes.length > shown.length ? [`- +${notes.length - shown.length} more`] : []),
  ]
  return lines.join("\n")
}

function touchedPathOf(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.isError === true || typeof payload.toolName !== "string") return undefined
  if (!TOUCH_TOOL_NAMES.has(payload.toolName.trim().toLowerCase())) return undefined
  const input = payload.input
  if (!isRecord(input)) return undefined
  for (const name of PATH_ARGUMENT_NAMES) {
    const value = input[name]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

const mergedCorpora = new WeakMap<readonly RecallDocument[], WeakMap<readonly RecallDocument[], readonly RecallDocument[]>>()

/** The session's own notes plus its touched projects', as one stable array per pair of inputs (the recall memos are keyed on it). */
export function withProjectDocuments(own: readonly RecallDocument[], projects: readonly RecallDocument[]): readonly RecallDocument[] {
  if (projects.length === 0) return own
  let byProjects = mergedCorpora.get(own)
  if (byProjects === undefined) {
    byProjects = new WeakMap()
    mergedCorpora.set(own, byProjects)
  }
  const cached = byProjects.get(projects)
  if (cached !== undefined) return cached
  const merged = [...own, ...projects]
  byProjects.set(projects, merged)
  return merged
}

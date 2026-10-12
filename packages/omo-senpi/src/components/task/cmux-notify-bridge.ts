import { spawn } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, join } from "node:path"

import { completionMessageLines, type ParentNotifierMessage, type TaskStatus } from "@oh-my-opencode/senpi-task"
import { log } from "@oh-my-opencode/utils"

export const CMUX_NOTIFY_BODY_MAX_CHARS = 1000

const STATUS_TITLES: Readonly<Partial<Record<TaskStatus, string>>> = {
  completed: "OMO task completed",
  error: "OMO task failed",
  lost: "OMO task lost",
}

const MIXED_STATUS_TITLE = "OMO background tasks"
const TRUNCATION_MARKER = "(truncated)"

export type CmuxNotifyBridge = {
  notify(message: ParentNotifierMessage): void
}

export type CmuxNotifyDiagnostic =
  | { readonly kind: "spawn_error"; readonly message: string }
  | { readonly kind: "nonzero_exit"; readonly code: number }

export type CmuxNotifyProcess = {
  readonly onError: (listener: (error: Error) => void) => void
  readonly onClose: (listener: (code: number | null) => void) => void
  readonly unref: () => void
}

export type CmuxNotifyBridgeDeps = {
  readonly platform?: NodeJS.Platform
  readonly pathLookup?: (binaryName: string) => string | null
  readonly spawnProcess?: (cmuxPath: string, args: readonly string[]) => CmuxNotifyProcess
  readonly onDiagnostic?: (diagnostic: CmuxNotifyDiagnostic) => void
  readonly schedule?: (run: () => void) => void
}

/**
 * Best-effort native `cmux notify` for Senpi background-task completions on macOS (#6580; bridge
 * from #7386). Gated to darwin hosts with a resolvable cmux binary; every failure is logged and
 * swallowed so a broken cmux can never affect task completion itself.
 */
export function createCmuxNotifyBridge(deps: CmuxNotifyBridgeDeps = {}): CmuxNotifyBridge {
  const platform = deps.platform ?? process.platform
  const pathLookup = deps.pathLookup ?? findExecutableOnPath
  const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess
  const onDiagnostic = deps.onDiagnostic ?? logDiagnostic
  const schedule = deps.schedule ?? queueMicrotask
  let cachedCmuxPath: string | undefined
  // Completions delivered by one batched flush arrive as separate notify calls in the same tick;
  // they are merged into one notification so a fan-out does not raise one toast per child.
  let pending: ParentNotifierMessage["details"][number][] | undefined

  return {
    notify(message: ParentNotifierMessage): void {
      if (platform !== "darwin" || message.details.length === 0) return
      if (pending !== undefined) {
        pending.push(...message.details)
        return
      }
      pending = [...message.details]
      schedule(() => {
        const details = pending ?? []
        pending = undefined
        send(details)
      })
    },
  }

  function send(details: ParentNotifierMessage["details"]): void {
    try {
      const cmuxPath = resolveCmuxPath()
      if (cmuxPath === null) return
      const child = spawnProcess(cmuxPath, buildNotifyArgs(details))
      child.onError((error) => onDiagnostic({ kind: "spawn_error", message: error.message }))
      child.onClose((code) => {
        if (code !== 0 && code !== null) onDiagnostic({ kind: "nonzero_exit", code })
      })
      child.unref()
    } catch (error) {
      log("omo-senpi cmux notify failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  function resolveCmuxPath(): string | null {
    if (cachedCmuxPath !== undefined) return cachedCmuxPath
    const resolved = pathLookup("cmux")
    if (resolved !== null) cachedCmuxPath = resolved
    return resolved
  }
}

function buildNotifyArgs(details: ParentNotifierMessage["details"]): readonly string[] {
  return ["notify", "--title", notificationTitle(details), "--body", notificationBody(details)]
}

function notificationTitle(details: ParentNotifierMessage["details"]): string {
  const first = details[0]
  if (first === undefined || details.some((detail) => detail.status !== first.status)) return MIXED_STATUS_TITLE
  return STATUS_TITLES[first.status] ?? MIXED_STATUS_TITLE
}

function notificationBody(details: ParentNotifierMessage["details"]): string {
  const body = completionMessageLines(details).join("\n")
  if (body.length <= CMUX_NOTIFY_BODY_MAX_CHARS) return body
  const limit = CMUX_NOTIFY_BODY_MAX_CHARS - TRUNCATION_MARKER.length
  const end = isHighSurrogate(body.charCodeAt(limit - 1)) ? limit - 1 : limit
  return `${body.slice(0, end)}${TRUNCATION_MARKER}`
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function defaultSpawnProcess(cmuxPath: string, args: readonly string[]): CmuxNotifyProcess {
  const child = spawn(cmuxPath, [...args], { stdio: "ignore", detached: true, windowsHide: true })
  return {
    onError: (listener) => {
      child.on("error", listener)
    },
    onClose: (listener) => {
      child.on("close", listener)
    },
    unref: () => child.unref(),
  }
}

function logDiagnostic(diagnostic: CmuxNotifyDiagnostic): void {
  switch (diagnostic.kind) {
    case "spawn_error":
      log("omo-senpi cmux notify spawn failed", { error: diagnostic.message })
      return
    case "nonzero_exit":
      log("omo-senpi cmux notify exited non-zero", { code: diagnostic.code })
      return
    default:
      return assertNever(diagnostic)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled cmux diagnostic: ${JSON.stringify(value)}`)
}

function findExecutableOnPath(binaryName: string): string | null {
  const pathValue = process.env.PATH
  if (!pathValue) return null
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, binaryName)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

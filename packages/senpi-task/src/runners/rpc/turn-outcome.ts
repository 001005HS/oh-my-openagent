import type { AgentSessionEvent } from "@code-yeongyu/senpi"

import type { RunnerOutcome } from "../in-process/child-handle"
import type { ChildExitOutcome } from "../types"
import { mapExitOutcomeToError } from "./exit-mapping"

export function promptFailureOutcome(error: unknown): RunnerOutcome {
  const message = error instanceof Error ? error.message : String(error)
  return { status: "error", failure: { kind: "child-prompt-failed", message, cause: error } }
}

export function agentEndOutcome(
  event: Extract<AgentSessionEvent, { readonly type: "agent_end" }>,
  baseline: string | undefined,
  observedText: string | undefined,
): RunnerOutcome {
  const messages: readonly unknown[] = Array.isArray(event.messages) ? event.messages : []
  let assistant: Record<string, unknown> | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isAssistantRecord(message)) {
      assistant = message
      break
    }
  }
  const stopReason = assistant === undefined ? undefined : readString(assistant.stopReason)
  const errorMessage = assistant === undefined ? undefined : readString(assistant.errorMessage)
  const aborted = readBooleanField(event, "aborted")
  const replaced = aborted ? replacementCause(event) : undefined
  if (replaced !== undefined) return replaced
  if (aborted || stopReason === "error" || stopReason === "aborted") {
    return {
      status: "error",
      failure: {
        kind: "child-turn-failed",
        message: errorMessage ?? `RPC child turn ended with stopReason "${stopReason ?? "aborted"}"`,
      },
    }
  }
  const messageText = assistant === undefined ? undefined : extractAssistantText(assistant)
  const final = messageText ?? (observedText !== baseline ? observedText : undefined)
  if (final !== undefined && final.length > 0) return { status: "completed", finalResponse: final }
  return {
    status: "error",
    failure: { kind: "child-turn-failed", message: errorMessage ?? "RPC child turn produced no assistant output" },
  }
}

/**
 * A host that replaces a busy session (new_session, fork, switch_session) aborts its turn first and names
 * the replacement on that agent_end (senpi#3357). The child did not ask for that stop: it is an interrupt
 * the parent must hear about, resumable with task_send, never a failed turn.
 */
function replacementCause(event: unknown): RunnerOutcome | undefined {
  const cause = isRecord(event) ? event.abortCause : undefined
  if (!isRecord(cause) || cause.kind !== "session_replaced") return undefined
  const by = readString(cause.reason)
  const target = readString(cause.targetSessionId)
  return {
    status: "interrupted",
    cause: "session_replaced",
    message:
      `The child's session was replaced${by === undefined ? "" : ` (${by})`}${target === undefined ? "" : ` by ${target}`}, which stopped its running turn. Use task_send to continue it in the new session.`,
  }
}

export function exitTurnOutcome(exit: ChildExitOutcome, finalText: string | undefined): RunnerOutcome {
  const processExit = exit.facts.pid !== undefined && exit.kind !== "spawn_error"
    ? { exit: { kind: exit.kind, code: exit.facts.code, signal: exit.facts.signal } }
    : {}
  if (exit.kind === "clean" && finalText !== undefined && finalText.length > 0) {
    return { status: "completed", finalResponse: finalText }
  }
  if (exit.kind === "clean") {
    return {
      status: "error",
      failure: { kind: "child-turn-failed", message: "RPC child exited without assistant output", ...processExit },
    }
  }
  const facts = mapExitOutcomeToError(exit, { alreadyTerminal: false })
  return {
    status: "error",
    failure: { kind: "child-prompt-failed", message: facts?.error_message ?? "RPC child terminated abnormally", ...processExit },
    ...(facts?.killed === true ? { killed: true } : {}),
  }
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined
  }
  const text = message.content
    .filter((part: unknown): part is { type: "text"; text: string } => isTextPart(part))
    .map((part) => part.text)
    .join("")
  return text.length > 0 ? text : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAssistantRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.role === "assistant"
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function readBooleanField(value: unknown, key: string): boolean {
  return isRecord(value) && value[key] === true
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return isRecord(part) && part.type === "text" && typeof part.text === "string"
}

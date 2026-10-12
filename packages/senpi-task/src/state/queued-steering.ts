import type { TaskRecord } from "./types"
import { markRecordLostForReconciliation } from "./transitions"

export function withDroppedSteeringNotice(message: string, count: number): string
export function withDroppedSteeringNotice(message: string | undefined, count: number): string | undefined
export function withDroppedSteeringNotice(message: string | undefined, count: number): string | undefined {
  if (count === 0) return message
  const notice = `${count} queued message${count === 1 ? " was" : "s were"} not delivered. Resend ${count === 1 ? "it" : "them"} to a new task.`
  return message?.endsWith(notice) === true ? message : [message, notice].filter(Boolean).join("\n")
}
export function withUnreachedSteeringNotice(message: string | undefined, count: number): string | undefined {
  if (count === 0) return message
  const notice = `${count} message${count === 1 ? "" : "s"} sent while the task was recovering may not have reached it before it finished. Send ${count === 1 ? "it" : "them"} again with task_send if ${count === 1 ? "it still applies" : "they still apply"}.`
  return message?.endsWith(notice) === true ? message : [message, notice].filter(Boolean).join("\n")
}
/** A terminal turn's later queued continuation owes its own terminal result when its target ends. */
export function endDroppedSteering(record: TaskRecord, timestamp: string, count: number): TaskRecord {
  const error_message = withDroppedSteeringNotice(
    record.status === "completed" ? "The task finished; its continuation is no longer available."
      : record.error_message ?? "Task target is no longer available.",
    count,
  )
  if (record.status === "completed" || record.status === "error" || record.status === "interrupted") {
    return {
      ...record, status: "error", killed: true, failure_kind: "suspended_unresumable",
      error_message, updated_at: timestamp, terminal_at: timestamp,
      notify_on_terminal: true,
      notification: { ...record.notification, run_epoch: record.notification.run_epoch + 1 },
    }
  }
  return markRecordLostForReconciliation(record, { timestamp, error_message }).record
}

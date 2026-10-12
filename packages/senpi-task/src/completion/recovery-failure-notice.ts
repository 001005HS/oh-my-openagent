import { userActionNotice } from "@oh-my-opencode/utils"
import type { TaskRecord } from "../state"

const REASONS: Readonly<Record<string, string>> = {
  model_unavailable: "its selected model is unavailable",
  tools_unavailable: "the tools needed to continue are unavailable",
  spawn_spec_unavailable: "its saved launch instructions are unavailable",
  transcript_unavailable: "its saved conversation is unavailable",
  host_incompatible: "the installed task runner cannot reopen its saved conversation",
  store_index_unavailable: "its saved task data could not be accessed",
  isolated_not_revivable: "its separate checkout could not be restored safely",
  capacity: "there was no room to resume it before automatic retries ended",
}

/** Plain recovery failure shared by the record and its one terminal completion. Raw causes stay in events. */
export function recoveryFailureNotice(
  record: Pick<TaskRecord, "description" | "task_summary" | "revival_deferred_reason" | "suspension_reason">,
  confirmedStop: boolean,
): string {
  const task = record.description ?? record.task_summary ?? "Background task"
  const reason = REASONS[record.revival_deferred_reason ?? record.suspension_reason ?? ""]
    ?? "its interrupted session could not be reopened after automatic retries"
  const retry = `Retry "${task}" with the task tool using its original request.`
  return userActionNotice(
    confirmedStop
      ? `"${task}" stopped because ${reason}.`
      : `"${task}" could not be recovered because ${reason}. The earlier run may still be running; stopping it is being retried automatically.`,
    confirmedStop
      ? retry
      : `Check whether it already changed anything before retrying, to avoid doing the work twice. ${retry}`,
  )
}

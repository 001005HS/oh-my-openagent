function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function describeSessionError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return String(error)

  const record = error as Record<string, unknown>
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined
  const message = textField(record, "message") ?? (data ? textField(data, "message") : undefined)
  const name = textField(record, "name")
  const code = textField(record, "code")
  if (message) {
    if (name) return `${name}: ${message}`
    return code ? `${message} (${code})` : message
  }
  if (name) return name
  try {
    return JSON.stringify(error)
  } catch {
    return Object.prototype.toString.call(error)
  }
}

export function toSessionError(error: unknown): Error {
  if (error instanceof Error) return error
  const wrapped = new Error(describeSessionError(error), { cause: error })
  const name = error && typeof error === "object" ? textField(error as Record<string, unknown>, "name") : undefined
  if (name) wrapped.name = name
  return wrapped
}

export type SkippedSession = { readonly id: string; readonly reason: string }

export function formatSkippedSessions(skipped: readonly SkippedSession[]): string {
  if (skipped.length === 0) return ""
  const noun = skipped.length === 1 ? "session" : "sessions"
  const entries = skipped.map((entry) => `${entry.id} (${entry.reason})`).join(", ")
  return `\n\nSkipped ${skipped.length} ${noun} that could not be read: ${entries}`
}

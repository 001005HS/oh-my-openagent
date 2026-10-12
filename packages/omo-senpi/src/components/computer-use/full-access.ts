/** The slice of the extension API that tells the session's permission preset. */
export interface PermissionPresetSource {
  getFlag(name: string): boolean | string | undefined
  getSettings?(): unknown
}

export const PERMISSION_PRESET_FLAG = "permission-preset"
const FULL_ACCESS = "full-access"

/**
 * True when the session runs with the `full-access` permission preset (#10022). Same precedence as
 * senpi's permission system: the `permission-preset` flag (a host's session mode, or the CLI), then
 * `permissionPreset` from the merged settings.
 */
export function isFullAccess(source: PermissionPresetSource): boolean {
  const flag = source.getFlag(PERMISSION_PRESET_FLAG)
  if (typeof flag === "string") return flag === FULL_ACCESS
  const settings = source.getSettings?.()
  return (
    typeof settings === "object" &&
    settings !== null &&
    (settings as { readonly permissionPreset?: unknown }).permissionPreset === FULL_ACCESS
  )
}

/**
 * Registers the read-only view of the `permission-preset` flag and returns the full-access check. senpi's
 * permission system owns the flag; getFlag only answers for flags the calling extension registered.
 */
export function watchFullAccess(
  pi: PermissionPresetSource & {
    registerFlag(name: string, options: { description?: string; type: "boolean" | "string" }): void
  },
): () => boolean {
  pi.registerFlag(PERMISSION_PRESET_FLAG, { description: "Permission preset (owned by the permission system)", type: "string" })
  return () => isFullAccess(pi)
}

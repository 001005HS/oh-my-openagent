/** The slice of the extension API that tells the session's permission preset. */
export interface PermissionPresetSource {
  getFlag?(name: string): boolean | string | undefined
}

export const PERMISSION_PRESET_FLAG = "permission-preset"
const FULL_ACCESS = "full-access"

/**
 * True only when this session's `permission-preset` flag is explicitly `full-access` (#10022): a host's
 * session mode (the desktop app's full access, through setPermissionPreset) or the CLI flag. Settings are
 * deliberately not consulted: senpi's permission system can enforce a different preset than the merged
 * settings show (an untrusted project), and background task children inherit settings but no flag, so a
 * settings fallback would skip the confirm where the user never chose full access for this session.
 */
export function isFullAccess(source: PermissionPresetSource): boolean {
  return source.getFlag?.(PERMISSION_PRESET_FLAG) === FULL_ACCESS
}

/**
 * Registers the read-only view of the `permission-preset` flag and returns the full-access check. senpi's
 * permission system owns the flag; getFlag only answers for flags the calling extension registered. A host
 * without flags (a minimal test host) never counts as full access.
 */
export function watchFullAccess(
  pi: PermissionPresetSource & {
    registerFlag?(name: string, options: { description?: string; type: "boolean" | "string" }): void
  },
): () => boolean {
  pi.registerFlag?.(PERMISSION_PRESET_FLAG, { description: "Permission preset (owned by the permission system)", type: "string" })
  return () => isFullAccess(pi)
}

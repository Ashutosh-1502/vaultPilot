/**
 * Named state keys used across globalState, workspaceState, SecretStorage,
 * and VS Code context keys.
 *
 * IR recommendation #3 — centralizes string literals so they aren't typo-prone
 * across stories. Add new keys here as features land.
 */

export const GLOBAL_STATE = {
  /** FR-43: set when the user chose "Not now" at end of first-run Drive opt-in. */
  FIRST_RUN_DRIVE_DECLINED: 'vaultpilot.firstRunDriveDeclined',
  /** Epic 2: list of archived fingerprints (rendered in Archived Vaults view). */
  ARCHIVED_PROJECTS_INDEX: 'vaultpilot.archivedProjectsIndex',
  /** FR-5: highest vault format version this extension instance has written. */
  HIGHEST_FORMAT_VERSION_WRITTEN: 'vaultpilot.highestFormatVersionWritten',
  /** Set when the user clicks "Don't show again" on the .env auto-detect import notification. */
  ENV_IMPORT_DONT_SUGGEST: 'vaultpilot.envImportDontSuggest',
  /** Epic 3 dashboard polish — last successful Drive backup metadata. */
  DRIVE_LAST_BACKUP: 'vaultpilot.driveLastBackup',
  /** Local-file backup — last successful run metadata (path, timestamp, bytes). */
  LOCAL_LAST_BACKUP: 'vaultpilot.localLastBackup',
} as const;

export const WORKSPACE_STATE = {
  /**
   * FR-9: prefix for "user dismissed the Add Credentials? prompt" per
   * fingerprint. Combine with the fingerprint string:
   *   `${WORKSPACE_STATE.ADD_CTA_DISMISSED_PREFIX}${fingerprint}` → boolean.
   */
  ADD_CTA_DISMISSED_PREFIX: 'vaultpilot.dismissed.',
} as const;

export const SECRET_STORAGE = {
  /** FR-4: cached derived encryption key (base64-encoded Buffer). */
  DERIVED_KEY: 'vaultpilot.derivedKey',
  /** FR-33: Drive OAuth refresh token (Epic 3 consumer). */
  DRIVE_REFRESH_TOKEN: 'vaultpilot.driveRefreshToken',
} as const;

/**
 * VS Code context keys (set via `vscode.commands.executeCommand('setContext', ...)`).
 * Used by `when` clauses in package.json contributions (e.g., viewsWelcome).
 */
export const CONTEXT_KEYS = {
  /** True when at least one vault entry exists on disk (or session is unlocked). */
  VAULT_EXISTS: 'vaultpilot.vaultExists',
  /** True when the Archived Vaults view should be visible. */
  ARCHIVED_VIEW_VISIBLE: 'vaultpilot.archivedViewVisible',
  /** True when the keychain fallback (in-memory) is active per FR-49. */
  KEYCHAIN_FALLBACK_ACTIVE: 'vaultpilot.keychainFallbackActive',
} as const;

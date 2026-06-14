import type { VscodeHost } from '../vscode-host';

/**
 * VaultPilot settings — typed wrapper over `workspace.getConfiguration('vaultpilot')`.
 *
 * Story 1.3 / 1.9 — read settings at call sites that need them. Settings are
 * re-read on every `read()`; callers can cache short-lived but should not
 * cache across user interactions (the user may have just changed a value).
 */
export interface VaultPilotSettings {
  /** FR-26: clipboard auto-clear timeout in seconds. */
  readonly clipboardTimeout: number;
  /** FR-4: how long the derived key stays cached before re-prompt (seconds). */
  readonly passphraseCacheDuration: number;
  /** FR-35: name of the canonical backup file in Drive appdata. */
  readonly driveBackupFolderName: string;
  /** FR-32: whether Drive backup is enabled. */
  readonly driveBackupEnabled: boolean;
  /**
   * Google OAuth 2.0 client ID for the Drive integration (Epic 3, FR-33).
   * User-supplied (see README). Empty string means Drive features are
   * unavailable until the user configures their own client ID at
   * https://console.cloud.google.com/.
   */
  readonly driveOAuthClientId: string;
  /**
   * Google OAuth 2.0 client secret. Required by Google's token endpoint for
   * "Desktop app" clients alongside PKCE — without it, token exchange fails
   * with `invalid_request`. Despite the name, this is not actually secret
   * for desktop clients (it's visible to anyone with the client ID in the
   * Cloud Console).
   */
  readonly driveOAuthClientSecret: string;
  /**
   * Optional override for the local backup parent folder. Empty string means
   * "use the extension's globalStorage path" — that default lets Restore from
   * Local find the backup automatically without the user remembering where they
   * chose to put it.
   */
  readonly localBackupFolder: string;
  /** Verbose OutputChannel logging. */
  readonly verboseLogging: boolean;
}

const DEFAULTS: VaultPilotSettings = {
  clipboardTimeout: 30,
  passphraseCacheDuration: 3600,
  driveBackupFolderName: 'vaultpilot-backup',
  driveBackupEnabled: false,
  driveOAuthClientId: '',
  driveOAuthClientSecret: '',
  localBackupFolder: '',
  verboseLogging: false,
};

export function readSettings(host: VscodeHost): VaultPilotSettings {
  const config = host.getConfiguration('vaultpilot');
  return {
    clipboardTimeout: config.get<number>('clipboardTimeout', DEFAULTS.clipboardTimeout),
    passphraseCacheDuration: config.get<number>(
      'passphraseCacheDuration',
      DEFAULTS.passphraseCacheDuration,
    ),
    driveBackupFolderName: config.get<string>(
      'driveBackupFolderName',
      DEFAULTS.driveBackupFolderName,
    ),
    driveBackupEnabled: config.get<boolean>('driveBackupEnabled', DEFAULTS.driveBackupEnabled),
    driveOAuthClientId: config.get<string>(
      'driveOAuthClientId',
      DEFAULTS.driveOAuthClientId,
    ),
    driveOAuthClientSecret: config.get<string>(
      'driveOAuthClientSecret',
      DEFAULTS.driveOAuthClientSecret,
    ),
    localBackupFolder: config.get<string>(
      'localBackupFolder',
      DEFAULTS.localBackupFolder,
    ),
    verboseLogging: config.get<boolean>('verboseLogging', DEFAULTS.verboseLogging),
  };
}

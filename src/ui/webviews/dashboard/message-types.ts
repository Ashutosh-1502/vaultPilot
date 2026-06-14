import type { Credential, CredentialType } from '../../../credentials/credential';

/**
 * Discriminated-union message protocol for the Dashboard webview.
 * Both directions use the same `kind` tag pattern; the consumer narrows by it.
 */

// Webview → Extension
export type WebviewRequest =
  | { readonly kind: 'list-projects' }
  | { readonly kind: 'load-project'; readonly fingerprint: string }
  | { readonly kind: 'unlock-project'; readonly fingerprint: string }
  | { readonly kind: 'copy'; readonly credentialId: string; readonly fingerprint: string }
  | { readonly kind: 'reveal'; readonly credentialId: string; readonly fingerprint: string }
  | { readonly kind: 'edit'; readonly credentialId: string; readonly fingerprint: string }
  | { readonly kind: 'delete'; readonly credentialId: string; readonly fingerprint: string }
  | { readonly kind: 'add-credential'; readonly fingerprint: string }
  | { readonly kind: 'create-new-vault' }
  | { readonly kind: 'sync-to-drive' }
  | { readonly kind: 'remove-drive-backup' }
  | { readonly kind: 'refresh-drive-backup' }
  | { readonly kind: 'inspect-drive-backup' }
  | { readonly kind: 'local-backup' }
  | { readonly kind: 'refresh-local-backup' }
  | { readonly kind: 'inspect-local-backup' }
  | { readonly kind: 'reveal-local-vault'; readonly fingerprint: string; readonly status: 'active' | 'archived' }
  | { readonly kind: 'download-env'; readonly fingerprint: string }
  | { readonly kind: 'archive-project'; readonly fingerprint: string; readonly displayName: string }
  | { readonly kind: 'unarchive-project'; readonly fingerprint: string; readonly displayName: string }
  | { readonly kind: 'delete-archived'; readonly fingerprint: string; readonly displayName: string }
  | { readonly kind: 'open-vscode-settings' }
  | { readonly kind: 'open-docs'; readonly target: 'readme' | 'changelog' }
  | { readonly kind: 'load-settings' };

// Extension → Webview
export type ExtensionResponse =
  | { readonly kind: 'projects-loaded'; readonly projects: readonly ProjectInfo[] }
  | { readonly kind: 'project-loaded'; readonly credentials: readonly Credential[] }
  | { readonly kind: 'project-needs-unlock'; readonly fingerprint: string }
  | { readonly kind: 'settings-loaded'; readonly settings: DashboardSettings }
  | { readonly kind: 'drive-backup-info'; readonly info: DriveBackupSummary | null; readonly error: string | null }
  | { readonly kind: 'drive-backup-contents'; readonly inspection: DriveBackupContents | null; readonly error: string | null }
  | { readonly kind: 'local-backup-vaults'; readonly vaults: ReadonlyArray<LocalBackupVault> | null; readonly folder: string | null; readonly error: string | null }
  | { readonly kind: 'changed' }
  | { readonly kind: 'reveal-result'; readonly credentialId: string; readonly value: string };

export interface DriveBackupContents {
  readonly fileBytes: number;
  readonly projects: ReadonlyArray<{
    readonly fingerprint: string;
    readonly displayName: string;
    readonly status: 'active' | 'archived';
    readonly unlockState: 'unlocked' | 'locked';
    readonly credentialNames: readonly string[];
  }>;
}

export interface DriveBackupSummary {
  readonly fileId: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly md5: string | null;
  readonly modifiedTime: string | null;
}

export type ProjectStatus = 'active' | 'archived';

export interface ProjectInfo {
  readonly fingerprint: string;
  readonly displayName: string;
  readonly gitRemoteUrl: string | null;
  readonly fingerprintSource: string;
  readonly lastKnownPath: string;
  readonly status: ProjectStatus;
  readonly created?: string;
  /**
   * Number of credentials in this project's vault, IF we've decrypted it this
   * session (used for the stats footer). Undefined when not yet unlocked.
   */
  readonly knownCount?: number;
}

export interface LocalBackupVault {
  readonly fingerprint: string;
  readonly displayName: string;
  readonly status: 'active' | 'archived';
  readonly gitRemoteUrl: string | null;
  readonly hasZip: boolean;
}

export interface DashboardSettings {
  readonly driveBackupEnabled: boolean;
  readonly driveLastBackupAt: string | null;
  readonly localLastBackup: {
    readonly uploadedAt: string;
    readonly folder: string;
    readonly bytes: number;
    readonly projectsCopied: number;
    readonly archivedCopied: number;
  } | null;
  /** Last successful backup details, persisted to globalState by the backup command. */
  readonly driveLastBackup: {
    readonly bytes: number;
    readonly md5: string;
    readonly fileId: string;
    readonly fileName: string;
  } | null;
  readonly vaultRoot: string;
  readonly version: string;
  readonly autoLockOnIdle: boolean;
}

export interface CredentialTypeOption {
  readonly value: CredentialType;
  readonly label: string;
}

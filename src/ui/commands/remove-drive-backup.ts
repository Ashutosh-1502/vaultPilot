import * as vscode from 'vscode';

import { DriveClient } from '../../drive/client';
import { refreshAccessToken } from '../../drive/oauth';
import { errorToUserMessage } from '../error-to-message';
import { readSettings } from '../../settings/settings';
import { defaultHost } from '../../vscode-host';
import { GLOBAL_STATE } from '../../settings/state-keys';
import type { SecretStorageWrapper } from '../../keychain/secret-storage';

/**
 * Permanently delete the VaultPilot backup file(s) from the user's Drive
 * appdata folder.
 *
 * Strong modal confirmation. On success:
 *   - All `vaultpilot-backup*` files in appdata are deleted (handles
 *     leftover `.uploading` temp files from a prior failed sync).
 *   - The persisted `DRIVE_LAST_BACKUP` globalState entry is cleared so
 *     the dashboard reflects the change.
 *
 * Does NOT touch the local vault, Drive refresh token, or any non-VaultPilot
 * file in Drive. Safe to re-run if a previous call partially failed.
 */
export async function removeDriveBackupCommand(
  secretStorage: SecretStorageWrapper,
  globalState: vscode.Memento,
): Promise<void> {
  const settings = readSettings(defaultHost);
  if (
    settings.driveOAuthClientId.length === 0 ||
    settings.driveOAuthClientSecret.length === 0
  ) {
    void vscode.window.showErrorMessage(
      'Drive OAuth credentials are not configured. Nothing to remove.',
    );
    return;
  }

  const stored = await secretStorage.getDriveRefreshToken();
  if (!stored.ok || stored.value === null) {
    void vscode.window.showWarningMessage(
      'No Drive refresh token. Either you never backed up, or the token was already revoked.',
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    'Permanently delete your VaultPilot backup from Google Drive?',
    {
      modal: true,
      detail:
        'This removes the encrypted backup file from your Drive appdata folder. Your local vault is not affected. If you have not also exported your credentials, you will not be able to restore them from this backup again.',
    },
    'Delete from Drive',
  );
  if (confirm !== 'Delete from Drive') return;

  const tokenResult = await refreshAccessToken({
    clientId: settings.driveOAuthClientId,
    clientSecret: settings.driveOAuthClientSecret,
    refreshToken: stored.value,
  });
  if (!tokenResult.ok) {
    void vscode.window.showErrorMessage(errorToUserMessage(tokenResult.error));
    return;
  }

  const client = new DriveClient(
    tokenResult.value.accessToken,
    tokenResult.value.expiresIn,
    settings.driveOAuthClientId,
    settings.driveOAuthClientSecret,
    secretStorage,
  );

  // Delete the canonical file, then any leftover `.uploading` from a prior
  // interrupted backup. Errors on the temp file are non-fatal.
  const canonicalName = settings.driveBackupFolderName;
  let deletedCount = 0;

  for (const name of [canonicalName, `${canonicalName}.uploading`]) {
    const list = await client.listAppdataFilesByName(name);
    if (!list.ok) {
      if (name === canonicalName) {
        void vscode.window.showErrorMessage(errorToUserMessage(list.error));
        return;
      }
      continue;
    }
    for (const file of list.value) {
      const del = await client.deleteFile(file.id);
      if (del.ok) {
        deletedCount++;
      } else if (name === canonicalName) {
        void vscode.window.showErrorMessage(errorToUserMessage(del.error));
        return;
      }
    }
  }

  await globalState.update(GLOBAL_STATE.DRIVE_LAST_BACKUP, null);

  if (deletedCount === 0) {
    void vscode.window.showInformationMessage(
      'No VaultPilot backup file was found in Drive appdata. Nothing to remove.',
    );
  } else {
    void vscode.window.showInformationMessage(
      `Deleted ${String(deletedCount)} file${deletedCount === 1 ? '' : 's'} from your Drive appdata folder.`,
    );
  }
}

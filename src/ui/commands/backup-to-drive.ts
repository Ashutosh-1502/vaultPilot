import * as vscode from 'vscode';

import { backupToDrive } from '../../drive/backup';
import { DriveClient } from '../../drive/client';
import { authenticate } from '../../drive/auth';
import { errorToUserMessage } from '../error-to-message';
import { readSettings } from '../../settings/settings';
import { defaultHost } from '../../vscode-host';
import { GLOBAL_STATE } from '../../settings/state-keys';
import type { SecretStorageWrapper } from '../../keychain/secret-storage';

export interface DriveBackupInfo {
  readonly uploadedAt: string;
  readonly bytes: number;
  readonly md5: string;
  readonly fileId: string;
  readonly fileName: string;
}

/**
 * Back Up to Drive command (Story 3.2 — FR-34, FR-35, FR-38, FR-50).
 *
 * Gates on `vaultpilot.driveBackupEnabled` (FR-32). If a refresh token is
 * already stored, uses it to mint an access token without re-prompting;
 * otherwise runs the full OAuth flow.
 */
export async function backupToDriveCommand(
  secretStorage: SecretStorageWrapper,
  globalState?: vscode.Memento,
): Promise<void> {
  const settings = readSettings(defaultHost);
  if (!settings.driveBackupEnabled) {
    void vscode.window.showInformationMessage(
      'Drive backup is disabled. Enable `vaultpilot.driveBackupEnabled` in settings first.',
    );
    return;
  }
  if (settings.driveOAuthClientId.length === 0) {
    void vscode.window.showErrorMessage(
      'OAuth client ID not configured. Set `vaultpilot.driveOAuthClientId` in settings (see README).',
    );
    return;
  }
  if (settings.driveOAuthClientSecret.length === 0) {
    void vscode.window.showErrorMessage(
      'OAuth client secret not configured. Set `vaultpilot.driveOAuthClientSecret` in settings. Find it on the same Google Cloud Console page as the client ID.',
    );
    return;
  }

  // Obtain an access token. If a refresh token is cached we still run the
  // full authenticate() — the DriveClient handles 401 silent refresh, but
  // this command's entry point benefits from a clean token state.
  const refreshResult = await secretStorage.getDriveRefreshToken();
  let accessToken: string;
  let expiresIn: number;
  if (refreshResult.ok && refreshResult.value !== null) {
    // Trigger a refresh by constructing the client with an expired access
    // token; the FR-33 silent-refresh on the first call upgrades us.
    accessToken = '';
    expiresIn = -1;
  } else {
    const authResult = await authenticate({
      clientId: settings.driveOAuthClientId,
      clientSecret: settings.driveOAuthClientSecret,
      secretStorage,
    });
    if (!authResult.ok) {
      void vscode.window.showErrorMessage(errorToUserMessage(authResult.error));
      return;
    }
    accessToken = authResult.value.accessToken;
    expiresIn = authResult.value.expiresIn;
  }

  const client = new DriveClient(
    accessToken,
    expiresIn,
    settings.driveOAuthClientId,
    settings.driveOAuthClientSecret,
    secretStorage,
  );

  const progress = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'VaultPilot: Backing up to Google Drive',
      cancellable: false,
    },
    async () => backupToDrive(client, { canonicalName: settings.driveBackupFolderName }),
  );

  if (!progress.ok) {
    void vscode.window.showErrorMessage(errorToUserMessage(progress.error));
    return;
  }

  if (globalState !== undefined) {
    const info: DriveBackupInfo = {
      uploadedAt: new Date().toISOString(),
      bytes: progress.value.bytesUploaded,
      md5: progress.value.md5,
      fileId: progress.value.canonicalFileId,
      fileName: settings.driveBackupFolderName,
    };
    await globalState.update(GLOBAL_STATE.DRIVE_LAST_BACKUP, info);
  }

  void vscode.window.showInformationMessage(
    `Backed up to Drive: ${String(progress.value.bytesUploaded)} bytes.`,
  );
}

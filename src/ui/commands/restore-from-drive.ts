import * as vscode from 'vscode';

import { DriveClient } from '../../drive/client';
import { applyRestoreDecision, prepareRestore, type RestoreDecision } from '../../drive/restore';
import { authenticate } from '../../drive/auth';
import { errorToUserMessage } from '../error-to-message';
import { readSettings } from '../../settings/settings';
import { defaultHost } from '../../vscode-host';
import type { SecretStorageWrapper } from '../../keychain/secret-storage';

/**
 * Restore from Drive command (Story 3.3 — FR-36, FR-37, FR-39, FR-42).
 *
 * Two-phase:
 *   1. Authenticate + download + extract to staging dir + detect local content.
 *   2. If local has content: prompt the FR-37 chooser; apply the choice.
 *
 * Invoked from the Command Palette and from the first-run welcome's
 * "Restore from Drive" button (FR-42 — replacing the Story 1.9 stub).
 */
export async function restoreFromDriveCommand(
  secretStorage: SecretStorageWrapper,
  onChange: () => void,
): Promise<void> {
  const settings = readSettings(defaultHost);
  if (settings.driveOAuthClientId.length === 0) {
    void vscode.window.showErrorMessage(
      'OAuth client ID not configured. Set `vaultpilot.driveOAuthClientId` in settings (see README).',
    );
    return;
  }
  if (settings.driveOAuthClientSecret.length === 0) {
    void vscode.window.showErrorMessage(
      'OAuth client secret not configured. Set `vaultpilot.driveOAuthClientSecret` in settings.',
    );
    return;
  }

  const refreshResult = await secretStorage.getDriveRefreshToken();
  let accessToken = '';
  let expiresIn = -1;
  if (!refreshResult.ok || refreshResult.value === null) {
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

  const prepared = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'VaultPilot: Downloading backup from Google Drive',
      cancellable: false,
    },
    async () => prepareRestore(client, { canonicalName: settings.driveBackupFolderName }),
  );

  if (!prepared.ok) {
    void vscode.window.showErrorMessage(errorToUserMessage(prepared.error));
    return;
  }

  let decision: RestoreDecision = 'overwrite';
  if (prepared.value.localHasContent) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'Overwrite Local',
          description: 'Move existing local vault to a trash sibling, then write the restored content',
          value: 'overwrite' as const,
        },
        {
          label: 'Keep Local (cancel restore)',
          description: 'Discard the downloaded backup; leave local state unchanged',
          value: 'keep-local' as const,
        },
        {
          label: 'Cancel',
          description: 'Discard the downloaded backup; leave local state unchanged',
          value: 'cancel' as const,
        },
      ],
      {
        placeHolder: 'Local vault already has content — what should I do?',
        ignoreFocusOut: true,
      },
    );
    if (pick === undefined) {
      decision = 'cancel';
    } else {
      decision = pick.value;
    }
  }

  const applyResult = await applyRestoreDecision(prepared.value, decision);
  if (!applyResult.ok) {
    void vscode.window.showErrorMessage(errorToUserMessage(applyResult.error));
    return;
  }

  if (decision === 'overwrite') {
    void vscode.window.showInformationMessage(
      'Restored from Drive. Prior local vault moved to ~/.vaultpilot/.trash-<timestamp>/.',
    );
    onChange();
  } else {
    void vscode.window.showInformationMessage('Restore cancelled. Local vault unchanged.');
  }
}

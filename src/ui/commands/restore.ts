import * as vscode from 'vscode';

/**
 * Restore chooser — shows a QuickPick that routes to the right restore source.
 *
 * Drive restore is gated as "Coming Soon" while the Drive flow is being
 * polished; selecting it informs the user and is a no-op. Local restore is
 * always available.
 */
type RestoreSource = 'drive' | 'local';

interface RestoreItem extends vscode.QuickPickItem {
  readonly source: RestoreSource;
  readonly disabled: boolean;
}

export async function restoreCommand(): Promise<void> {
  const items: readonly RestoreItem[] = [
    {
      label: '$(cloud) Restore from Drive',
      description: 'Coming Soon',
      detail: 'Drive backup is temporarily disabled while we polish the OAuth flow.',
      source: 'drive',
      disabled: true,
    },
    {
      label: '$(folder) Restore from Local',
      description: 'Available',
      detail: 'Reveal your local backup folder and recover credentials from the AES-encrypted .env.zip files.',
      source: 'local',
      disabled: false,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'VaultPilot: Restore',
    placeHolder: 'Choose where to restore from',
    ignoreFocusOut: true,
  });
  if (picked === undefined) return;

  if (picked.disabled) {
    void vscode.window.showInformationMessage(
      'Restore from Drive is not yet available. Use Restore from Local for now.',
    );
    return;
  }

  if (picked.source === 'local') {
    await vscode.commands.executeCommand('vaultpilot.restoreFromLocal');
  } else {
    await vscode.commands.executeCommand('vaultpilot.restoreFromDrive');
  }
}

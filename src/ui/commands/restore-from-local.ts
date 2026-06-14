import * as path from 'path';
import * as vscode from 'vscode';

import { BACKUP_FOLDER_NAME, listLocalBackupVaults } from '../../backup/local-backup';
import { readSettings } from '../../settings/settings';
import { defaultHost } from '../../vscode-host';

/**
 * Restore from Local — MVP scope.
 *
 * The local backup writes WinZip-compatible AES-256 ZIPs that no in-process
 * library currently decrypts. So the MVP "restore" is: reveal the backup folder
 * in the OS file manager and tell the user how to recover values manually
 * (open each .env.zip with Keka / 7-Zip / WinZip using the backup passphrase,
 * then re-add credentials via "Set Up New Vault"). A future iteration can
 * add a programmatic ZIP-decrypt path.
 */
export async function restoreFromLocalCommand(globalStoragePath: string): Promise<void> {
  const settings = readSettings(defaultHost);
  const parentDir =
    settings.localBackupFolder.length > 0
      ? settings.localBackupFolder
      : globalStoragePath;
  const backupFolder = path.join(parentDir, BACKUP_FOLDER_NAME);

  const listed = await listLocalBackupVaults(backupFolder);
  if (!listed.ok) {
    void vscode.window.showInformationMessage(
      `No local backup found at ${backupFolder}. Run "VaultPilot: Back Up to Local Folder" first, then come back here.`,
    );
    return;
  }
  if (listed.value.length === 0) {
    void vscode.window.showInformationMessage(
      `Local backup folder exists at ${backupFolder} but contains no vaults yet. Run "VaultPilot: Back Up to Local Folder" first.`,
    );
    return;
  }

  // Reveal the folder so the user can decrypt the .env.zip files with Keka /
  // 7-Zip / WinZip and copy values into a new vault.
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(backupFolder));

  const count = listed.value.length;
  const choice = await vscode.window.showInformationMessage(
    `Opened ${backupFolder} (${String(count)} vault${count === 1 ? '' : 's'}). Open each .env.zip with Keka, 7-Zip, or WinZip using the backup passphrase you set at backup time, then re-add credentials via Set Up New Vault.`,
    'Set Up New Vault',
  );
  if (choice === 'Set Up New Vault') {
    await vscode.commands.executeCommand('vaultpilot.setUpVault');
  }
}

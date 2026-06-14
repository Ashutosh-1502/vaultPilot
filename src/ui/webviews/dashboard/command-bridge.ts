import * as vscode from 'vscode';

/**
 * Forward dashboard inline-action messages to the existing VS Code commands.
 *
 * The dashboard's Reveal / Copy / Edit / Delete / Add buttons don't
 * reimplement business logic — they invoke the same commands the sidebar
 * TreeView uses. This keeps a single code path for credential operations
 * and ensures the dashboard automatically inherits any future changes to
 * those commands (e.g., new confirmation flows).
 */

export interface CommandPayload {
  readonly credentialId: string;
  readonly archivedFingerprint?: string;
}

export async function bridgeCopy(payload: CommandPayload): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.copyCredential', payload);
}

export async function bridgeReveal(payload: CommandPayload): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.revealCredential', payload);
}

export async function bridgeEdit(payload: CommandPayload): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.editCredential', payload);
}

export async function bridgeDelete(payload: CommandPayload): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.deleteCredential', payload);
}

export async function bridgeAddSingle(): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.addCredential');
}

export async function bridgeAddMultiple(): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.addMultipleCredentials');
}

export async function bridgeSetUpVault(): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.setUpVault');
}

export async function bridgeBackUpToDrive(): Promise<void> {
  await vscode.commands.executeCommand('vaultpilot.backUpToDrive');
}

export async function bridgeOpenSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'vaultpilot');
}

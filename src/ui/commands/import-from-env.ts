import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { parseEnvFile } from '../../credentials/env-parser';
import { openAddMultipleWebview, type SeededRow } from '../webviews/add-multi-webview';
import { PROJECTS_DIR, pathExists } from '../../vault/io';
import { resolveFingerprint } from '../../fingerprint/re-link';
import { promptPassphrase } from '../passphrase-prompt';
import { unlockWithPassphrase } from '../../vault/unlock';
import { errorToUserMessage } from '../error-to-message';
import { zeroBuffer } from '../../vault/memory-zero';
import type { SecretStorageWrapper } from '../../keychain/secret-storage';
import type { VaultSession } from '../../vault/vault-session';

/**
 * Import credentials from a `.env` file (Story 1.11 extension, dogfood-
 * driven 2026-06-13 per PRD addendum's revisit clause).
 *
 * UX (2026-06-13 — unified import UI):
 *   1. Pick file (or accept Uri arg from explorer context menu / auto-detect).
 *   2. Parse via `parseEnvFile`.
 *   3. Open the same multi-credential form webview, pre-populated with one
 *      row per env entry (type=env-var-name, name=key, value=value).
 *   4. User can remove rows (deselect), edit values inline, then "Import".
 *   5. Save uses overwrite-by-name semantics so re-importing the same file
 *      updates existing credentials in place.
 */
export async function importFromEnvCommand(
  session: VaultSession,
  onChange: () => void,
  fileUri: vscode.Uri | undefined,
  extensionUri: vscode.Uri,
  secretStorage: SecretStorageWrapper,
): Promise<void> {
  if (!session.isUnlocked()) {
    const handled = await offerUnlockOrSetUp(session, secretStorage);
    if (!handled) return;
    if (!session.isUnlocked()) {
      void vscode.window.showWarningMessage('Vault is still locked. Try again after unlocking.');
      return;
    }
  }

  let target = fileUri;
  if (target === undefined) {
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Select a .env file to import',
      filters: {
        'Env Files': ['env', 'env.local', 'env.production', 'env.development'],
        'All Files': ['*'],
      },
      ...(workspaceUri !== undefined ? { defaultUri: workspaceUri } : {}),
    });
    if (picks === undefined || picks.length === 0) return;
    target = picks[0];
    if (target === undefined) return;
  }

  let content: string;
  try {
    content = await readFile(target.fsPath, 'utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not read ${target.fsPath}: ${String(err)}`);
    return;
  }

  const entries = parseEnvFile(content);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(
      'No environment variables found in this file (skipped blanks, comments, empty values).',
    );
    return;
  }

  const fileName = path.basename(target.fsPath);
  const seededRows: SeededRow[] = entries.map((e) => ({
    name: e.key,
    type: 'env-var-name',
    value: e.value,
  }));

  await openAddMultipleWebview(session, onChange, extensionUri, {
    rows: seededRows,
    overwriteByName: true,
    title: `VaultPilot — Import from ${fileName}`,
    subtitle: `${String(entries.length)} keys found in ${fileName}. Review, edit, or remove rows, then click Import. Existing credentials with the same name will be overwritten.`,
    submitLabel: 'Import',
  });
}

/** True if the file name matches the `.env*` convention. */
export function isEnvFileName(fileName: string): boolean {
  const base = path.basename(fileName);
  return /^\.env(\..+)?$/.test(base);
}

/**
 * When the session is locked at import time, offer the right action:
 *   - If the current workspace has NO vault on disk → offer to Set Up
 *     (runs the first-run flow, which creates + unlocks the session).
 *   - If the vault exists but is locked → prompt for the passphrase and
 *     unlock the session in place.
 *
 * Returns `true` if the user took an action and the caller should re-check
 * `session.isUnlocked()` before proceeding. Returns `false` on cancel.
 */
async function offerUnlockOrSetUp(
  session: VaultSession,
  secretStorage: SecretStorageWrapper,
): Promise<boolean> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws === undefined) {
    void vscode.window.showWarningMessage('Open a workspace folder first.');
    return false;
  }

  const fp = await resolveFingerprint(ws.uri.fsPath);
  const vaultDir = path.join(PROJECTS_DIR, fp.fingerprint);
  const exists = await pathExists(vaultDir);

  if (!exists) {
    const SET_UP = 'Set Up Vault';
    const choice = await vscode.window.showInformationMessage(
      'No VaultPilot vault exists for this workspace. Set one up to import these credentials?',
      { modal: true },
      SET_UP,
    );
    if (choice !== SET_UP) return false;
    // First-run flow creates the vault + unlocks the session.
    await vscode.commands.executeCommand('vaultpilot.setUpVault');
    return true;
  }

  // Vault exists; session is locked. Prompt for the passphrase and unlock.
  const passphrase = await promptPassphrase('Enter the passphrase for this project.');
  if (passphrase === null) return false;
  const result = await unlockWithPassphrase(session, fp.fingerprint, passphrase);
  zeroBuffer(passphrase);
  if (!result.ok) {
    void vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return false;
  }
  const cacheResult = await secretStorage.cacheDerivedKey(result.value.derivedKey);
  if (!cacheResult.ok) {
    // Non-fatal — proceed with import; FR-47 will re-prompt next session.
    void vscode.window.showWarningMessage(
      `${errorToUserMessage(cacheResult.error)} You may be re-prompted next session.`,
    );
  }
  return true;
}

import * as vscode from 'vscode';

import { errorToUserMessage } from '../error-to-message';
import { persistVault } from '../../vault/persist';
import type { VaultSession } from '../../vault/vault-session';
import type { CredentialTreeItemData } from '../tree-view';
import { resolveCredential } from './copy-credential';

/**
 * Delete Credential command (FR-24 — Story 1.13).
 *
 * Requires explicit confirmation via a modal warning dialog. On confirm, the
 * credential is removed from the session and the vault is re-encrypted +
 * written. No soft-delete, no trash, no version history (FR-24 explicit).
 */
export async function deleteCredentialCommand(
  session: VaultSession,
  payload: CredentialTreeItemData | undefined,
  onChange: () => void,
): Promise<void> {
  const credential = await resolveCredential(session, payload);
  if (credential === null) return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete "${credential.name}"? This cannot be undone.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  const credsResult = session.getCredentials();
  if (!credsResult.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(credsResult.error));
    return;
  }
  const prior = [...credsResult.value];
  const next = prior.filter((c) => c.id !== credential.id);
  const setResult = session.setCredentials(next);
  if (!setResult.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(setResult.error));
    return;
  }

  const persistResult = await persistVault(session);
  if (!persistResult.ok) {
    session.setCredentials(prior);
    await vscode.window.showErrorMessage(errorToUserMessage(persistResult.error));
    return;
  }

  onChange();
  void vscode.window.showInformationMessage(`Deleted "${credential.name}".`);
}

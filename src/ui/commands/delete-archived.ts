import * as vscode from 'vscode';

import {
  checkDeletionConfirmation,
  permanentlyDeleteArchivedEntry,
} from '../../archive/archive-delete';
import { errorToUserMessage } from '../error-to-message';
import type { VaultSession } from '../../vault/vault-session';

/**
 * Permanent delete of an archived entry (Story 2.4, FR-31).
 *
 * Strong confirmation: the user must type the project's `displayName`
 * EXACTLY (case-sensitive). The `validateInput` callback enables / disables
 * the prompt's accept button by returning a validation message until the
 * input matches.
 *
 * On confirm, the entry's directory is removed recursively. No trash, no
 * soft-delete, no version history (FR-31 explicit).
 */
export async function deleteArchivedCommand(
  session: VaultSession,
  payload: { fingerprint: string; displayName: string } | undefined,
  onChange: () => void,
): Promise<void> {
  if (payload === undefined) {
    await vscode.window.showErrorMessage('Delete Archived: no fingerprint provided.');
    return;
  }
  const { fingerprint, displayName } = payload;

  const typed = await vscode.window.showInputBox({
    title: 'Permanently delete archived vault',
    prompt: `Type the project name "${displayName}" to confirm permanent deletion`,
    ignoreFocusOut: true,
    placeHolder: displayName,
    validateInput: (value: string) => {
      if (value.length === 0) return 'Type the project name to confirm';
      if (!checkDeletionConfirmation(displayName, value)) {
        return `Doesn't match "${displayName}" exactly (case-sensitive)`;
      }
      return null;
    },
  });

  if (typed === undefined) return; // user cancelled

  const result = await permanentlyDeleteArchivedEntry(fingerprint);
  if (!result.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return;
  }

  session.forgetArchivedKey(fingerprint);
  void vscode.window.showInformationMessage(`Deleted "${displayName}" permanently.`);
  onChange();
}

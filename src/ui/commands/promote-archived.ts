import * as vscode from 'vscode';

import { promoteArchivedEntry } from '../../archive/promote';
import { errorToUserMessage } from '../error-to-message';
import type { VaultSession } from '../../vault/vault-session';

/**
 * Promote an archived entry back to active (Story 2.3 — manual flow).
 *
 * Invoked from the archived-view's context menu on a project item. Auto-
 * promote (triggered by opening a workspace whose fingerprint matches an
 * archived entry) lives in `extension.ts:refreshAndMaybeUnlock` and calls
 * `promoteArchivedEntry` directly.
 */
export async function promoteArchivedCommand(
  session: VaultSession,
  payload: { fingerprint: string; displayName?: string } | undefined,
  onChange: () => void,
): Promise<void> {
  if (payload === undefined) {
    await vscode.window.showErrorMessage('Promote Archived: no fingerprint provided.');
    return;
  }

  const result = await promoteArchivedEntry(payload.fingerprint);
  if (!result.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return;
  }

  // Forget the archived-side key cache (the entry is no longer archived).
  session.forgetArchivedKey(payload.fingerprint);

  const name = payload.displayName ?? payload.fingerprint.slice(0, 8);
  void vscode.window.showInformationMessage(`Promoted "${name}" to active.`);
  onChange();
}

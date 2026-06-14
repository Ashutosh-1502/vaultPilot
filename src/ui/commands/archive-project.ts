import * as vscode from 'vscode';

import { archiveActiveEntry } from '../../archive/promote';
import { errorToUserMessage } from '../error-to-message';
import type { VaultSession } from '../../vault/vault-session';

/**
 * Manually archive an active project (dashboard-driven, Pass-1 archive UX).
 *
 * Confirmation is a single modal: "Archive <name>? You can promote it back
 * later from the Archived view." No type-the-name gate (archive is reversible
 * via promote; permanent delete uses the stronger confirmation).
 *
 * If the project is the currently-open workspace, archiving it also locks the
 * session — the user can re-open the workspace and unlock again, or promote
 * the entry back to active.
 */
export async function archiveProjectCommand(
  session: VaultSession,
  payload: { fingerprint: string; displayName: string } | undefined,
  onChange: () => void,
): Promise<void> {
  if (payload === undefined) {
    await vscode.window.showErrorMessage('Archive Project: no fingerprint provided.');
    return;
  }
  const { fingerprint, displayName } = payload;

  const isCurrentlyOpen = session.getFingerprint() === fingerprint;
  const detail = isCurrentlyOpen
    ? 'This is your currently open workspace. Archiving will lock the active session — you can promote it back from the Archived view at any time.'
    : 'You can promote it back from the Archived view at any time.';

  const confirm = await vscode.window.showWarningMessage(
    `Archive "${displayName}"?`,
    { modal: true, detail },
    'Archive',
  );
  if (confirm !== 'Archive') return;

  const result = await archiveActiveEntry(fingerprint);
  if (!result.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return;
  }

  if (isCurrentlyOpen) {
    session.lock();
  }

  void vscode.window.showInformationMessage(
    `Archived "${displayName}". Visit the Archived view to restore or permanently delete it.`,
  );
  onChange();
}

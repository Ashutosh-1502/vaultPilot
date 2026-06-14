import * as vscode from 'vscode';

import { deriveAndCacheArchivedKey } from '../../archive/archive-decrypt';
import { errorToUserMessage } from '../error-to-message';
import { promptPassphrase } from '../passphrase-prompt';
import { zeroBuffer } from '../../vault/memory-zero';
import type { VaultSession } from '../../vault/vault-session';

/**
 * Unlock an archived vault entry by prompting for the user's passphrase and
 * deriving the per-fingerprint key (Story 2.2 — supports cross-salt access).
 *
 * On success, the key is cached in `VaultSession.archivedKeys` and the
 * `onChange` callback refreshes the archived TreeView so the credentials
 * become visible.
 *
 * On wrong-passphrase, the user can retry (or cancel via Esc). No retry
 * limit (FR-48 — KDF cost is the only friction).
 */
export async function unlockArchivedCommand(
  session: VaultSession,
  payload: { fingerprint: string } | undefined,
  onChange: () => void,
): Promise<void> {
  if (payload === undefined) {
    await vscode.window.showErrorMessage('Unlock Archived: no fingerprint provided.');
    return;
  }

  const passphrase = await promptPassphrase(
    'Enter the passphrase for this archived project to view its credentials.',
  );
  if (passphrase === null) return;

  const result = await deriveAndCacheArchivedKey(session, payload.fingerprint, passphrase);
  zeroBuffer(passphrase);

  if (!result.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return;
  }

  onChange();
}

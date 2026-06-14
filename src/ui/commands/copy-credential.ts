import * as vscode from 'vscode';

import { readArchivedEntry } from '../../archive/archive-decrypt';
import type { ClipboardAutoClear } from '../../credentials/clipboard';
import { isPairCredential, type Credential } from '../../credentials/credential';
import type { VaultSession } from '../../vault/vault-session';

/**
 * Copy Credential command (FR-26, FR-27 — Story 1.12 + Story 2.2 archive support).
 *
 * For single-value credentials, copies the value with 30s auto-clear.
 * For pair credentials, prompts which field to copy (fieldA / fieldB), then
 * copies that field's value.
 *
 * Two invocation sources:
 *   - Active view TreeItem → payload has `credentialId` only; credential
 *     comes from `VaultSession.getCredentials()`.
 *   - Archived view TreeItem → payload has `credentialId` + `archivedFingerprint`;
 *     credential comes from `readArchivedEntry(session, fingerprint)`.
 *   - Command Palette (no payload) → prompts to pick from the active vault.
 */
export interface CredentialRefPayload {
  readonly credentialId: string;
  readonly archivedFingerprint?: string;
}

export async function copyCredentialCommand(
  session: VaultSession,
  clipboard: ClipboardAutoClear,
  payload: CredentialRefPayload | undefined,
): Promise<void> {
  const credential = await resolveCredential(session, payload);
  if (credential === null) return;

  if (isPairCredential(credential)) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: credential.fields.fieldA.label, fieldKey: 'fieldA' as const },
        { label: credential.fields.fieldB.label, fieldKey: 'fieldB' as const },
      ],
      { placeHolder: `Which field to copy from "${credential.name}"?`, ignoreFocusOut: true },
    );
    if (pick === undefined) return;
    const value = credential.fields[pick.fieldKey].value;
    await clipboard.copy(value);
    void vscode.window.showInformationMessage(
      `Copied ${credential.name}.${pick.label} — clears in 30s.`,
    );
    return;
  }

  await clipboard.copy(credential.value);
  void vscode.window.showInformationMessage(`Copied ${credential.name} — clears in 30s.`);
}

/**
 * Resolve a credential from either the active session or an archived entry.
 *
 * - If `payload.archivedFingerprint` is set, reads from the archived entry
 *   using the per-fingerprint key cache. If the key isn't cached, returns
 *   null (the archived-view TreeItem would have shown the unlock prompt
 *   already — by the time a Copy/Reveal command fires on a credential, the
 *   key must already be cached).
 * - If `payload.credentialId` is set without `archivedFingerprint`, reads
 *   from the active session.
 * - If `payload` is undefined (Command Palette), prompts the user to pick
 *   from the active session's credentials.
 */
export async function resolveCredential(
  session: VaultSession,
  payload: CredentialRefPayload | undefined,
): Promise<Credential | null> {
  // Archived credential path
  if (payload?.archivedFingerprint !== undefined) {
    const result = await readArchivedEntry(session, payload.archivedFingerprint);
    if (!result.ok) {
      await vscode.window.showWarningMessage(
        'Archived vault is locked. Click the entry first to unlock.',
      );
      return null;
    }
    const found = result.value.credentials.find((c) => c.id === payload.credentialId);
    if (found === undefined) {
      await vscode.window.showWarningMessage('Archived credential not found.');
      return null;
    }
    return found;
  }

  // Active session path
  const credsResult = session.getCredentials();
  if (!credsResult.ok) {
    await vscode.window.showWarningMessage('Vault is locked. Unlock first.');
    return null;
  }
  const all = credsResult.value;

  if (payload !== undefined) {
    const found = all.find((c) => c.id === payload.credentialId);
    if (found !== undefined) return found;
  }

  if (all.length === 0) {
    await vscode.window.showInformationMessage('No credentials in this vault yet.');
    return null;
  }

  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({ label: c.name, description: c.type, id: c.id })),
    { placeHolder: 'Select a credential', ignoreFocusOut: true },
  );
  if (pick === undefined) return null;
  return all.find((c) => c.id === pick.id) ?? null;
}

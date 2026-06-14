import * as vscode from 'vscode';

import { isPairCredential } from '../../credentials/credential';
import type { VaultSession } from '../../vault/vault-session';
import { resolveCredential, type CredentialRefPayload } from './copy-credential';

/**
 * Reveal Credential command (FR-25 — Story 1.12 + Story 2.2 archive support).
 *
 * Per-action reveal: shows the cleartext value(s) via a modal information
 * dialog. The dialog is dismissed by the user; reveal is NOT sticky on the
 * TreeItem (which remains masked).
 *
 * For pair credentials, displays both labeled fields. Works against both
 * active and archived credentials via the `CredentialRefPayload` shape.
 */
export async function revealCredentialCommand(
  session: VaultSession,
  payload: CredentialRefPayload | undefined,
): Promise<void> {
  const credential = await resolveCredential(session, payload);
  if (credential === null) return;

  if (isPairCredential(credential)) {
    const message = `${credential.name}\n\n${credential.fields.fieldA.label}: ${credential.fields.fieldA.value}\n\n${credential.fields.fieldB.label}: ${credential.fields.fieldB.value}`;
    await vscode.window.showInformationMessage(message, { modal: true });
    return;
  }

  await vscode.window.showInformationMessage(
    `${credential.name}\n\n${credential.value}`,
    { modal: true },
  );
}

import * as vscode from 'vscode';

import {
  isPairCredential,
  type Credential,
  type PairCredential,
} from '../../credentials/credential';
import { errorToUserMessage } from '../error-to-message';
import { persistVault } from '../../vault/persist';
import type { VaultSession } from '../../vault/vault-session';
import type { CredentialTreeItemData } from '../tree-view';
import { resolveCredential } from './copy-credential';

/**
 * Edit Credential command (FR-23 — Story 1.13).
 *
 * The credential's `type` is fixed (can't change between types — would alter
 * the on-disk schema). Every editable field is pre-filled with the current
 * value; the user confirms or modifies each.
 *
 * Save fully replaces prior values (FR-23 — no version history in MVP).
 * Cancellation discards in-flight buffers.
 */
export async function editCredentialCommand(
  session: VaultSession,
  payload: CredentialTreeItemData | undefined,
  onChange: () => void,
): Promise<void> {
  const credential = await resolveCredential(session, payload);
  if (credential === null) return;

  const newName = await vscode.window.showInputBox({
    prompt: 'Credential name',
    value: credential.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Name is required' : null),
  });
  if (newName === undefined) return;

  let updated: Credential;
  if (isPairCredential(credential)) {
    const fields = await editPairFields(credential);
    if (fields === null) return;
    updated = {
      ...credential,
      name: newName.trim(),
      fields,
      updated: new Date().toISOString(),
    };
  } else {
    const single = credential;
    const newValue = await vscode.window.showInputBox({
      prompt: 'Value',
      value: single.value,
      password: single.type === 'api-key' || single.type === 'token',
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (v.length === 0) return 'Value is required';
        if (single.type === 'json-blob') {
          try {
            JSON.parse(v);
          } catch {
            return 'Not valid JSON — try again';
          }
        }
        return null;
      },
    });
    if (newValue === undefined) return;
    updated = {
      ...single,
      name: newName.trim(),
      value: newValue,
      updated: new Date().toISOString(),
    };
  }

  const newNotes = await vscode.window.showInputBox({
    prompt: 'Notes (optional)',
    value: credential.notes ?? '',
    ignoreFocusOut: true,
  });
  if (newNotes === undefined) return;
  if (newNotes.length > 0) {
    updated = { ...updated, notes: newNotes };
  } else {
    // Remove notes by destructuring it out — with exactOptionalPropertyTypes,
    // setting `notes: undefined` is not equivalent to omitting the property.
    const { notes: _existingNotes, ...withoutNotes } = updated;
    updated = withoutNotes;
  }

  const credsResult = session.getCredentials();
  if (!credsResult.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(credsResult.error));
    return;
  }
  const prior = [...credsResult.value];
  const next = prior.map((c) => (c.id === credential.id ? updated : c));
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
  void vscode.window.showInformationMessage(`Updated "${updated.name}".`);
}

async function editPairFields(
  credential: PairCredential,
): Promise<PairCredential['fields'] | null> {
  const aLabel = await vscode.window.showInputBox({
    prompt: 'First field label',
    value: credential.fields.fieldA.label,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Label is required' : null),
  });
  if (aLabel === undefined) return null;

  const aValue = await vscode.window.showInputBox({
    prompt: `Value for ${aLabel}`,
    value: credential.fields.fieldA.value,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length === 0 ? 'Value is required' : null),
  });
  if (aValue === undefined) return null;

  const bLabel = await vscode.window.showInputBox({
    prompt: 'Second field label',
    value: credential.fields.fieldB.label,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Label is required' : null),
  });
  if (bLabel === undefined) return null;

  const bValue = await vscode.window.showInputBox({
    prompt: `Value for ${bLabel}`,
    value: credential.fields.fieldB.value,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length === 0 ? 'Value is required' : null),
  });
  if (bValue === undefined) return null;

  return {
    fieldA: { label: aLabel.trim(), value: aValue },
    fieldB: { label: bLabel.trim(), value: bValue },
  };
}

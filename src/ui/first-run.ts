import * as vscode from 'vscode';

import { zeroBuffer } from '../vault/memory-zero';
import { CURRENT_VAULT_VERSION } from '../vault/format-version';
import {
  init as cryptoInit,
  deriveKey,
  encrypt,
  generateSalt,
} from '../vault/crypto';
import { serializeEnvelope } from '../vault/envelope';
import {
  PROJECTS_DIR,
  ensureVaultRoot,
  writeVaultEntry,
} from '../vault/io';
import { resolveFingerprint } from '../fingerprint/re-link';
import { errorToUserMessage } from './error-to-message';
import { promptPassphraseConfirm } from './passphrase-prompt';
import type { SecretStorageWrapper } from '../keychain/secret-storage';
import type { VaultSession, ProjectMetadata } from '../vault/vault-session';
import { CONTEXT_KEYS, GLOBAL_STATE } from '../settings/state-keys';

/**
 * First-Run orchestrator (FR-40, FR-41, FR-43, FR-44).
 *
 * Story 1.9 (Chunk 4 refactor) — uses the extended `VaultSession.unlock(input)`
 * signature that carries salt + project metadata + created date.
 */

export interface FirstRunDeps {
  secretStorage: SecretStorageWrapper;
  session: VaultSession;
  globalState: vscode.Memento;
  onChange: () => void;
}

export async function setUpNewVault(deps: FirstRunDeps): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws === undefined) {
    await vscode.window.showErrorMessage(
      'Open a workspace folder first. VaultPilot links credentials to the active workspace.',
    );
    return;
  }

  // Webview confirm-mode prompt: shows BOTH inputs in one panel and validates
  // match client-side before submitting. Returns the agreed-upon passphrase
  // or null on cancel.
  const first = await promptPassphraseConfirm();
  if (first === null) return;

  await cryptoInit();
  const salt = generateSalt();
  const keyResult = await deriveKey(first, salt);
  zeroBuffer(first);
  if (!keyResult.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(keyResult.error));
    return;
  }
  const derivedKey = keyResult.value;

  const fingerprintResult = await resolveFingerprint(ws.uri.fsPath);
  const projectMeta: ProjectMetadata = {
    fingerprint: fingerprintResult.fingerprint,
    fingerprintSource: fingerprintResult.source,
    displayName: ws.name,
    gitRemoteUrl: fingerprintResult.canonicalRemoteUrl ?? null,
    lastKnownPath: ws.uri.fsPath,
  };

  const created = new Date().toISOString();
  const innerPayload = Buffer.from(
    JSON.stringify({
      version: CURRENT_VAULT_VERSION,
      created,
      updated: created,
      project: projectMeta,
      credentials: [],
    }),
    'utf8',
  );

  const encResult = encrypt(innerPayload, derivedKey);
  zeroBuffer(innerPayload);
  if (!encResult.ok) {
    zeroBuffer(derivedKey);
    await vscode.window.showErrorMessage(errorToUserMessage(encResult.error));
    return;
  }

  const envelope = serializeEnvelope(
    CURRENT_VAULT_VERSION,
    salt,
    encResult.value.nonce,
    encResult.value.ciphertext,
  );

  const metaJson = Buffer.from(
    JSON.stringify({
      version: 1,
      fingerprint: projectMeta.fingerprint,
      fingerprintSource: projectMeta.fingerprintSource,
      displayName: projectMeta.displayName,
      gitRemoteUrl: projectMeta.gitRemoteUrl,
      lastKnownPath: projectMeta.lastKnownPath,
      tentativeMissAt: null,
    }),
    'utf8',
  );

  const ensureResult = await ensureVaultRoot();
  if (!ensureResult.ok) {
    zeroBuffer(derivedKey);
    await vscode.window.showErrorMessage(errorToUserMessage(ensureResult.error));
    return;
  }
  const writeResult = await writeVaultEntry(
    PROJECTS_DIR,
    fingerprintResult.fingerprint,
    metaJson,
    envelope,
  );
  if (!writeResult.ok) {
    zeroBuffer(derivedKey);
    await vscode.window.showErrorMessage(errorToUserMessage(writeResult.error));
    return;
  }

  const cacheResult = await deps.secretStorage.cacheDerivedKey(derivedKey);
  if (!cacheResult.ok) {
    void vscode.window.showWarningMessage(
      `${errorToUserMessage(cacheResult.error)} You may be re-prompted for your passphrase next session.`,
    );
  }

  deps.session.unlock({
    fingerprint: fingerprintResult.fingerprint,
    derivedKey,
    salt,
    created,
    projectMeta,
    credentials: [],
  });

  await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.VAULT_EXISTS, true);
  deps.onChange();

  await offerDriveOptIn(deps.globalState);
}

async function offerDriveOptIn(globalState: vscode.Memento): Promise<void> {
  const NOT_NOW = 'Set up Google Drive backup later';
  const SET_UP = 'Set up now';
  const choice = await vscode.window.showQuickPick(
    [
      { label: NOT_NOW, description: 'Recommended for now' },
      { label: SET_UP, description: 'Open settings to configure Drive backup' },
    ],
    {
      placeHolder: 'Set up Google Drive backup?',
      ignoreFocusOut: true,
    },
  );

  if (choice === undefined || choice.label === NOT_NOW) {
    await globalState.update(GLOBAL_STATE.FIRST_RUN_DRIVE_DECLINED, true);
    return;
  }

  // "Set up now" — open the settings UI so the user can set
  // `vaultpilot.driveOAuthClientId` and toggle `vaultpilot.driveBackupEnabled`.
  // The actual OAuth + first backup runs via the Command Palette
  // `VaultPilot: Back Up to Drive` once both are configured.
  await vscode.commands.executeCommand(
    'workbench.action.openSettings',
    'vaultpilot.driveOAuthClientId',
  );
}

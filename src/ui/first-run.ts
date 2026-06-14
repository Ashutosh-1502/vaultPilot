import { promises as fs } from 'fs';
import * as path from 'path';
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
import { importFromEnvCommand, isEnvFileName } from './commands/import-from-env';
import { parseEnvFile } from '../credentials/env-parser';
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
  /** Used to render the import-from-env webview if .env files are detected post-setup. */
  extensionUri: vscode.Uri;
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

  await offerEnvImport(deps, ws.uri.fsPath);
  await offerDriveOptIn(deps.globalState);
}

/**
 * After first-run, scan the workspace root for .env* files and, if any are
 * found, offer to import them into the freshly-unlocked vault.
 *
 * Counts and surfaces only env vars whose `KEY` is not already a credential
 * name in the vault — so files whose contents are fully covered show up as
 * "already in vault" and files with nothing new are silently skipped.
 * Workspace root only (not recursive) per MVP scope.
 */
async function offerEnvImport(deps: FirstRunDeps, workspaceRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(workspaceRoot);
  } catch {
    return;
  }
  const envFiles = entries.filter(isEnvFileName).sort();
  if (envFiles.length === 0) return;

  const existing = deps.session.getCredentials();
  const existingNames = new Set<string>(
    existing.ok ? existing.value.map((c) => c.name) : [],
  );

  const newKeysInFile = async (name: string): Promise<number> => {
    try {
      const text = await fs.readFile(path.join(workspaceRoot, name), 'utf8');
      return parseEnvFile(text).filter((e) => !existingNames.has(e.key)).length;
    } catch {
      return 0;
    }
  };

  // Pre-compute the new-key count per file so we can both filter out fully-
  // covered files and label the QuickPick rows accurately.
  const counted = await Promise.all(
    envFiles.map(async (name) => ({ name, newCount: await newKeysInFile(name) })),
  );
  const candidates = counted.filter((c) => c.newCount > 0);
  if (candidates.length === 0) return;

  let chosen: { name: string; newCount: number } | undefined;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    type EnvPick = vscode.QuickPickItem & { readonly file: string; readonly newCount: number };
    const items: EnvPick[] = candidates.map((c) => ({
      label: c.name,
      description: `${String(c.newCount)} new variable${c.newCount === 1 ? '' : 's'}`,
      file: c.name,
      newCount: c.newCount,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'VaultPilot found .env files in this workspace',
      placeHolder: 'Pick a file to import (you can import the others later via the command palette)',
      ignoreFocusOut: true,
    });
    if (picked === undefined) return;
    chosen = { name: picked.file, newCount: picked.newCount };
  }
  if (chosen === undefined) return;

  const IMPORT = 'Import';
  const SKIP = 'Skip';
  const choice = await vscode.window.showInformationMessage(
    `Found ${String(chosen.newCount)} new env var${chosen.newCount === 1 ? '' : 's'} in ${chosen.name}. Import to VaultPilot?`,
    IMPORT,
    SKIP,
  );
  if (choice !== IMPORT) return;

  await importFromEnvCommand(
    deps.session,
    deps.onChange,
    vscode.Uri.file(path.join(workspaceRoot, chosen.name)),
    deps.extensionUri,
    deps.secretStorage,
    { excludeExistingNames: true },
  );
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

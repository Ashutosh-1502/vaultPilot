import { promises as fs } from 'fs';
import { randomUUID } from 'node:crypto';
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
import { isEnvFileName } from './commands/import-from-env';
import { parseEnvFile, type EnvEntry } from '../credentials/env-parser';
import type { Credential } from '../credentials/credential';
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
  void deps.extensionUri;

  // Detect importable .env entries BEFORE asking for a passphrase. Per the
  // dogfood feedback (2026-06-14), a vault must be backed by something to
  // store — empty or missing .env files no longer silently create an empty
  // vault that the user can't get back into.
  const plan = await scanWorkspaceForImport(ws.uri.fsPath);
  if (plan === 'cancelled') return;
  if (plan.entries.length === 0) {
    await vscode.window.showInformationMessage(
      plan.filesScanned === 0
        ? 'No .env files found in this workspace. Create a .env file with at least one KEY=value entry, then run Set Up Vault again.'
        : `Found ${String(plan.filesScanned)} .env file${plan.filesScanned === 1 ? '' : 's'} but no KEY=value entries to import. Add some, then run Set Up Vault again.`,
    );
    return;
  }

  const CONFIRM = 'Import & Create Vault';
  const confirm = await vscode.window.showInformationMessage(
    `Import ${String(plan.entries.length)} variable${plan.entries.length === 1 ? '' : 's'} from ${plan.fileName} into a new VaultPilot vault?`,
    { modal: true },
    CONFIRM,
  );
  if (confirm !== CONFIRM) return;

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
  const credentials: Credential[] = plan.entries.map((e) => ({
    id: randomUUID(),
    name: e.key,
    type: 'env-var-name',
    value: e.value,
    created,
    updated: created,
  }));

  const innerPayload = Buffer.from(
    JSON.stringify({
      version: CURRENT_VAULT_VERSION,
      created,
      updated: created,
      project: projectMeta,
      credentials,
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
    credentials,
  });

  await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.VAULT_EXISTS, true);
  deps.onChange();

  void vscode.window.showInformationMessage(
    `Vault created. Imported ${String(credentials.length)} credential${credentials.length === 1 ? '' : 's'} from ${plan.fileName}.`,
  );

  await offerDriveOptIn(deps.globalState);
}

interface ImportPlan {
  readonly fileName: string;
  readonly entries: readonly EnvEntry[];
  /** Number of .env* files seen in the workspace root, regardless of content. */
  readonly filesScanned: number;
}

/**
 * Scan the workspace root for `.env*` files and parse each. Returns the plan
 * the caller should act on:
 *   - `'cancelled'` if the user dismissed the multi-file picker.
 *   - Empty `entries` with `filesScanned` so the caller can tell "no files"
 *     vs "files but empty".
 *   - Populated `entries` + chosen `fileName` ready to import.
 *
 * Workspace root only (not recursive) per MVP scope.
 */
async function scanWorkspaceForImport(
  workspaceRoot: string,
): Promise<ImportPlan | 'cancelled'> {
  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(workspaceRoot);
  } catch {
    return { fileName: '', entries: [], filesScanned: 0 };
  }
  const envFiles = dirEntries.filter(isEnvFileName).sort();

  const parsed: { readonly name: string; readonly entries: readonly EnvEntry[] }[] = [];
  for (const name of envFiles) {
    try {
      const text = await fs.readFile(path.join(workspaceRoot, name), 'utf8');
      parsed.push({ name, entries: parseEnvFile(text) });
    } catch {
      parsed.push({ name, entries: [] });
    }
  }
  const filesScanned = parsed.length;
  const withContent = parsed.filter((p) => p.entries.length > 0);
  if (withContent.length === 0) {
    return { fileName: '', entries: [], filesScanned };
  }

  let chosen: { readonly name: string; readonly entries: readonly EnvEntry[] } | undefined;
  if (withContent.length === 1) {
    chosen = withContent[0];
  } else {
    type EnvPick = vscode.QuickPickItem & { readonly file: string };
    const items: EnvPick[] = withContent.map((p) => ({
      label: p.name,
      description: `${String(p.entries.length)} variable${p.entries.length === 1 ? '' : 's'}`,
      file: p.name,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'VaultPilot found multiple .env files',
      placeHolder: 'Pick the file to import into your new vault',
      ignoreFocusOut: true,
    });
    if (picked === undefined) return 'cancelled';
    chosen = withContent.find((p) => p.name === picked.file);
  }
  if (chosen === undefined) {
    return { fileName: '', entries: [], filesScanned };
  }

  return { fileName: chosen.name, entries: chosen.entries, filesScanned };
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

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
  readVaultEntry,
  writeVaultEntry,
} from '../vault/io';
import { resolveFingerprint } from '../fingerprint/re-link';
import { unlockWithPassphrase } from '../vault/unlock';
import { errorToUserMessage } from './error-to-message';
import { promptPassphrase, promptPassphraseConfirm } from './passphrase-prompt';
import { isEnvFileName } from './commands/import-from-env';
import { parseEnvFile, type EnvEntry } from '../credentials/env-parser';
import { openAddMultipleWebview, type SeededRow } from './webviews/add-multi-webview';
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

  const ensureRootResult = await ensureVaultRoot();
  if (!ensureRootResult.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(ensureRootResult.error));
    return;
  }

  const fingerprintResult = await resolveFingerprint(ws.uri.fsPath);
  const entryResult = await readVaultEntry(PROJECTS_DIR, fingerprintResult.fingerprint);
  const vaultExists = entryResult.ok && entryResult.value !== null;

  // If a vault already exists for this workspace, "Create New Vault" becomes
  // "add to existing vault" — ensure session is unlocked, then offer the
  // same .env picker with files-already-imported filtered out, plus the
  // "New (empty)" manual-entry option.
  if (vaultExists) {
    const unlocked = await ensureSessionUnlocked(deps, fingerprintResult.fingerprint);
    if (!unlocked) return;

    const existingNames = collectExistingCredentialNames(deps.session);
    const choice = await pickImportSource(ws.uri.fsPath, existingNames);
    if (choice === 'cancelled') return;

    if (choice === 'new-empty') {
      await openAddMultipleWebview(deps.session, deps.onChange, deps.extensionUri);
      return;
    }

    await openAddMultipleWebview(deps.session, deps.onChange, deps.extensionUri, {
      rows: choice.entries.map<SeededRow>((e) => ({
        name: e.key,
        type: 'env-var-name',
        value: e.value,
      })),
      overwriteByName: true,
      title: `VaultPilot — Import from ${choice.fileName}`,
      subtitle: `${String(choice.entries.length)} keys found in ${choice.fileName}. Review, edit, or remove rows, then click Import. Existing credentials with the same name will be overwritten.`,
      submitLabel: 'Import',
    });
    return;
  }

  // No vault yet — fresh first-run flow. Same picker, no filtering needed.
  const choice = await pickImportSource(ws.uri.fsPath, new Set());
  if (choice === 'cancelled') return;

  const projectMeta: ProjectMetadata = {
    fingerprint: fingerprintResult.fingerprint,
    fingerprintSource: fingerprintResult.source,
    displayName: ws.name,
    gitRemoteUrl: fingerprintResult.canonicalRemoteUrl ?? null,
    lastKnownPath: ws.uri.fsPath,
  };

  if (choice === 'new-empty') {
    await createVaultAndUnlock(deps, projectMeta, []);
    if (!deps.session.isUnlocked()) return;
    await openAddMultipleWebview(deps.session, deps.onChange, deps.extensionUri);
    await offerDriveOptIn(deps.globalState);
    return;
  }

  const CONFIRM = 'Import & Create Vault';
  const confirm = await vscode.window.showInformationMessage(
    `Import ${String(choice.entries.length)} variable${choice.entries.length === 1 ? '' : 's'} from ${choice.fileName} into a new VaultPilot vault?`,
    { modal: true },
    CONFIRM,
  );
  if (confirm !== CONFIRM) return;

  const created = new Date().toISOString();
  const credentials: Credential[] = choice.entries.map((e) => ({
    id: randomUUID(),
    name: e.key,
    type: 'env-var-name',
    value: e.value,
    created,
    updated: created,
  }));

  const ok = await createVaultAndUnlock(deps, projectMeta, credentials, created);
  if (!ok) return;

  void vscode.window.showInformationMessage(
    `Vault created. Imported ${String(credentials.length)} credential${credentials.length === 1 ? '' : 's'} from ${choice.fileName}.`,
  );

  await offerDriveOptIn(deps.globalState);
}

/**
 * Prompt for passphrase + derive + persist a brand-new vault with the given
 * credentials, then unlock the session. Returns `true` on success.
 */
async function createVaultAndUnlock(
  deps: FirstRunDeps,
  projectMeta: ProjectMetadata,
  credentials: Credential[],
  createdAt: string = new Date().toISOString(),
): Promise<boolean> {
  const first = await promptPassphraseConfirm();
  if (first === null) return false;

  await cryptoInit();
  const salt = generateSalt();
  const keyResult = await deriveKey(first, salt);
  zeroBuffer(first);
  if (!keyResult.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(keyResult.error));
    return false;
  }
  const derivedKey = keyResult.value;

  const innerPayload = Buffer.from(
    JSON.stringify({
      version: CURRENT_VAULT_VERSION,
      created: createdAt,
      updated: createdAt,
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
    return false;
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

  const writeResult = await writeVaultEntry(
    PROJECTS_DIR,
    projectMeta.fingerprint,
    metaJson,
    envelope,
  );
  if (!writeResult.ok) {
    zeroBuffer(derivedKey);
    await vscode.window.showErrorMessage(errorToUserMessage(writeResult.error));
    return false;
  }

  const cacheResult = await deps.secretStorage.cacheDerivedKey(derivedKey);
  if (!cacheResult.ok) {
    void vscode.window.showWarningMessage(
      `${errorToUserMessage(cacheResult.error)} You may be re-prompted for your passphrase next session.`,
    );
  }

  deps.session.unlock({
    fingerprint: projectMeta.fingerprint,
    derivedKey,
    salt,
    created: createdAt,
    projectMeta,
    credentials,
  });

  await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.VAULT_EXISTS, true);
  deps.onChange();
  return true;
}

/** Returns true if the session is unlocked after this call. */
async function ensureSessionUnlocked(
  deps: FirstRunDeps,
  fingerprint: string,
): Promise<boolean> {
  if (deps.session.isUnlocked()) return true;

  const passphrase = await promptPassphrase('Enter the passphrase for this project.');
  if (passphrase === null) return false;

  const result = await unlockWithPassphrase(deps.session, fingerprint, passphrase);
  zeroBuffer(passphrase);
  if (!result.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return false;
  }
  const cacheResult = await deps.secretStorage.cacheDerivedKey(result.value.derivedKey);
  if (!cacheResult.ok) {
    void vscode.window.showWarningMessage(
      `${errorToUserMessage(cacheResult.error)} You may be re-prompted next session.`,
    );
  }
  return true;
}

function collectExistingCredentialNames(session: VaultSession): Set<string> {
  const result = session.getCredentials();
  if (!result.ok) return new Set();
  return new Set(result.value.map((c) => c.name));
}

interface ImportFileChoice {
  readonly fileName: string;
  readonly entries: readonly EnvEntry[];
}

type PickerResult = ImportFileChoice | 'new-empty' | 'cancelled';

/**
 * Scan the workspace root for `.env*` files and prompt the user to pick the
 * source for credentials being added to a (new or existing) vault.
 *
 * The picker always offers a "New (empty)" option that bypasses file import
 * — used when the user wants to add credentials manually. Files whose every
 * key already exists in `existingNames` are filtered out so the user isn't
 * shown an "import" option that would be a no-op.
 *
 * Returns:
 *   - `'cancelled'` if the user dismissed the picker
 *   - `'new-empty'` if they chose to add manually
 *   - `ImportFileChoice` with the chosen file's entries
 */
async function pickImportSource(
  workspaceRoot: string,
  existingNames: ReadonlySet<string>,
): Promise<PickerResult> {
  let dirEntries: string[] = [];
  try {
    dirEntries = await fs.readdir(workspaceRoot);
  } catch {
    // No workspace contents readable — proceed with manual-only.
  }
  const envFiles = dirEntries.filter(isEnvFileName).sort();

  const parsed: ImportFileChoice[] = [];
  for (const name of envFiles) {
    try {
      const text = await fs.readFile(path.join(workspaceRoot, name), 'utf8');
      const entries = parseEnvFile(text);
      if (entries.length === 0) continue;
      parsed.push({ fileName: name, entries });
    } catch {
      // Unreadable file — skip silently.
    }
  }

  // Drop files where every key is already in the vault (all-keys-present rule).
  const importable = parsed.filter((p) =>
    p.entries.some((e) => !existingNames.has(e.key)),
  );

  type EnvPick = vscode.QuickPickItem & {
    readonly file?: ImportFileChoice;
    readonly isNew?: true;
    readonly isUpload?: true;
  };
  const items: EnvPick[] = [
    ...importable.map<EnvPick>((p) => ({
      label: p.fileName,
      description: `${String(p.entries.length)} variable${p.entries.length === 1 ? '' : 's'}`,
      file: p,
    })),
    {
      label: 'Upload .env file…',
      description: 'Browse for a file outside this workspace',
      isUpload: true,
    },
    {
      label: 'New (empty)',
      description: 'Add credentials manually',
      isNew: true,
    },
  ];

  const titleForCount =
    importable.length === 0
      ? 'Create a new VaultPilot vault'
      : importable.length === 1
        ? 'VaultPilot found a .env file'
        : 'VaultPilot found multiple .env files';

  const picked = await vscode.window.showQuickPick(items, {
    title: titleForCount,
    placeHolder: 'Pick a file to import, upload one, or add credentials manually',
    ignoreFocusOut: true,
  });
  if (picked === undefined) return 'cancelled';
  if (picked.isNew === true) return 'new-empty';
  if (picked.isUpload === true) return pickUploadedEnvFile(workspaceRoot);
  return picked.file ?? 'cancelled';
}

/**
 * Open a file-open dialog so the user can choose a .env file from anywhere
 * on disk, parse it, and return the entries. Returns `'cancelled'` if the
 * dialog was dismissed or the file has no parseable entries.
 */
async function pickUploadedEnvFile(
  workspaceRoot: string,
): Promise<ImportFileChoice | 'cancelled'> {
  const picks = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: 'Select a .env file to import',
    filters: {
      'Env Files': ['env', 'env.local', 'env.production', 'env.development'],
      'All Files': ['*'],
    },
    defaultUri: vscode.Uri.file(workspaceRoot),
  });
  const target = picks?.[0];
  if (target === undefined) return 'cancelled';

  let text: string;
  try {
    text = await fs.readFile(target.fsPath, 'utf8');
  } catch (err) {
    await vscode.window.showErrorMessage(
      `Could not read ${target.fsPath}: ${String(err)}`,
    );
    return 'cancelled';
  }

  const entries = parseEnvFile(text);
  if (entries.length === 0) {
    await vscode.window.showInformationMessage(
      'No environment variables found in this file (skipped blanks, comments, empty values).',
    );
    return 'cancelled';
  }

  return { fileName: path.basename(target.fsPath), entries };
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

import * as vscode from 'vscode';

import {
  backupToLocal,
  BACKUP_FOLDER_NAME,
  type BackupBundle,
} from '../../backup/local-backup';
import { errorToUserMessage } from '../error-to-message';
import { GLOBAL_STATE } from '../../settings/state-keys';
import { promptPassphrase } from '../passphrase-prompt';
import { zeroBuffer } from '../../vault/memory-zero';
import { decrypt } from '../../vault/crypto';
import { parseEnvelope, peekVersion } from '../../vault/envelope';
import { checkSupported } from '../../vault/format-version';
import { isCredential, type Credential } from '../../credentials/credential';
import {
  ARCHIVE_DIR,
  PROJECTS_DIR,
  listVaultEntries,
  readVaultEntry,
} from '../../vault/io';
import type { VaultSession } from '../../vault/vault-session';

export interface LocalBackupInfo {
  readonly uploadedAt: string;
  readonly folder: string;
  readonly bytes: number;
  readonly projectsCopied: number;
  readonly archivedCopied: number;
}

/**
 * Local-file backup — writes AES-256 encrypted ZIP files (one per vault,
 * containing a readable .env). User can open externally with Keka / 7-Zip /
 * WinZip using the backup passphrase set at backup time.
 *
 * Flow:
 *   1. Pick destination folder
 *   2. Prompt for backup passphrase (separate from per-vault passphrases —
 *      protects the ZIPs, not the local vault)
 *   3. For each project: try to get its credentials in cleartext using
 *      the keys cached this session (current workspace's session key OR
 *      per-fingerprint archived keys). Projects that can't be unlocked
 *      right now are skipped with an explanatory message.
 *   4. Write the ZIPs and a plaintext meta.json per entry.
 *   5. Toast summary: N backed up + M skipped.
 */
export async function localBackupCommand(
  session: VaultSession,
  globalState: vscode.Memento,
): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const previous = globalState.get<LocalBackupInfo | null>(
    GLOBAL_STATE.LOCAL_LAST_BACKUP,
    null,
  );
  const defaultUri =
    previous !== null
      ? vscode.Uri.file(previous.folder.replace(`/${BACKUP_FOLDER_NAME}`, ''))
      : workspaceUri;

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Choose Backup Location',
    title: `Choose a folder — VaultPilot will create '${BACKUP_FOLDER_NAME}' inside it`,
    ...(defaultUri !== undefined ? { defaultUri } : {}),
  });
  if (picked === undefined || picked.length === 0) return;
  const targetParent = picked[0];
  if (targetParent === undefined) return;

  const backupPassphrase = await promptPassphrase(
    'Choose a passphrase for the backup ZIPs. You will need this when opening the .env.zip files in Keka / 7-Zip / WinZip.',
  );
  if (backupPassphrase === null) return;

  try {
    const bundles = await collectAvailableBundles(session);
    const passphraseString = backupPassphrase.toString('utf8');

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'VaultPilot: Backing up to local folder',
        cancellable: false,
      },
      async () => backupToLocal(targetParent.fsPath, bundles, passphraseString),
    );

    if (!result.ok) {
      void vscode.window.showErrorMessage(errorToUserMessage(result.error));
      return;
    }

    const info: LocalBackupInfo = {
      uploadedAt: new Date().toISOString(),
      folder: result.value.folder,
      bytes: result.value.bytes,
      projectsCopied: result.value.projectsCopied,
      archivedCopied: result.value.archivedCopied,
    };
    await globalState.update(GLOBAL_STATE.LOCAL_LAST_BACKUP, info);

    const total = result.value.projectsCopied + result.value.archivedCopied;
    const skipped = result.value.skipped;
    const skippedNote =
      skipped.length > 0
        ? ` Skipped ${String(skipped.length)} locked vault${skipped.length === 1 ? '' : 's'}: ${skipped.map((s) => s.displayName).join(', ')}.`
        : '';

    void vscode.window.showInformationMessage(
      `Backed up ${String(total)} vault${total === 1 ? '' : 's'} to ${result.value.folder}.${skippedNote}`,
    );
  } finally {
    zeroBuffer(backupPassphrase);
  }
}

/**
 * Gather cleartext credential bundles for every project we can decrypt right
 * now WITHOUT prompting the user.
 *
 *   - Current workspace: unlocked → use session.getCredentials()
 *   - Other active projects: their keys.enc lives in projects/, but their
 *     derived key isn't necessarily cached. If we cached an archived key
 *     for this fingerprint earlier this session, we can decrypt; otherwise
 *     skip.
 *   - Archived projects: same — check session.cachedArchivedFingerprints().
 *
 * Locked projects are returned in the result as "skipped" by the backup
 * function; this function silently leaves them out of the bundle list.
 */
async function collectAvailableBundles(
  session: VaultSession,
): Promise<readonly BackupBundle[]> {
  const bundles: BackupBundle[] = [];

  const collectDir = async (base: string, status: 'active' | 'archived'): Promise<void> => {
    const entries = await listVaultEntries(base);
    if (!entries.ok) return;
    for (const fingerprint of entries.value) {
      const credentials = await tryDecryptForFingerprint(session, base, fingerprint);
      if (credentials === null) continue;
      const read = await readVaultEntry(base, fingerprint);
      let displayName = fingerprint;
      if (read.ok && read.value !== null) {
        try {
          const parsed = JSON.parse(read.value.meta.toString('utf8')) as { displayName?: string };
          if (typeof parsed.displayName === 'string' && parsed.displayName.length > 0) {
            displayName = parsed.displayName;
          }
        } catch {
          // fall through with fingerprint as displayName
        }
      }
      bundles.push({ fingerprint, status, displayName, credentials });
    }
  };

  await collectDir(PROJECTS_DIR, 'active');
  await collectDir(ARCHIVE_DIR, 'archived');
  return bundles;
}

async function tryDecryptForFingerprint(
  session: VaultSession,
  base: string,
  fingerprint: string,
): Promise<readonly Credential[] | null> {
  // Case 1: the current workspace's unlocked session covers this fingerprint.
  if (session.getFingerprint() === fingerprint) {
    const cred = session.getCredentials();
    if (cred.ok) return cred.value;
  }

  // Case 2: archived-keys cache covers this fingerprint.
  const cachedKey = session.borrowArchivedKey(fingerprint);
  if (cachedKey === null) return null;

  const read = await readVaultEntry(base, fingerprint);
  if (!read.ok) return null;
  if (read.value === null || read.value.keys === null) return null;

  const peek = peekVersion(read.value.keys);
  if (!peek.ok) return null;
  if (!checkSupported(peek.value).ok) return null;
  const parsed = parseEnvelope(read.value.keys);
  if (!parsed.ok) return null;

  const decResult = decrypt(parsed.value.ciphertext, parsed.value.nonce, cachedKey);
  if (!decResult.ok) return null;

  let payload: { credentials?: unknown };
  try {
    payload = JSON.parse(decResult.value.toString('utf8')) as { credentials?: unknown };
  } catch {
    decResult.value.fill(0);
    return null;
  }
  decResult.value.fill(0);

  if (!Array.isArray(payload.credentials)) return null;
  const credentials: Credential[] = [];
  for (const c of payload.credentials) {
    if (isCredential(c)) credentials.push(c);
  }
  return credentials;
}
